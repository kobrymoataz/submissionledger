#!/usr/bin/env node
import { InputError } from '../core/errors.js';
import { initializeLedger } from '../storage/sqlite.js';
import { loadWebhookConfig } from './config.js';
import { runDeliveryBatch } from './runner.js';

const HELP = `SubmissionLedger delivery worker

Usage: npm run worker -- --config PATH [--once] [--allow-local-http]

Options:
  --db PATH               SQLite ledger path
  --config PATH           JSON webhook configuration (required)
  --once                  Process one batch and exit
  --allow-local-http      Allow HTTP only on 127.0.0.1, ::1 or localhost for development
  --poll-ms N             Polling interval (default 3000)
  --timeout-ms N          Per-request timeout (default 10000)
  --lease-ms N            Lease duration (default 30000)
  --max-batch N           Max jobs per poll (default 20)

The worker delivers at least once, not exactly once. Receivers must deduplicate delivery IDs.
`;

function argumentsFrom(argv: string[]): Map<string, string | true> {
  const valid = new Set(['db', 'config', 'once', 'allow-local-http', 'poll-ms', 'timeout-ms', 'lease-ms', 'max-batch', 'help']);
  const booleans = new Set(['once', 'allow-local-http', 'help']);
  const result = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i] ?? '';
    if (!item.startsWith('--')) throw new InputError(`Unexpected worker argument: ${item}`);
    const index = item.indexOf('=');
    const name = item.slice(2, index < 0 ? undefined : index);
    if (!valid.has(name) || result.has(name)) throw new InputError(`Unknown or duplicate option: --${name}`);
    if (booleans.has(name)) {
      if (index >= 0) throw new InputError(`Option --${name} takes no value.`);
      result.set(name, true);
    } else {
      const value = index >= 0 ? item.slice(index + 1) : argv[++i];
      if (!value || value.startsWith('--')) throw new InputError(`Missing value for --${name}`);
      result.set(name, value);
    }
  }
  return result;
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2));
  if (args.has('help')) { console.log(HELP); return; }
  const get = (key: string): string | undefined => args.get(key) as string | undefined;
  const num = (key: string, fallback: number): number => {
    const value = get(key);
    if (value === undefined) return fallback;
    if (!/^\d+$/.test(value)) throw new InputError(`Invalid --${key}`);
    return Number(value);
  };
  const configPath = get('config') ?? process.env.SUBMISSIONLEDGER_DELIVERY_CONFIG;
  if (!configPath) throw new InputError('--config or SUBMISSIONLEDGER_DELIVERY_CONFIG is required.');
  const config = loadWebhookConfig(configPath, args.has('allow-local-http'));
  const dbPath = get('db') ?? process.env.SUBMISSIONLEDGER_DB ?? '.submissionledger/ledger.sqlite';
  const pollMs = num('poll-ms', 3000);
  if (!Number.isInteger(pollMs) || pollMs < 250 || pollMs > 60000) throw new InputError('--poll-ms must be 250-60000.');
  // Migration is deliberate: initialize before launching the API or the worker.
  initializeLedger(dbPath);
  let stopping = false;
  for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => { stopping = true; });
  do {
    const result = await runDeliveryBatch({ dbPath, config,
      timeoutMs: num('timeout-ms', 10_000), leaseMs: num('lease-ms', 30_000),
      maxBatch: num('max-batch', 20),
      onDelivery: (item) => console.log(`${new Date().toISOString()} ${item.id} ${item.destination} attempt=${item.attempt} ${item.outcome}`),
    });
    console.log(`delivery batch: ${result.processed} processed; ${result.delivered} delivered; ${result.retried} retry; ${result.dead} dead`);
    if (args.has('once') || stopping) break;
    await new Promise<void>((done) => { setTimeout(done, pollMs); });
  } while (!stopping);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`submissionledger worker: ${message}`);
  process.exitCode = 1;
});
