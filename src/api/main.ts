#!/usr/bin/env node
import { createApiServer } from './server.js';
import { validateApiToken } from './security.js';
import { loadWebhookConfig } from '../worker/config.js';

function parsePort(raw: string): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error('SUBMISSIONLEDGER_API_PORT must be a number from 1 to 65535.');
  }
  return value;
}

try {
  const token = validateApiToken(process.env.SUBMISSIONLEDGER_API_TOKEN);
  const dbPath = process.env.SUBMISSIONLEDGER_DB ?? '.submissionledger/ledger.sqlite';
  const host = process.env.SUBMISSIONLEDGER_API_HOST ?? '127.0.0.1';
  const port = parsePort(process.env.SUBMISSIONLEDGER_API_PORT ?? '8787');
  const configPath = process.env.SUBMISSIONLEDGER_DELIVERY_CONFIG;
  const deliveryConfig = configPath ? loadWebhookConfig(configPath, process.env.SUBMISSIONLEDGER_ALLOW_LOCAL_HTTP === '1') : undefined;
  const server = createApiServer({
    dbPath,
    token,
    ...(deliveryConfig ? { deliveryConfig } : {}),
    onRequest: ({ requestId, method, status, durationMs }) => {
      console.log(`${new Date().toISOString()} ${requestId} ${method} ${status} ${durationMs}ms`);
    },
  });
  server.on('error', (error) => {
    console.error(`submissionledger api: ${error.message}`);
    process.exitCode = 1;
  });
  server.listen(port, host, () => {
    console.log(`SubmissionLedger API listening at http://${host}:${port}`);
    if (host !== '127.0.0.1' && host !== '::1' && host !== 'localhost') {
      console.warn('Warning: the API is reachable outside loopback. Use TLS and network access controls before deployment.');
    }
    console.log('Authenticated routes are under /v1. Press Ctrl+C to stop.');
  });
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => server.close(() => { process.exitCode = 0; }));
  }
} catch (error) {
  console.error(`submissionledger api: ${error instanceof Error ? error.message : 'Startup failed.'}`);
  process.exitCode = 1;
}
