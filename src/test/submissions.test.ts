import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { ConflictError, InputError } from '../core/errors.js';
import { MAX_PAYLOAD_BYTES } from '../core/json.js';
import { acceptSubmission, getSubmission, ledgerStats, listSubmissions } from '../ledger/submissions.js';
import { initializeLedger } from '../storage/sqlite.js';

function withTemporaryLedger(run: (path: string) => void): void {
  const folder = mkdtempSync(join(tmpdir(), 'submissionledger-'));
  const path = join(folder, 'nested', 'ledger.sqlite');
  try {
    initializeLedger(path);
    run(path);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

test('initialization creates a usable SQLite database and can run twice', () => {
  withTemporaryLedger((path) => {
    assert.equal(initializeLedger(path).created, false);
    assert.deepEqual(ledgerStats(path), {
      submissions: 0,
      events: 0,
      withIdempotencyKey: 0,
      bySource: [],
    });
  });
});

test('accepts and retrieves a submission with its original data', () => {
  withTemporaryLedger((path) => {
    const saved = acceptSubmission(path, {
      source: 'applications',
      payload: { candidate: 'Sam', year: 2026, tags: ['review'] },
    });
    assert.equal(saved.outcome, 'accepted');
    assert.equal(saved.submission.payloadSha256.length, 64);
    assert.deepEqual(getSubmission(path, saved.submission.id).payload, {
      candidate: 'Sam', year: 2026, tags: ['review'],
    });
    assert.equal(ledgerStats(path).events, 1);
  });
});

test('reusing a key with identical JSON returns the same submission without another event', () => {
  withTemporaryLedger((path) => {
    const first = acceptSubmission(path, { source: 'web', idempotencyKey: 'A-100', payload: { b: 2, a: 1 } });
    const repeat = acceptSubmission(path, { source: 'web', idempotencyKey: 'A-100', payload: { a: 1, b: 2 } });
    assert.equal(repeat.outcome, 'replayed');
    assert.equal(first.submission.id, repeat.submission.id);
    assert.equal(ledgerStats(path).submissions, 1);
    assert.equal(ledgerStats(path).events, 1);
  });
});

test('a key reused with different data is rejected without changing the database', () => {
  withTemporaryLedger((path) => {
    acceptSubmission(path, { source: 'web', idempotencyKey: 'A-100', payload: { value: 1 } });
    assert.throws(
      () => acceptSubmission(path, { source: 'web', idempotencyKey: 'A-100', payload: { value: 2 } }),
      ConflictError,
    );
    assert.equal(ledgerStats(path).submissions, 1);
    assert.equal(ledgerStats(path).events, 1);
  });
});

test('a key is scoped to its source', () => {
  withTemporaryLedger((path) => {
    const first = acceptSubmission(path, { source: 'web', idempotencyKey: 'A-100', payload: { value: 1 } });
    const second = acceptSubmission(path, { source: 'mobile', idempotencyKey: 'A-100', payload: { value: 2 } });
    assert.notEqual(first.submission.id, second.submission.id);
    assert.equal(listSubmissions(path, { source: 'mobile' }).length, 1);
  });
});

test('identical payloads without an explicit key are allowed', () => {
  withTemporaryLedger((path) => {
    const first = acceptSubmission(path, { payload: { a: 1 } });
    const second = acceptSubmission(path, { payload: { a: 1 } });
    assert.notEqual(first.submission.id, second.submission.id);
    assert.equal(ledgerStats(path).submissions, 2);
  });
});

test('list results omit payloads by default', () => {
  withTemporaryLedger((path) => {
    acceptSubmission(path, { payload: { secret: 'sensitive value' } });
    const list = listSubmissions(path);
    assert.equal(list.length, 1);
    assert.equal('payload' in (list[0] ?? {}), false);
  });
});

test('invalid input is rejected before a database write', () => {
  withTemporaryLedger((path) => {
    assert.throws(() => acceptSubmission(path, { payload: [] }), InputError);
    assert.throws(() => acceptSubmission(path, { payload: { text: 'x'.repeat(MAX_PAYLOAD_BYTES) } }), InputError);
    assert.throws(() => acceptSubmission(path, { source: 'bad source', payload: {} }), InputError);
    assert.throws(() => acceptSubmission(path, { idempotencyKey: ' space', payload: {} }), InputError);
    assert.throws(() => listSubmissions(path, { limit: 101 }), InputError);
    assert.equal(ledgerStats(path).submissions, 0);
  });
});
