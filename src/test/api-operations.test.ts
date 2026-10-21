import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { createApiServer } from '../api/server.js';
import { acceptSubmission } from '../ledger/submissions.js';
import { verifyLedger } from '../ledger/verification.js';
import { initializeLedger } from '../storage/sqlite.js';

const TOKEN = 'ops-test-secret-abcdefghijklmnopqrstuvwxyz';

async function withApi(run: (base: string, dbPath: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'sl-api-ops-'));
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
const auth = { Authorization: `Bearer ${TOKEN}` };

async function get(base: string, path: string) {
  return fetch(`${base}${path}`, { headers: auth });
}

test('pagination is deterministic, with no missing IDs or embedded payloads', async () => {
  await withApi(async (base, dbPath) => {
    for (let n = 0; n < 7; n++) acceptSubmission(dbPath, { source: n % 2 ? 'mobile' : 'web', payload: { n } });
    const ids = new Set<string>();
    for (const offset of [0, 3, 6]) {
      const response = await get(base, `/v1/submissions?limit=3&offset=${offset}`);
      assert.equal(response.status, 200);
      const body = await response.json() as { data: { items: Array<{ id: string; payload?: unknown }>; offset: number; nextOffset: number | null; hasMore: boolean } };
      assert.equal(body.data.offset, offset);
      for (const item of body.data.items) {
        assert.equal('payload' in item, false);
        ids.add(item.id);
      }
      assert.equal(body.data.hasMore, offset < 6);
      assert.equal(body.data.nextOffset, offset < 6 ? offset + 3 : null);
    }
    assert.equal(ids.size, 7);
  });
});

test('source filter is applied before pagination', async () => {
  await withApi(async (base, dbPath) => {
    for (let n = 0; n < 6; n++) acceptSubmission(dbPath, { source: n % 2 ? 'a' : 'b', payload: { n } });
    const first = await get(base, '/v1/submissions?source=a&limit=2&offset=0');
    const content = await first.json() as { data: { items: Array<{ source: string }>; hasMore: boolean; nextOffset: number | null } };
    assert.equal(content.data.items.length, 2);
    assert.ok(content.data.items.every((s) => s.source === 'a'));
    assert.equal(content.data.hasMore, true);
    assert.equal(content.data.nextOffset, 2);
  });
});

test('stats and integrity checks reflect submissions from existing CLI storage', async () => {
  await withApi(async (base, dbPath) => {
    acceptSubmission(dbPath, { source: 'cli', payload: { original: true }, idempotencyKey: 'legacy' });
    const stats = await get(base, '/v1/stats');
    assert.equal(stats.status, 200);
    const counts = await stats.json() as { data: { submissions: number; events: number; withIdempotencyKey: number } };
    assert.equal(counts.data.submissions, 1);
    assert.equal(counts.data.events, 1);
    assert.equal(counts.data.withIdempotencyKey, 1);
    const check = await get(base, '/v1/ledger/verify');
    const report = await check.json() as { data: { ok: boolean; issues: unknown[] } };
    assert.equal(check.status, 200);
    assert.equal(report.data.ok, true);
    assert.equal(report.data.issues.length, 0);
    assert.equal(verifyLedger(dbPath).ok, true);
  });
});

test('read endpoints enforce authentication and reject unsupported queries', async () => {
  await withApi(async (base) => {
    for (const endpoint of ['/v1/stats', '/v1/ledger/verify']) {
      assert.equal((await fetch(`${base}${endpoint}`)).status, 401);
      assert.equal((await get(base, `${endpoint}?unexpected=1`)).status, 400);
    }
    for (const endpoint of [
      '/v1/submissions?offset=-1', '/v1/submissions?offset=10001',
      '/v1/submissions?offset=1.1', '/v1/submissions?offset=01',
      '/v1/submissions?limit=1&offset=2&offset=3',
    ]) {
      const response = await get(base, endpoint);
      assert.ok(response.status === 400 || response.status === 422, `Unexpected status for ${endpoint}: ${response.status}`);
    }
  });
});

test('server enforces both request and normalized-payload size caps', async () => {
  await withApi(async (base) => {
    const large = await fetch(`${base}/v1/submissions`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { text: 'x'.repeat(64 * 1024 + 8) } }),
    });
    assert.equal(large.status, 422);
    const oversized = await fetch(`${base}/v1/submissions`, {
      method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ payload: { text: 'x'.repeat(100 * 1024) } }),
    });
    assert.equal(oversized.status, 413);
  });
});

test('replay of a CLI-created submission works through HTTP without a schema change', async () => {
  await withApi(async (base, dbPath) => {
    const original = acceptSubmission(dbPath, { source: 'website', payload: { a: 1, b: 2 }, idempotencyKey: 'same-transaction' });
    const replay = await fetch(`${base}/v1/submissions`, {
      method: 'POST', headers: { ...auth, 'Idempotency-Key': 'same-transaction', 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'website', payload: { b: 2, a: 1 } }),
    });
    const response = await replay.json() as { data: { outcome: string; submission: { id: string } } };
    assert.equal(replay.status, 200);
    assert.equal(response.data.submission.id, original.submission.id);
    assert.equal(response.data.outcome, 'replayed');
    assert.equal(verifyLedger(dbPath).ok, true);
  });
});
