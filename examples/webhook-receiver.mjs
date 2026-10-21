// Local-only example. Keeps received delivery IDs in memory, not in a durable store.
import { createHmac, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

const secret = process.env.SL_DEMO_SIGNING_SECRET;
if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
  console.error('Set SL_DEMO_SIGNING_SECRET to at least 32 bytes.');
  process.exit(1);
}
const seen = new Set();
const server = createServer(async (req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.writeHead(404); res.end(); return;
  }
  let size = 0;
  const chunks = [];
  for await (const part of req) {
    const bytes = Buffer.from(part);
    size += bytes.length;
    if (size > 96 * 1024) { res.writeHead(413); res.end(); return; }
    chunks.push(bytes);
  }
  const body = Buffer.concat(chunks);
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(body).digest('hex'));
  const supplied = Buffer.from(String(req.headers['x-submissionledger-signature'] ?? ''));
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    res.writeHead(401); res.end(); return;
  }
  const id = String(req.headers['x-submissionledger-delivery-id'] ?? '');
  if (!/^[0-9a-f-]{36}$/i.test(id)) { res.writeHead(400); res.end(); return; }
  const duplicate = seen.has(id);
  seen.add(id);
  console.log(`${new Date().toISOString()} ${duplicate ? 'duplicate' : 'accepted'} delivery=${id}`);
  // Do not log raw webhook payloads; they may contain private applicant data.
  res.writeHead(204); res.end();
});
server.listen(9099, '127.0.0.1', () => console.log('Demo webhook receiver listening on http://127.0.0.1:9099/webhook'));
