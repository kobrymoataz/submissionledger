import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createApiServer } from '../api/server.js';
import { pageDeliveries } from '../ledger/delivery.js';
import { ledgerStats } from '../ledger/submissions.js';
import { initializeLedger } from '../storage/sqlite.js';
import { parseWebhookConfig } from '../worker/config.js';
import { runDeliveryBatch } from '../worker/runner.js';

const token = 'test-local-bearer-token-is-long-enough';
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function withApi(run: (base: string, path: string) => Promise<void>, configured = true): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'sl-http-delivery-'));
  const path = join(folder, 'ledger.sqlite'); initializeLedger(path);
  const config = configured ? parseWebhookConfig({ destinations: {
    audit: { url: 'https://example.com/webhook', secretEnv: 'SL_AUDIT_SIGNING_SECRET' },
  } }) : undefined;
  const server = createApiServer({ dbPath: path, token, ...(config ? { deliveryConfig: config } : {}) });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${(server.address() as AddressInfo).port}`, path); }
  finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(folder, { recursive: true, force: true });
  }
}

async function api(base: string, endpoint: string, method = 'GET', body?: unknown, headers: Record<string, string> = auth): Promise<Response> {
  return fetch(base + endpoint, { method, headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

test('API queues configured destinations atomically and idempotently on intake', async () => withApi(async (base, path) => {
  const input = { source: 'web', payload: { reference: 'R1' }, destinations: ['audit'] };
  const first = await api(base, '/v1/submissions', 'POST', input, { ...auth, 'Idempotency-Key': 'form-001' });
  assert.equal(first.status, 201);
  const received = await first.json() as { data: { submission: { id: string } } };
  assert.equal(pageDeliveries(path).total, 1);
  const again = await api(base, '/v1/submissions', 'POST', input, { ...auth, 'Idempotency-Key': 'form-001' });
  assert.equal(again.status, 200);
  assert.equal((await api(base, '/v1/deliveries/stats')).status, 200);
  assert.equal((await api(base, '/v1/deliveries?status=pending&limit=2')).status, 200);
  const all = await api(base, '/v1/deliveries');
  const page = await all.json() as { data: { items: Array<{ id: string; status: string }> } };
  assert.equal(page.data.items.length, 1);
  const detail = await api(base, `/v1/deliveries/${page.data.items[0]?.id}`);
  const detailBody = await detail.json() as { data: { attempts: unknown[] } };
  assert.equal(detailBody.data.attempts.length, 0);
  assert.equal(ledgerStats(path).submissions, 1);
  const conflict = await api(base, '/v1/submissions', 'POST', { source: 'web', payload: { reference: 'R1' } },
    { ...auth, 'Idempotency-Key': 'form-001' });
  assert.equal(conflict.status, 409);
  assert.ok(received.data.submission.id);
}));

test('API rejects arbitrary/unconfigured destinations before writing the submission', async () => withApi(async (base, path) => {
  const forbidden = await api(base, '/v1/submissions', 'POST', { payload: { x: 1 }, destinations: ['unconfigured'] });
  assert.equal(forbidden.status, 422);
  const invalid = await api(base, '/v1/submissions', 'POST', { payload: { x: 1 }, destinations: 'audit' });
  assert.equal(invalid.status, 422);
  assert.equal(ledgerStats(path).submissions, 0);
  assert.equal((await fetch(base + '/v1/deliveries')).status, 401);
  assert.equal((await api(base, '/v1/deliveries?offset=-1')).status, 400);
  assert.equal((await api(base, '/v1/deliveries/stats?unexpected=1')).status, 400);
}));

test('enqueue existing submission via API returns 201 then 200 without duplication', async () => withApi(async (base, path) => {
  const created = await api(base, '/v1/submissions', 'POST', { payload: { legacy: true } });
  assert.equal(created.status, 201);
  const incoming = await created.json() as { data: { submission: { id: string } } };
  const id = incoming.data.submission.id;
  const first = await api(base, `/v1/submissions/${id}/deliveries`, 'POST', { destination: 'audit' });
  const again = await api(base, `/v1/submissions/${id}/deliveries`, 'POST', { destination: 'audit' });
  assert.equal(first.status, 201); assert.equal(again.status, 200);
  assert.equal(pageDeliveries(path).total, 1);
  assert.equal((await api(base, `/v1/submissions/${id}/deliveries`, 'POST', { destination: 'unknown' })).status, 422);
  assert.equal((await api(base, '/v1/submissions/10000000-0000-4000-8000-000000000000/deliveries', 'POST', { destination: 'audit' })).status, 404);
}));

test('API continues accepting and reading submissions without any webhook configuration', async () => withApi(async (base, path) => {
  assert.equal((await api(base, '/v1/submissions', 'POST', { payload: { x: 1 } })).status, 201);
  assert.equal((await api(base, '/v1/submissions', 'POST', { payload: { x: 1 }, destinations: ['audit'] })).status, 422);
  assert.equal(pageDeliveries(path).total, 0);
}, false));

test('queued submission reaches local signed webhook through a worker', async () => {
  const folder = mkdtempSync(join(tmpdir(), 'sl-live-http-'));
  const path = join(folder, 'ledger.sqlite'); initializeLedger(path);
  let received = 0;
  const receiver = createHttpServer(async (req, res) => {
    let body = ''; for await (const chunk of req) body += chunk.toString();
    const payload = JSON.parse(body) as { event: string };
    assert.equal(payload.event, 'submission.accepted');
    received += 1; res.writeHead(204); res.end();
  });
  await new Promise<void>((resolve) => receiver.listen(0, '127.0.0.1', resolve));
  const receiverPort = (receiver.address() as AddressInfo).port;
  const config = parseWebhookConfig({ destinations: {
    audit: { url: `http://127.0.0.1:${receiverPort}/hook`, secretEnv: 'SL_AUDIT_SIGNING_SECRET' },
  } }, true);
  const apiServer = createApiServer({ dbPath: path, token, deliveryConfig: config });
  await new Promise<void>((resolve) => apiServer.listen(0, '127.0.0.1', resolve));
  try {
    const base = `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`;
    assert.equal((await api(base, '/v1/submissions', 'POST', { payload: { n: 1 }, destinations: ['audit'] })).status, 201);
    const result = await runDeliveryBatch({ dbPath: path, config,
      env: { SL_AUDIT_SIGNING_SECRET: 'valid-signing-key-1234567890abcdefg' } });
    assert.equal(result.delivered, 1);
    assert.equal(received, 1);
  } finally {
    await new Promise<void>((resolve) => apiServer.close(() => resolve()));
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    rmSync(folder, { recursive: true, force: true });
  }
});
