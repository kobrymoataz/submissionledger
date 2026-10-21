import { randomUUID } from 'node:crypto';
import { InputError, LedgerError } from '../core/errors.js';
import { withLedger } from '../storage/sqlite.js';

interface QueuedRow {
  id: string;
  submission_id: string;
  destination: string;
  status: string;
  attempts: number;
  max_attempts: number;
  lease_token: string | null;
}

export interface ClaimedDelivery {
  id: string;
  submissionId: string;
  destination: string;
  attempt: number;
  leaseToken: string;
}

export type DispatchResult =
  | { kind: 'success'; httpStatus: number }
  | { kind: 'failure'; httpStatus: number | null; errorCode: string; retryable: boolean; retryAfterSeconds?: number };

function iso(time: Date): string { return time.toISOString(); }

export function claimDueDelivery(
  path: string, destinations: string[], options: { now?: Date; leaseMs?: number } = {},
): ClaimedDelivery | null {
  if (destinations.length === 0) return null;
  const leaseMs = options.leaseMs ?? 30_000;
  if (!Number.isInteger(leaseMs) || leaseMs < 5_000 || leaseMs > 600_000) {
    throw new InputError('leaseMs must be between 5000 and 600000.');
  }
  const now = options.now ?? new Date();
  const current = iso(now);
  const expires = iso(new Date(now.getTime() + leaseMs));
  return withLedger(path, (db) => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const placeholders = destinations.map(() => '?').join(', ');
      const stmt = db.prepare(`SELECT * FROM delivery_outbox
        WHERE destination IN (${placeholders})
          AND ((status IN ('pending','retry') AND next_attempt_at <= ?)
            OR (status = 'leased' AND leased_until <= ?))
        ORDER BY CASE WHEN status = 'leased' THEN leased_until ELSE next_attempt_at END, created_at, id
        LIMIT 1`);
      while (true) {
        const job = stmt.get(...destinations, current, current) as unknown as QueuedRow | undefined;
        if (!job) {
          db.exec('COMMIT;');
          return null;
        }
        if (job.status === 'leased') {
          db.prepare(`UPDATE delivery_attempts SET finished_at = ?, outcome = 'abandoned', error_code = 'lease_expired'
            WHERE delivery_id = ? AND attempt_number = ? AND outcome = 'in_flight'`)
            .run(current, job.id, job.attempts);
          if (job.attempts >= job.max_attempts) {
            db.prepare(`UPDATE delivery_outbox SET status = 'dead', lease_token = NULL, leased_until = NULL,
              last_error_code = 'lease_expired' WHERE id = ?`).run(job.id);
            continue;
          }
        }
        const token = randomUUID();
        const attempt = job.attempts + 1;
        db.prepare(`UPDATE delivery_outbox SET status = 'leased', attempts = ?, lease_token = ?, leased_until = ?,
          last_error_code = NULL WHERE id = ?`).run(attempt, token, expires, job.id);
        db.prepare(`INSERT INTO delivery_attempts (id, delivery_id, attempt_number, started_at, outcome)
          VALUES (?, ?, ?, ?, 'in_flight')`).run(randomUUID(), job.id, attempt, current);
        db.exec('COMMIT;');
        return { id: job.id, submissionId: job.submission_id, destination: job.destination,
          attempt, leaseToken: token };
      }
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK;');
      throw error;
    }
  });
}

export function retryBackoffMs(attempt: number): number {
  if (!Number.isInteger(attempt) || attempt < 1) throw new InputError('Invalid attempt number.');
  return Math.min(15 * 60_000, 5_000 * 2 ** Math.min(attempt - 1, 15));
}

// A stale worker cannot complete an attempt once its lease has been replaced.
export function finishDelivery(
  path: string, claimed: ClaimedDelivery, result: DispatchResult, now: Date = new Date(),
): { applied: boolean; status?: 'delivered' | 'retry' | 'dead' } {
  return withLedger(path, (db) => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const job = db.prepare('SELECT * FROM delivery_outbox WHERE id = ?')
        .get(claimed.id) as unknown as QueuedRow | undefined;
      if (!job || job.lease_token !== claimed.leaseToken || job.status !== 'leased' || job.attempts !== claimed.attempt) {
        db.exec('COMMIT;');
        return { applied: false };
      }
      if (result.kind === 'success') {
        db.prepare(`UPDATE delivery_outbox SET status = 'delivered', leased_until = NULL,
          lease_token = NULL, delivered_at = ?, last_http_status = ?, last_error_code = NULL WHERE id = ?`)
          .run(iso(now), result.httpStatus, claimed.id);
        db.prepare(`UPDATE delivery_attempts SET finished_at = ?, outcome = 'delivered', http_status = ?
          WHERE delivery_id = ? AND attempt_number = ?`)
          .run(iso(now), result.httpStatus, claimed.id, claimed.attempt);
        db.exec('COMMIT;');
        return { applied: true, status: 'delivered' };
      }
      if (!/^[a-z0-9_]{2,40}$/.test(result.errorCode)) throw new LedgerError('Invalid dispatch error code.');
      const retry = result.retryable && job.attempts < job.max_attempts;
      const status = retry ? 'retry' : 'dead';
      const requestedDelay = result.retryAfterSeconds === undefined ? 0 :
        Math.min(3_600_000, Math.max(0, Math.floor(result.retryAfterSeconds * 1000)));
      const nextAt = iso(new Date(now.getTime() + Math.max(retryBackoffMs(job.attempts), requestedDelay)));
      db.prepare(`UPDATE delivery_outbox SET status = ?, next_attempt_at = ?, leased_until = NULL,
        lease_token = NULL, last_http_status = ?, last_error_code = ? WHERE id = ?`)
        .run(status, nextAt, result.httpStatus, result.errorCode, claimed.id);
      db.prepare(`UPDATE delivery_attempts SET finished_at = ?, outcome = ?, http_status = ?, error_code = ?
        WHERE delivery_id = ? AND attempt_number = ?`)
        .run(iso(now), status, result.httpStatus, result.errorCode, claimed.id, claimed.attempt);
      db.exec('COMMIT;');
      return { applied: true, status };
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK;');
      throw error;
    }
  });
}
