import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256 } from '../core/json.js';

export interface EventRow {
  seq: number;
  id: string;
  submission_id: string;
  event_type: string;
  data_json: string;
  happened_at: string;
  previous_hash: string | null;
  hash: string;
}

export function eventDigest(event: Omit<EventRow, 'seq' | 'hash'>): string {
  return sha256(canonicalJson({
    version: 1,
    id: event.id,
    submissionId: event.submission_id,
    type: event.event_type,
    data: event.data_json,
    at: event.happened_at,
    previous: event.previous_hash,
  }));
}

export function appendAcceptedEvent(
  db: DatabaseSync,
  submission: { id: string; source: string; idempotencyKey: string | null; payloadSha256: string },
): void {
  const previous = db.prepare('SELECT hash FROM events ORDER BY seq DESC LIMIT 1')
    .get() as { hash: string } | undefined;
  const event = {
    id: randomUUID(),
    submission_id: submission.id,
    event_type: 'submission.accepted',
    data_json: canonicalJson({
      source: submission.source,
      idempotencyKey: submission.idempotencyKey,
      payloadSha256: submission.payloadSha256,
    }),
    happened_at: new Date().toISOString(),
    previous_hash: previous?.hash ?? null,
  };
  db.prepare(`INSERT INTO events
    (id, submission_id, event_type, data_json, happened_at, previous_hash, hash)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(event.id, event.submission_id, event.event_type, event.data_json,
      event.happened_at, event.previous_hash, eventDigest(event));
}
