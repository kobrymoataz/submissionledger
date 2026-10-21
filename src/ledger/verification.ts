import { canonicalJson, sha256 } from '../core/json.js';
import type { DatabaseSync } from 'node:sqlite';
import type { JsonObject } from '../core/types.js';
import { withLedger } from '../storage/sqlite.js';
import { eventDigest } from './events.js';
import type { EventRow } from './events.js';
import type { SubmissionRow } from './submissions.js';

export interface IntegrityIssue {
  code: string;
  detail: string;
}

export interface VerificationResult {
  ok: boolean;
  submissions: number;
  events: number;
  issues: IntegrityIssue[];
}

/** Detect accidental edits, missing events and broken links in the local ledger. */
export function verifyLedger(path: string): VerificationResult {
  return withLedger(path, (db) => {
    db.exec('BEGIN;');
    try {
      const result = verifyLedgerInDatabase(db);
      db.exec('COMMIT;');
      return result;
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK;');
      throw error;
    }
  });
}

export function verifyLedgerInDatabase(db: DatabaseSync): VerificationResult {
    const issues: IntegrityIssue[] = [];
    const issue = (code: string, detail: string): void => {
      if (issues.length < 100) issues.push({ code, detail });
    };
    const integrity = db.prepare('PRAGMA integrity_check').all() as unknown as Array<{ integrity_check: string }>;
    for (const row of integrity) {
      if (row.integrity_check !== 'ok') issue('sqlite_integrity', row.integrity_check);
    }
    const foreignKeys = db.prepare('PRAGMA foreign_key_check').all();
    if (foreignKeys.length > 0) issue('foreign_key', `${foreignKeys.length} broken foreign key references.`);

    const submissions = db.prepare('SELECT * FROM submissions ORDER BY id').all() as unknown as SubmissionRow[];
    const events = db.prepare('SELECT * FROM events ORDER BY seq').all() as unknown as EventRow[];
    const byId = new Map(submissions.map((row) => [row.id, row]));
    const acceptedCount = new Map<string, number>();
    let previousHash: string | null = null;

    for (const row of submissions) {
      if (sha256(row.payload_json) !== row.payload_sha256) {
        issue('payload_hash', `Submission ${row.id} has a mismatched payload SHA-256.`);
      }
      try {
        const payload = JSON.parse(row.payload_json) as unknown;
        if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
          issue('payload_shape', `Submission ${row.id} does not hold a JSON object.`);
        } else if (canonicalJson(payload) !== row.payload_json) {
          issue('payload_format', `Submission ${row.id} has noncanonical JSON.`);
        }
      } catch {
        issue('payload_json', `Submission ${row.id} contains invalid JSON.`);
      }
    }

    for (const event of events) {
      if (event.previous_hash !== previousHash) {
        issue('event_chain', `Event ${event.seq} does not link to the previous event.`);
      }
      if (eventDigest(event) !== event.hash) {
        issue('event_hash', `Event ${event.seq} has a mismatched hash.`);
      }
      previousHash = event.hash;
      if (event.event_type !== 'submission.accepted') {
        issue('event_type', `Event ${event.seq} has an unknown event type.`);
        continue;
      }
      const submission = byId.get(event.submission_id);
      if (!submission) {
        issue('event_orphan', `Event ${event.seq} references a missing submission.`);
        continue;
      }
      acceptedCount.set(event.submission_id, (acceptedCount.get(event.submission_id) ?? 0) + 1);
      try {
        const metadata = JSON.parse(event.data_json) as JsonObject;
        if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
          issue('event_data', `Event ${event.seq} has invalid metadata.`);
        } else if (
          metadata.payloadSha256 !== submission.payload_sha256 ||
          metadata.source !== submission.source ||
          metadata.idempotencyKey !== submission.idempotency_key ||
          canonicalJson(metadata) !== event.data_json
        ) {
          issue('event_data', `Event ${event.seq} does not match its submission.`);
        }
      } catch {
        issue('event_data', `Event ${event.seq} has malformed JSON metadata.`);
      }
    }
    for (const submission of submissions) {
      if (acceptedCount.get(submission.id) !== 1) {
        issue('event_count', `Submission ${submission.id} must have exactly one acceptance event.`);
      }
    }
    return { ok: issues.length === 0, submissions: submissions.length, events: events.length, issues };
}
