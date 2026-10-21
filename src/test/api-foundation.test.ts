import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { createApiServer } from '../api/server.js';
import { initializeLedger } from '../storage/sqlite.js';

const TOKEN = 'api-test-secret-0123456789-abcdef';

async function serverFixture(run: (url: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'submissionledger-http-'));
  const dbPath = join(root, 'ledger.sqlite');
  initializeLedger(dbPath);
  const server = createApiServer({ dbPath, token: TOKEN });
  try {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP server.');
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
}

test('health is public and response includes a generated request ID', async () => {
  await serverFixture(async (url) => {
    const response = await fetch(`${url}/health`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const body = await response.json() as { data: { version: string }; requestId: string };
    assert.equal(body.data.version, '0.3.0');
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    assert.equal(response.headers.get('x-request-id'), body.requestId);
  });
});

test('private routes require the exact token', async () => {
  await serverFixture(async (url) => {
    assert.equal((await fetch(`${url}/v1/submissions`)).status, 401);
    assert.equal((await fetch(`${url}/v1/submissions`, { headers: { Authorization: 'Bearer wrong-token' } })).status, 401);
    assert.equal((await fetch(`${url}/v1/submissions`, { headers: { Authorization: `Bearer ${TOKEN}` } })).status, 200);
  });
});

test('startup refuses missing or weak credentials', () => {
  const root = mkdtempSync(join(tmpdir(), 'submissionledger-token-'));
  try {
    const dbPath = join(root, 'ledger.sqlite');
    initializeLedger(dbPath);
    assert.throws(() => createApiServer({ dbPath, token: 'weak' }), /24 characters/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('server refuses to start when ledger has not been initialized', () => {
  assert.throws(() => createApiServer({ dbPath: join(tmpdir(), 'missing-ledger-v02', 'none.sqlite'), token: TOKEN }), /Run 'submissionledger init'/);
});
