import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { LedgerError } from '../core/errors.js';
import { parseStoredPayload } from '../core/json.js';
import { withLedger } from '../storage/sqlite.js';
import type { EventRow } from './events.js';
import type { SubmissionRow } from './submissions.js';
import { verifyLedgerInDatabase } from './verification.js';

export interface ExportResult {
  path: string;
  submissions: number;
  events: number;
}

/** JSON Lines includes the original payload. Treat the output as sensitive data. */
export function exportLedger(dbPath: string, outputPath: string): ExportResult {
  const output = resolve(outputPath);
  return withLedger(dbPath, (db) => {
    // A consistent read snapshot: intake may continue during verification/export.
    db.exec('BEGIN;');
    try {
      const check = verifyLedgerInDatabase(db);
      if (!check.ok) throw new LedgerError('Integrity check failed. Resolve the reported issues before exporting.');
      const lines: string[] = [JSON.stringify({
        kind: 'manifest',
        formatVersion: 1,
        exportedAt: new Date().toISOString(),
        submissions: check.submissions,
        events: check.events,
      })];
      const submissions = db.prepare('SELECT * FROM submissions ORDER BY received_at, id')
        .all() as unknown as SubmissionRow[];
      const events = db.prepare('SELECT * FROM events ORDER BY seq').all() as unknown as EventRow[];
      for (const record of submissions) {
        lines.push(JSON.stringify({
          kind: 'submission',
          id: record.id,
          source: record.source,
          idempotencyKey: record.idempotency_key,
          payload: parseStoredPayload(record.payload_json),
          payloadSha256: record.payload_sha256,
          receivedAt: record.received_at,
        }));
      }
      for (const event of events) {
        lines.push(JSON.stringify({
          kind: 'event',
          sequence: event.seq,
          id: event.id,
          submissionId: event.submission_id,
          type: event.event_type,
          data: JSON.parse(event.data_json) as unknown,
          happenedAt: event.happened_at,
          previousHash: event.previous_hash,
          hash: event.hash,
        }));
      }
      mkdirSync(dirname(output), { recursive: true });
      // 'wx' prevents accidentally overwriting an earlier export.
      writeFileSync(output, `${lines.join('\n')}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
      db.exec('COMMIT;');
      return { path: output, submissions: check.submissions, events: check.events };
    } catch (error) {
      if (db.isTransaction) db.exec('ROLLBACK;');
      throw error;
    }
  });
}
