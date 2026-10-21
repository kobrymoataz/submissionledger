import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApiServer } from '../api/server.js';
import { ledgerStats } from '../ledger/submissions.js';
import { initializeLedger } from '../storage/sqlite.js';

const TOKEN = 'integration-test-secret-0123456789-abcdef';

async function fixture(run: (base: string, dbPath: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'sl-api-intake-'));
  const dbPath = join(root, 'ledger.sqlite');
  initializeLedger(dbPath);
  const server = createApiServer({ dbPath, token: TOKEN });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Expected TCP server');
    await run(`http://127.0.0.1:${addr.port}`, dbPath);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

function post(base: string, data: unknown, key?: string) {
  return fetch(`${base}/v1/submissions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    body: JSON.stringify(data),
  });
}
function get(base: string, url: string) {
  return fetch(`${base}${url}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
}

test('a POST stores a submission and GET returns its complete payload', async () => {
  await fixture(async (base) => {
    const posted = await post(base, { source: 'website', payload: { applicant: 'Sam', score: 8 } }, 'web-001');
    assert.equal(posted.status, 201);
    const body = await posted.json() as { data: { outcome: string; submission: { id: string; payload: unknown } } };
    assert.equal(body.data.outcome, 'accepted');
    assert.deepEqual(body.data.submission.payload, { applicant: 'Sam', score: 8 });
    assert.equal(posted.headers.get('location'), `/v1/submissions/${body.data.submission.id}`);
    const retrieved = await get(base, `/v1/submissions/${body.data.submission.id}`);
    assert.equal(retrieved.status, 200);
    const record = await retrieved.json() as { data: { payload: unknown } };
    assert.deepEqual(record.data.payload, { applicant: 'Sam', score: 8 });
  });
});

test('an identical retry replays its ID; changed content conflicts without a second row', async () => {
  await fixture(async (base, dbPath) => {
    const first = await post(base, { source: 'website', payload: { x: 1, y: 2 } }, 'web-002');
    const firstRecord = await first.json() as { data: { submission: { id: string } } };
    const replay = await post(base, { source: 'website', payload: { y: 2, x: 1 } }, 'web-002');
    const replayRecord = await replay.json() as { data: { submission: { id: string }; outcome: string } };
    assert.equal(replay.status, 200);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.equal(replayRecord.data.outcome, 'replayed');
    assert.equal(replayRecord.data.submission.id, firstRecord.data.submission.id);
    const conflict = await post(base, { source: 'website', payload: { x: 3 } }, 'web-002');
    assert.equal(conflict.status, 409);
    const error = await conflict.json() as { error: { code: string } };
    assert.equal(error.error.code, 'idempotency_conflict');
    assert.equal(ledgerStats(dbPath).submissions, 1);
  });
});

test('idempotency keys are scoped to source and missing keys allow separate submissions', async () => {
  await fixture(async (base, dbPath) => {
    assert.equal((await post(base, { source: 'a', payload: { ok: true } }, 'same')).status, 201);
    assert.equal((await post(base, { source: 'b', payload: { ok: true } }, 'same')).status, 201);
    assert.equal((await post(base, { payload: { ok: true } })).status, 201);
    assert.equal((await post(base, { payload: { ok: true } })).status, 201);
    assert.equal(ledgerStats(dbPath).submissions, 4);
  });
});

test('auth is mandatory and anonymous POST cannot write to the ledger', async () => {
  await fixture(async (base, dbPath) => {
    const resp = await fetch(`${base}/v1/submissions`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"payload":{"hello":1}}' });
    assert.equal(resp.status, 401);
    assert.equal(resp.headers.get('access-control-allow-origin'), null);
    assert.equal(ledgerStats(dbPath).submissions, 0);
  });
});

test('bad JSON, unsupported media, and non-object payloads are rejected', async () => {
  await fixture(async (base, dbPath) => {
    const auth = { Authorization: `Bearer ${TOKEN}` };
    const invalid = await fetch(`${base}/v1/submissions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{' });
    assert.equal(invalid.status, 400);
    const media = await fetch(`${base}/v1/submissions`, { method: 'POST', headers: { ...auth, 'Content-Type': 'text/plain' }, body: 'hello' });
    assert.equal(media.status, 415);
    const shape = await post(base, { source: 'test', payload: [1, 2] });
    assert.equal(shape.status, 422);
    const bad = await post(base, { source: 123, payload: { ok: true } });
    assert.equal(bad.status, 422);
    const extra = await post(base, { source: 'a', payload: {}, unexpected: true });
    assert.equal(extra.status, 422);
    assert.equal(ledgerStats(dbPath).submissions, 0);
  });
});

test('lists summaries, enforces bounded limit and returns explicit errors', async () => {
  await fixture(async (base) => {
    await post(base, { source: 'website', payload: { private: 'value' } });
    await post(base, { source: 'mobile', payload: { private: 'other' } });
    const response = await get(base, '/v1/submissions?source=website&limit=1');
    assert.equal(response.status, 200);
    const list = await response.json() as { data: { items: Array<{ source: string; payload?: unknown }> } };
    assert.equal(list.data.items.length, 1);
    assert.equal(list.data.items[0]?.source, 'website');
    assert.equal('payload' in (list.data.items[0] ?? {}), false);
    assert.equal((await get(base, '/v1/submissions?limit=101')).status, 422);
    assert.equal((await get(base, '/v1/submissions?limit=1&limit=2')).status, 400);
    assert.equal((await get(base, '/v1/submissions?random=yes')).status, 400);
    assert.equal((await get(base, '/v1/submissions/not-a-uuid')).status, 400);
    assert.equal((await get(base, '/v1/submissions/00000000-0000-4000-8000-000000000000')).status, 404);
    assert.equal((await get(base, '/v1/unknown')).status, 404);
  });
});

test('unsupported methods advertise allowed methods without modifying data', async () => {
  await fixture(async (base, dbPath) => {
    const response = await fetch(`${base}/v1/submissions`, { method: 'DELETE', headers: { Authorization: `Bearer ${TOKEN}` } });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET');
    assert.equal(ledgerStats(dbPath).submissions, 0);
  });
});
