import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InputError, LedgerError } from '../core/errors.js';

export const CURRENT_SCHEMA = 2;

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS submissions (
    id TEXT PRIMARY KEY NOT NULL,
    source TEXT NOT NULL,
    idempotency_key TEXT,
    payload_json TEXT NOT NULL,
    payload_sha256 TEXT NOT NULL,
    received_at TEXT NOT NULL,
    UNIQUE (source, idempotency_key)
  );
  CREATE INDEX IF NOT EXISTS idx_submissions_date ON submissions(received_at DESC, id DESC);
  CREATE INDEX IF NOT EXISTS idx_submissions_source ON submissions(source, received_at DESC);

  CREATE TABLE IF NOT EXISTS events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    submission_id TEXT NOT NULL REFERENCES submissions(id),
    event_type TEXT NOT NULL,
    data_json TEXT NOT NULL,
    happened_at TEXT NOT NULL,
    previous_hash TEXT,
    hash TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_events_submission ON events(submission_id, seq);
`;

const DELIVERY_SCHEMA = `
  CREATE TABLE IF NOT EXISTS delivery_outbox (
    id TEXT PRIMARY KEY NOT NULL,
    submission_id TEXT NOT NULL REFERENCES submissions(id),
    destination TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'leased', 'retry', 'delivered', 'dead')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 5 CHECK(max_attempts BETWEEN 1 AND 20),
    next_attempt_at TEXT NOT NULL,
    lease_token TEXT,
    leased_until TEXT,
    created_at TEXT NOT NULL,
    delivered_at TEXT,
    last_http_status INTEGER,
    last_error_code TEXT,
    UNIQUE (submission_id, destination)
  );
  CREATE INDEX IF NOT EXISTS idx_outbox_due ON delivery_outbox(status, next_attempt_at);
  CREATE INDEX IF NOT EXISTS idx_outbox_lease ON delivery_outbox(status, leased_until);
  CREATE INDEX IF NOT EXISTS idx_outbox_submission ON delivery_outbox(submission_id, created_at);

  CREATE TABLE IF NOT EXISTS delivery_attempts (
    id TEXT PRIMARY KEY NOT NULL,
    delivery_id TEXT NOT NULL REFERENCES delivery_outbox(id),
    attempt_number INTEGER NOT NULL,
    started_at TEXT NOT NULL,
    finished_at TEXT,
    outcome TEXT NOT NULL CHECK(outcome IN ('in_flight', 'delivered', 'retry', 'dead', 'abandoned')),
    http_status INTEGER,
    error_code TEXT,
    UNIQUE(delivery_id, attempt_number)
  );
  CREATE INDEX IF NOT EXISTS idx_delivery_attempts ON delivery_attempts(delivery_id, attempt_number);
`;

function configure(db: DatabaseSync): void {
  db.exec('PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
}

function getVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

export function absoluteDatabasePath(path: string): string {
  if (!path.trim()) throw new InputError('Database path cannot be blank.');
  return resolve(path);
}

export function initializeLedger(path: string): { path: string; created: boolean } {
  const location = absoluteDatabasePath(path);
  const existed = existsSync(location);
  const originalSize = existed ? statSync(location).size : 0;
  mkdirSync(dirname(location), { recursive: true });
  const db = new DatabaseSync(location);
  try {
    configure(db);
    const version = getVersion(db);
    if (version > CURRENT_SCHEMA) {
      throw new LedgerError(`Ledger schema ${version} is newer than this release (schema ${CURRENT_SCHEMA}).`);
    }
    if (version === 0 && existed && originalSize > 0) {
      throw new LedgerError('The existing SQLite file is not a SubmissionLedger database.');
    }
    if (version === 0) {
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.exec(SCHEMA);
        db.exec("ALTER TABLE submissions ADD COLUMN delivery_spec_json TEXT NOT NULL DEFAULT '[]';");
        db.exec(DELIVERY_SCHEMA);
        db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA};`);
        db.exec('COMMIT;');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK;');
        throw error;
      }
    }
    if (version === 1) {
      // Adding delivery tables does not alter the existing submissions or event hashes.
      db.exec('BEGIN IMMEDIATE;');
      try {
        db.exec("ALTER TABLE submissions ADD COLUMN delivery_spec_json TEXT NOT NULL DEFAULT '[]';");
        db.exec(DELIVERY_SCHEMA);
        db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA};`);
        db.exec('COMMIT;');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK;');
        throw error;
      }
    }
    db.exec('PRAGMA journal_mode = WAL;');
    return { path: location, created: !existed || version === 0 };
  } finally {
    db.close();
  }
}

export function withLedger<T>(path: string, run: (db: DatabaseSync) => T): T {
  const location = absoluteDatabasePath(path);
  if (!existsSync(location)) {
    throw new InputError(`Ledger not found: ${location}. Run 'submissionledger init' first.`);
  }
  const db = new DatabaseSync(location);
  try {
    configure(db);
    const version = getVersion(db);
    if (version !== CURRENT_SCHEMA) {
      throw new LedgerError(`Unsupported database schema ${version}. Expected ${CURRENT_SCHEMA}.`);
    }
    return run(db);
  } finally {
    db.close();
  }
}
