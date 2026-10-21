import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ConflictError, InputError } from '../core/errors.js';
import { acceptSubmission, ledgerStats } from '../ledger/submissions.js';
import { deliveryStats, pageDeliveries, queueSubmissionDelivery } from '../ledger/delivery.js';
import { verifyLedger } from '../ledger/verification.js';
import { CURRENT_SCHEMA, initializeLedger } from '../storage/sqlite.js';

function withTemp(run: (path: string) => void): void {
  const folder = mkdtempSync(join(tmpdir(), 'sl-delivery-'));
  try {
    const path = join(folder, 'ledger.sqlite');
    initializeLedger(path);
    run(path);
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test('creates v2 schema and queues deliveries atomically with acceptance', () => withTemp((path) => {
  const saved = acceptSubmission(path, { source: 'web', idempotencyKey: 'one',
    payload: { id: 100 }, destinations: ['audit', 'secondary'] });
  assert.equal(saved.outcome, 'accepted');
  assert.equal(pageDeliveries(path).total, 2);
  assert.equal(deliveryStats(path).pending, 2);
  assert.equal(ledgerStats(path).events, 1);
  assert.equal(verifyLedger(path).ok, true);
  const replay = acceptSubmission(path, { source: 'web', idempotencyKey: 'one',
    payload: { id: 100 }, destinations: ['secondary', 'audit'] });
  assert.equal(replay.outcome, 'replayed');
  assert.equal(pageDeliveries(path).total, 2);
}));

test('cannot change delivery destinations on replay or queue invalid destinations', () => withTemp((path) => {
  acceptSubmission(path, { payload: { x: 1 }, source: 'web', idempotencyKey: 'x', destinations: ['audit'] });
  assert.throws(() => acceptSubmission(path, { payload: { x: 1 }, source: 'web', idempotencyKey: 'x' }), ConflictError);
  assert.throws(() => acceptSubmission(path, { payload: { y: 1 }, destinations: ['bad/name'] }), InputError);
  assert.equal(ledgerStats(path).submissions, 1);
  assert.equal(pageDeliveries(path).total, 1);
}));

test('manual enqueue is idempotent, missing submission does not create a job', () => withTemp((path) => {
  const s = acceptSubmission(path, { payload: { x: 2 } });
  const first = queueSubmissionDelivery(path, s.submission.id, 'audit');
  const again = queueSubmissionDelivery(path, s.submission.id, 'audit');
  assert.equal(first.created, true);
  assert.equal(again.created, false);
  assert.equal(first.delivery.id, again.delivery.id);
  assert.throws(() => queueSubmissionDelivery(path, 'unknown', 'audit'), InputError);
  assert.equal(pageDeliveries(path).total, 1);
}));

test('migration from v1 retains original submissions and hash chain', () => withTemp((path) => {
  acceptSubmission(path, { payload: { legacy: true }, idempotencyKey: 'legacy' });
  const before = verifyLedger(path);
  const db = new DatabaseSync(path);
  db.exec('DROP TABLE delivery_attempts; DROP TABLE delivery_outbox; ALTER TABLE submissions DROP COLUMN delivery_spec_json; PRAGMA user_version = 1;');
  db.close();
  assert.equal(initializeLedger(path).created, false);
  const migrated = new DatabaseSync(path);
  assert.equal((migrated.prepare('PRAGMA user_version').get() as { user_version: number }).user_version, CURRENT_SCHEMA);
  migrated.close();
  assert.equal(verifyLedger(path).ok, true);
  assert.deepEqual(verifyLedger(path), before);
  assert.equal(ledgerStats(path).submissions, 1);
  assert.equal(pageDeliveries(path).total, 0);
}));

test('manual queue after acceptance does not change the original idempotency contract', () => withTemp((path) => {
  const input = { source: 'portal', idempotencyKey: 'existing-1', payload: { order: 3 } };
  const original = acceptSubmission(path, input);
  queueSubmissionDelivery(path, original.submission.id, 'audit');
  const replay = acceptSubmission(path, input);
  assert.equal(replay.outcome, 'replayed');
  assert.equal(replay.submission.id, original.submission.id);
  assert.equal(pageDeliveries(path).total, 1);
}));
