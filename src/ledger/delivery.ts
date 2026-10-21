import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { InputError, LedgerError } from '../core/errors.js';
import { withLedger } from '../storage/sqlite.js';

export type DeliveryStatus = 'pending' | 'leased' | 'retry' | 'delivered' | 'dead';
export type AttemptOutcome = 'in_flight' | 'delivered' | 'retry' | 'dead' | 'abandoned';

export interface Delivery {
  id: string;
  submissionId: string;
  destination: string;
  status: DeliveryStatus;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: string;
  leasedUntil: string | null;
  createdAt: string;
  deliveredAt: string | null;
  lastHttpStatus: number | null;
  lastErrorCode: string | null;
}

export interface DeliveryAttempt {
  id: string;
  deliveryId: string;
  attemptNumber: number;
  startedAt: string;
  finishedAt: string | null;
  outcome: AttemptOutcome;
  httpStatus: number | null;
  errorCode: string | null;
}

interface DeliveryRow {
  id: string;
  submission_id: string;
  destination: string;
  status: DeliveryStatus;
  attempts: number;
  max_attempts: number;
  next_attempt_at: string;
  lease_token: string | null;
  leased_until: string | null;
  created_at: string;
  delivered_at: string | null;
  last_http_status: number | null;
  last_error_code: string | null;
}

interface AttemptRow {
  id: string;
  delivery_id: string;
  attempt_number: number;
  started_at: string;
  finished_at: string | null;
  outcome: AttemptOutcome;
  http_status: number | null;
  error_code: string | null;
}

function fromRow(row: DeliveryRow): Delivery {
  return {
    id: row.id, submissionId: row.submission_id, destination: row.destination,
    status: row.status, attempts: row.attempts, maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at, leasedUntil: row.leased_until,
    createdAt: row.created_at, deliveredAt: row.delivered_at,
    lastHttpStatus: row.last_http_status, lastErrorCode: row.last_error_code,
  };
}
function fromAttempt(row: AttemptRow): DeliveryAttempt {
  return {
    id: row.id, deliveryId: row.delivery_id, attemptNumber: row.attempt_number,
    startedAt: row.started_at, finishedAt: row.finished_at, outcome: row.outcome,
    httpStatus: row.http_status, errorCode: row.error_code,
  };
}

export function validateDestination(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z][a-z0-9_-]{1,63}$/.test(value)) {
    throw new InputError('Destination must be 2-64 lowercase characters, starting with a letter.');
  }
  return value;
}

export function validateDestinations(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 8) {
    throw new InputError('destinations must be an array with at most 8 names.');
  }
  const names = value.map(validateDestination);
  if (new Set(names).size !== names.length) throw new InputError('Duplicate delivery destination.');
  return names.sort();
}

export function deliveryDestinationsForSubmission(db: DatabaseSync, submissionId: string): string[] {
  const rows = db.prepare('SELECT destination FROM delivery_outbox WHERE submission_id = ? ORDER BY destination')
    .all(submissionId) as unknown as Array<{ destination: string }>;
  return rows.map((row) => row.destination);
}

export function enqueueDeliveryInTransaction(
  db: DatabaseSync, submissionId: string, destination: string,
  options: { now?: string; maxAttempts?: number } = {},
): { delivery: Delivery; created: boolean } {
  const name = validateDestination(destination);
  const maxAttempts = options.maxAttempts ?? 5;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 20) {
    throw new InputError('maxAttempts must be between 1 and 20.');
  }
  const now = options.now ?? new Date().toISOString();
  const existing = db.prepare('SELECT * FROM delivery_outbox WHERE submission_id = ? AND destination = ?')
    .get(submissionId, name) as unknown as DeliveryRow | undefined;
  if (existing) return { delivery: fromRow(existing), created: false };
  const result = db.prepare(`INSERT INTO delivery_outbox
    (id, submission_id, destination, next_attempt_at, created_at, max_attempts)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .run(randomUUID(), submissionId, name, now, now, maxAttempts);
  if (result.changes !== 1) throw new LedgerError('Could not queue the delivery.');
  const row = db.prepare('SELECT * FROM delivery_outbox WHERE submission_id = ? AND destination = ?')
    .get(submissionId, name) as unknown as DeliveryRow;
  return { delivery: fromRow(row), created: true };
}

export function queueSubmissionDelivery(
  path: string, submissionId: string, destination: string,
): { delivery: Delivery; created: boolean } {
  validateDestination(destination);
  return withLedger(path, (db) => {
    db.exec('BEGIN IMMEDIATE;');
    try {
      const exists = db.prepare('SELECT 1 AS found FROM submissions WHERE id = ?').get(submissionId);
      if (!exists) throw new InputError('Submission not found.');
      const result = enqueueDeliveryInTransaction(db, submissionId, destination);
      db.exec('COMMIT;');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK;');
      throw error;
    }
  });
}

export function getDelivery(path: string, deliveryId: string): Delivery | null {
  return withLedger(path, (db) => {
    const row = db.prepare('SELECT * FROM delivery_outbox WHERE id = ?')
      .get(deliveryId) as unknown as DeliveryRow | undefined;
    return row ? fromRow(row) : null;
  });
}

export function listDeliveryAttempts(path: string, id: string): DeliveryAttempt[] {
  return withLedger(path, (db) => (db.prepare(
    'SELECT * FROM delivery_attempts WHERE delivery_id = ? ORDER BY attempt_number',
  ).all(id) as unknown as AttemptRow[]).map(fromAttempt));
}

export function pageDeliveries(
  path: string, options: { status?: DeliveryStatus; limit?: number; offset?: number } = {},
): { items: Delivery[]; total: number; hasMore: boolean; nextOffset: number | null } {
  const limit = options.limit ?? 20;
  const offset = options.offset ?? 0;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new InputError('Limit must be from 1 to 100.');
  if (!Number.isInteger(offset) || offset < 0 || offset > 10000) throw new InputError('Offset must be from 0 to 10000.');
  if (options.status !== undefined && !['pending', 'leased', 'retry', 'delivered', 'dead'].includes(options.status)) {
    throw new InputError('Invalid delivery status.');
  }
  return withLedger(path, (db) => {
    const where = options.status === undefined ? '' : ' WHERE status = ?';
    const values = options.status === undefined ? [] : [options.status];
    const total = (db.prepare(`SELECT COUNT(*) AS n FROM delivery_outbox${where}`)
      .get(...values) as { n: number }).n;
    const rows = db.prepare(`SELECT * FROM delivery_outbox${where} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as unknown as DeliveryRow[];
    return { items: rows.map(fromRow), total, hasMore: offset + rows.length < total,
      nextOffset: offset + rows.length < total ? offset + rows.length : null };
  });
}

export function deliveryStats(path: string): Record<DeliveryStatus, number> {
  return withLedger(path, (db) => {
    const stats: Record<DeliveryStatus, number> = { pending: 0, leased: 0, retry: 0, delivered: 0, dead: 0 };
    const rows = db.prepare('SELECT status, COUNT(*) AS count FROM delivery_outbox GROUP BY status')
      .all() as unknown as Array<{ status: DeliveryStatus; count: number }>;
    for (const row of rows) stats[row.status] = row.count;
    return stats;
  });
}
