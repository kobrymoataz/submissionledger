import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { ConflictError, InputError } from '../core/errors.js';
import { preparePayload, parseStoredPayload } from '../core/json.js';
import type { LedgerStats, Submission, SubmissionSummary, SubmitInput, SubmitResult } from '../core/types.js';
import { validateIdempotencyKey, validateLimit, validateSource } from '../core/validation.js';
import { withLedger } from '../storage/sqlite.js';
import { appendAcceptedEvent } from './events.js';

export interface SubmissionRow {
  id: string;
  source: string;
  idempotency_key: string | null;
  payload_json: string;
  payload_sha256: string;
  received_at: string;
}

function fromRow(row: SubmissionRow): Submission {
  return {
    id: row.id,
    source: row.source,
    idempotencyKey: row.idempotency_key,
    payload: parseStoredPayload(row.payload_json),
    payloadSha256: row.payload_sha256,
    receivedAt: row.received_at,
  };
}

function toSummary(row: SubmissionRow): SubmissionSummary {
  const { payload: _payload, ...summary } = fromRow(row);
  return summary;
}

export function acceptSubmission(path: string, input: SubmitInput): SubmitResult {
  const source = validateSource(input.source);
  const key = validateIdempotencyKey(input.idempotencyKey);
  const { payloadJson, digest } = preparePayload(input.payload);

  return withLedger(path, (db: DatabaseSync) => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      if (key !== null) {
        const existing = db.prepare(
          'SELECT * FROM submissions WHERE source = ? AND idempotency_key = ?',
        ).get(source, key) as unknown as SubmissionRow | undefined;
        if (existing !== undefined) {
          if (existing.payload_sha256 !== digest || existing.payload_json !== payloadJson) {
            throw new ConflictError(
              `Idempotency key '${key}' is already associated with a different payload in source '${source}'.`,
            );
          }
          db.exec('COMMIT;');
          return { outcome: 'replayed', submission: fromRow(existing) };
        }
      }

      const submission: Submission = {
        id: randomUUID(),
        source,
        idempotencyKey: key,
        payload: parseStoredPayload(payloadJson),
        payloadSha256: digest,
        receivedAt: new Date().toISOString(),
      };
      db.prepare(`INSERT INTO submissions
        (id, source, idempotency_key, payload_json, payload_sha256, received_at)
        VALUES (?, ?, ?, ?, ?, ?)`)
        .run(submission.id, source, key, payloadJson, digest, submission.receivedAt);
      appendAcceptedEvent(db, submission);
      db.exec('COMMIT;');
      return { outcome: 'accepted', submission };
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK;');
      throw error;
    }
  });
}

export function getSubmission(path: string, id: string): Submission {
  return withLedger(path, (db) => {
    const row = db.prepare('SELECT * FROM submissions WHERE id = ?')
      .get(id) as unknown as SubmissionRow | undefined;
    if (!row) throw new InputError(`Submission not found: ${id}`);
    return fromRow(row);
  });
}

export function listSubmissions(
  path: string,
  options: { source?: string; limit?: number } = {},
): SubmissionSummary[] {
  const limit = validateLimit(options.limit ?? 20);
  const source = options.source === undefined ? undefined : validateSource(options.source);
  return withLedger(path, (db) => {
    const rows = source === undefined
      ? db.prepare('SELECT * FROM submissions ORDER BY received_at DESC, id DESC LIMIT ?').all(limit)
      : db.prepare('SELECT * FROM submissions WHERE source = ? ORDER BY received_at DESC, id DESC LIMIT ?')
        .all(source, limit);
    return (rows as unknown as SubmissionRow[]).map(toSummary);
  });
}

export function ledgerStats(path: string): LedgerStats {
  return withLedger(path, (db) => {
    const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM submissions) AS submissions,
      (SELECT COUNT(*) FROM events) AS events,
      (SELECT COUNT(*) FROM submissions WHERE idempotency_key IS NOT NULL) AS keyed`)
      .get() as { submissions: number; events: number; keyed: number };
    const sources = db.prepare('SELECT source, COUNT(*) AS count FROM submissions GROUP BY source ORDER BY count DESC, source ASC')
      .all() as unknown as Array<{ source: string; count: number }>;
    return {
      submissions: counts.submissions,
      events: counts.events,
      withIdempotencyKey: counts.keyed,
      bySource: sources,
    };
  });
}
