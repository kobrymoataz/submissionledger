import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import { InputError } from '../core/errors.js';
import { claimDueDelivery, finishDelivery, retryBackoffMs } from '../ledger/dispatch.js';
import { deliveryStats, getDelivery, listDeliveryAttempts, pageDeliveries } from '../ledger/delivery.js';
import { acceptSubmission } from '../ledger/submissions.js';
import { initializeLedger } from '../storage/sqlite.js';
import { parseWebhookConfig, signingSecrets } from '../worker/config.js';
import { retryAfterSeconds, runDeliveryBatch } from '../worker/runner.js';

const secret = 'local-test-secret-with-at-least-32-characters';
const env = { SL_TEST_SECRET: secret };

function withTemp<T>(run: (path: string) => Promise<T> | T): Promise<T> {
  const folder = mkdtempSync(join(tmpdir(), 'sl-dispatch-'));
  const path = join(folder, 'ledger.sqlite');
  initializeLedger(path);
  return Promise.resolve().then(() => run(path)).finally(() => rmSync(folder, { recursive: true, force: true }));
}

async function serverFor(handler: (request: IncomingMessage, response: ServerResponse) => void) {
  const server = createServer(handler);
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const port = (server.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/webhook`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

function localConfig(url: string) {
  return parseWebhookConfig({ destinations: { audit: { url, secretEnv: 'SL_TEST_SECRET' } } }, true);
}

test('configuration blocks remote HTTP, credentials and redirect targets; secrets remain external', () => {
  assert.throws(() => parseWebhookConfig({ destinations: { audit: { url: 'http://example.com/path', secretEnv: 'SL_TEST_SECRET' } } }, true), InputError);
  assert.throws(() => parseWebhookConfig({ destinations: { audit: { url: 'http://127.0.0.1:9999/', secretEnv: 'SL_TEST_SECRET' } } }), InputError);
  assert.throws(() => parseWebhookConfig({ destinations: { audit: { url: 'https://admin:pw@example.com/', secretEnv: 'SL_TEST_SECRET' } } }), InputError);
  assert.throws(() => parseWebhookConfig({ destinations: { audit: { url: 'https://example.com/path#fragment', secretEnv: 'SL_TEST_SECRET' } } }), InputError);
  const config = localConfig('http://127.0.0.1:9999/');
  assert.equal(config.destinations.audit?.secretEnv, 'SL_TEST_SECRET');
  assert.throws(() => signingSecrets(config, { SL_TEST_SECRET: 'short' }), InputError);
  assert.deepEqual({ ...signingSecrets(config, env) }, { audit: secret });
});

test('two claims cannot acquire the same lease; finishing with an old token is fenced', () => withTemp((path) => {
  acceptSubmission(path, { payload: { sample: true }, destinations: ['audit'] });
  const start = new Date(Date.now() + 1000);
  const first = claimDueDelivery(path, ['audit'], { now: start, leaseMs: 5000 });
  assert.ok(first);
  assert.equal(claimDueDelivery(path, ['audit'], { now: start, leaseMs: 5000 }), null);
  const reclaimed = claimDueDelivery(path, ['audit'], { now: new Date(start.getTime() + 6000), leaseMs: 5000 });
  assert.ok(reclaimed);
  assert.equal(reclaimed.id, first.id);
  assert.equal(reclaimed.attempt, 2);
  assert.equal(finishDelivery(path, first, { kind: 'success', httpStatus: 200 }).applied, false);
  assert.deepEqual(finishDelivery(path, reclaimed, { kind: 'success', httpStatus: 204 }, new Date(start.getTime() + 7000)),
    { applied: true, status: 'delivered' });
  assert.equal(deliveryStats(path).delivered, 1);
  assert.deepEqual(listDeliveryAttempts(path, first.id).map((a) => a.outcome), ['abandoned', 'delivered']);
}));

test('expired final lease becomes dead and is never sent again', () => withTemp((path) => {
  acceptSubmission(path, { payload: { sample: true }, destinations: ['audit'] });
  const now = new Date(Date.now() + 1000);
  const d = pageDeliveries(path).items[0]; assert.ok(d);
  const claim = claimDueDelivery(path, ['audit'], { now, leaseMs: 5000 }); assert.ok(claim);
  // Simulate an operator lowering max_attempts before a crashed worker's lease expires.
  // The lease must exhaust attempts without calling the remote endpoint.
  const db = new DatabaseSync(path);
  db.prepare('UPDATE delivery_outbox SET max_attempts = 1 WHERE id = ?').run(d.id);
  db.close();
  assert.equal(claimDueDelivery(path, ['audit'], { now: new Date(now.getTime() + 6000), leaseMs: 5000 }), null);
  assert.equal(getDelivery(path, d.id)?.status, 'dead');
  assert.equal(listDeliveryAttempts(path, d.id)[0]?.outcome, 'abandoned');
}));

test('worker signs stable delivery ID and payload; success needs a 2xx response', async () => withTemp(async (path) => {
  const requestData: Array<{ id: string | undefined; attempt: string | undefined; payload: unknown }> = [];
  const remote = await serverFor(async (req, res) => {
    let body = '';
    for await (const fragment of req) body += fragment.toString();
    const expected = createHmac('sha256', secret).update(body).digest('hex');
    assert.equal(req.headers['x-submissionledger-signature'], `sha256=${expected}`);
    const payload = JSON.parse(body) as { deliveryId: string; submission: { payload: unknown } };
    requestData.push({ id: req.headers['x-submissionledger-delivery-id'] as string, attempt: req.headers['x-submissionledger-attempt'] as string,
      payload: payload.submission.payload });
    res.writeHead(204); res.end();
  });
  try {
    const submission = acceptSubmission(path, { payload: { customer: 'Sam' }, destinations: ['audit'] });
    const first = await runDeliveryBatch({ dbPath: path, config: localConfig(remote.url), env });
    assert.deepEqual(first, { processed: 1, delivered: 1, retried: 0, dead: 0, stale: 0 });
    assert.equal(requestData.length, 1);
    assert.deepEqual(requestData[0]?.payload, { customer: 'Sam' });
    assert.equal(requestData[0]?.attempt, '1');
    assert.equal(requestData[0]?.id, pageDeliveries(path).items[0]?.id);
    assert.equal(submission.outcome, 'accepted');
    const second = await runDeliveryBatch({ dbPath: path, config: localConfig(remote.url), env });
    assert.equal(second.processed, 0);
    assert.equal(deliveryStats(path).delivered, 1);
  } finally { await remote.close(); }
}));

test('429 schedules retry with Retry-After, then sends same delivery ID', async () => withTemp(async (path) => {
  const ids: string[] = []; let count = 0;
  const remote = await serverFor((req, res) => {
    ids.push(String(req.headers['x-submissionledger-delivery-id']));
    count += 1;
    req.resume();
    if (count === 1) res.writeHead(429, { 'Retry-After': '12' });
    else res.writeHead(200);
    res.end();
  });
  try {
    acceptSubmission(path, { payload: { value: 1 }, destinations: ['audit'] });
    const start = new Date(Date.now() + 1000);
    const opts = { dbPath: path, config: localConfig(remote.url), env };
    const one = await runDeliveryBatch({ ...opts, now: () => start });
    assert.equal(one.retried, 1);
    const d = pageDeliveries(path).items[0]; assert.ok(d);
    assert.equal(d.lastHttpStatus, 429);
    assert.equal(d.nextAttemptAt, new Date(start.getTime() + 12_000).toISOString());
    assert.equal((await runDeliveryBatch({ ...opts, now: () => new Date(start.getTime() + 10_000) })).processed, 0);
    const two = await runDeliveryBatch({ ...opts, now: () => new Date(start.getTime() + 13_000) });
    assert.equal(two.delivered, 1);
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1]);
    assert.deepEqual(listDeliveryAttempts(path, d.id).map((a) => a.outcome), ['retry', 'delivered']);
  } finally { await remote.close(); }
}));

test('permanent 400 marks delivery dead without retry', async () => withTemp(async (path) => {
  const remote = await serverFor((req, res) => { req.resume(); res.writeHead(400); res.end('do not record this body'); });
  try {
    acceptSubmission(path, { payload: { secret: 'do-not-log' }, destinations: ['audit'] });
    const one = await runDeliveryBatch({ dbPath: path, config: localConfig(remote.url), env });
    assert.equal(one.dead, 1);
    const d = pageDeliveries(path).items[0]; assert.ok(d);
    assert.equal(d.lastErrorCode, 'http_400');
    assert.equal((await runDeliveryBatch({ dbPath: path, config: localConfig(remote.url), env })).processed, 0);
  } finally { await remote.close(); }
}));

test('backoff and Retry-After are bounded', () => {
  assert.equal(retryBackoffMs(1), 5000);
  assert.equal(retryBackoffMs(2), 10000);
  assert.equal(retryBackoffMs(25), 900000);
  assert.equal(retryAfterSeconds('360000', new Date('2026-01-01T00:00:00Z')), 3600);
  assert.equal(retryAfterSeconds('not-a-date', new Date()), undefined);
});

test('repeated 503 responses stop at the configured maximum attempts', async () => withTemp(async (path) => {
  let sends = 0;
  const remote = await serverFor((req, res) => { req.resume(); sends += 1; res.writeHead(503); res.end(); });
  try {
    acceptSubmission(path, { payload: { x: 1 }, destinations: ['audit'] });
    for (let i = 0; i < 5; i += 1) {
      const now = new Date(Date.now() + 10_000 + i * 3_600_000);
      const result = await runDeliveryBatch({ dbPath: path, config: localConfig(remote.url), env, now: () => now });
      assert.equal(result.processed, 1);
      assert.equal(i === 4 ? result.dead : result.retried, 1);
    }
    assert.equal(sends, 5);
    const job = pageDeliveries(path).items[0]; assert.ok(job);
    assert.equal(job.status, 'dead');
    assert.equal(job.attempts, 5);
    assert.equal(listDeliveryAttempts(path, job.id).length, 5);
    assert.equal((await runDeliveryBatch({ dbPath: path, config: localConfig(remote.url), env })).processed, 0);
  } finally { await remote.close(); }
}));

test('webhook redirects are terminal and never followed', async () => withTemp(async (path) => {
  let forwarded = 0;
  const remote = await serverFor((req, res) => { req.resume(); forwarded += 1;
    res.writeHead(302, { Location: 'https://example.org/redirect' }); res.end(); });
  try {
    acceptSubmission(path, { payload: { x: 1 }, destinations: ['audit'] });
    const result = await runDeliveryBatch({ dbPath: path, config: localConfig(remote.url), env });
    assert.equal(result.dead, 1);
    assert.equal(forwarded, 1);
    assert.equal(pageDeliveries(path).items[0]?.lastErrorCode, 'redirect_blocked');
  } finally { await remote.close(); }
}));
