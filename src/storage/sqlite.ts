import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { InputError, LedgerError } from '../core/errors.js';

export const CURRENT_SCHEMA = 1;

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
      db.exec(`BEGIN IMMEDIATE; ${SCHEMA} PRAGMA user_version = ${CURRENT_SCHEMA}; COMMIT;`);
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
