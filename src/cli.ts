#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkUsage, getString, hasFlag, parseArguments } from './cli/arguments.js';
import { printStats, printSubmission, printSubmissionDetails, printSubmissionList, printValue } from './cli/format.js';
import { ConflictError, InputError, LedgerError } from './core/errors.js';
import { acceptSubmission, getSubmission, ledgerStats, listSubmissions } from './ledger/submissions.js';
import { exportLedger } from './ledger/export.js';
import { verifyLedger } from './ledger/verification.js';
import { initializeLedger } from './storage/sqlite.js';
import { VERSION } from './version.js';
import { deliveryStats, getDelivery, listDeliveryAttempts, pageDeliveries, queueSubmissionDelivery, validateDestinations } from './ledger/delivery.js';
import type { DeliveryStatus } from './ledger/delivery.js';
import { loadWebhookConfig } from './worker/config.js';

const HELP = `SubmissionLedger v0.3.0

Usage: submissionledger <command> [options]

Commands:
  init                         Create a ledger in the current directory
  submit --file PATH           Accept a JSON object from a file
  submit --data JSON           Accept a JSON object from a string
  list [--limit N]             List recent submissions (default 20, max 100)
  get ID                       Show a submission and its payload
  stats                        Show local ledger statistics
  verify                       Verify acceptance event hashes
  export --output PATH         Export verified ledger as JSONL
  enqueue --submission ID      Queue an existing submission for a webhook
  deliveries                   Show delivery queue (no payloads)
  delivery ID                  Show attempts for one delivery
  delivery-stats               Show job counts by status
  help                         Show this help

Options:
  --db PATH                    SQLite file (default ./.submissionledger/ledger.sqlite)
  --source NAME                Source namespace (default cli)
  --key KEY                    Optional idempotency key (scoped to the source)
  --json                       Machine-readable JSON output
  --deliver-to a,b             Atomically enqueue these destinations during submit
  --destination NAME           Target for enqueue
  --config PATH                Webhook destination JSON config
  --allow-local-http           Allow localhost HTTP in config for local development
  --version                    Show version

Examples:
  submissionledger init
  submissionledger submit --file examples/application.json --source website --key app-001
  submissionledger list --limit 10
  submissionledger get 00000000-0000-0000-0000-000000000000

Without --key, two identical payloads are treated as separate submissions.
The ledger is local by default. Data is not encrypted at rest. Don't commit database files.
`;

function parsePayload(args: ReturnType<typeof parseArguments>): unknown {
  const file = getString(args, 'file');
  const data = getString(args, 'data');
  if ((file === undefined) === (data === undefined)) {
    throw new InputError("Use exactly one of '--file PATH' or '--data JSON'.");
  }
  let raw: string;
  if (file !== undefined) {
    const filePath = resolve(file);
    if (statSync(filePath).size > 256 * 1024) {
      throw new InputError('Input file exceeds the 256 KiB raw file limit.');
    }
    raw = readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  } else {
    raw = data ?? '';
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new InputError('The input is not valid JSON.');
  }
}

function run(): void {
  const args = parseArguments(process.argv.slice(2));
  if (hasFlag(args, 'version')) {
    console.log(VERSION);
    return;
  }
  if (hasFlag(args, 'help') || args.command === 'help') {
    console.log(HELP);
    return;
  }
  const path = getString(args, 'db') ?? process.env.SUBMISSIONLEDGER_DB ?? '.submissionledger/ledger.sqlite';
  const json = hasFlag(args, 'json');
  const configured = (): Set<string> => {
    const configPath = getString(args, 'config') ?? process.env.SUBMISSIONLEDGER_DELIVERY_CONFIG;
    if (!configPath) throw new InputError('Provide --config or SUBMISSIONLEDGER_DELIVERY_CONFIG for webhook delivery.');
    const config = loadWebhookConfig(configPath, hasFlag(args, 'allow-local-http'));
    return new Set(Object.keys(config.destinations));
  };
  switch (args.command) {
    case 'init': {
      checkUsage(args, [], 0);
      const result = initializeLedger(path);
      if (json) printValue(result, true);
      else console.log(`${result.created ? 'Ledger created' : 'Ledger ready'}: ${result.path}`);
      break;
    }
    case 'submit': {
      checkUsage(args, ['file', 'data', 'source', 'key', 'deliver-to', 'config', 'allow-local-http'], 0);
      const input: { payload: unknown; source?: string; idempotencyKey?: string; destinations?: string[] } = {
        payload: parsePayload(args),
      };
      const source = getString(args, 'source');
      const key = getString(args, 'key');
      if (source !== undefined) input.source = source;
      if (key !== undefined) input.idempotencyKey = key;
      const deliverTo = getString(args, 'deliver-to');
      if (deliverTo !== undefined) {
        const destinations = validateDestinations(deliverTo.split(','));
        const allowed = configured();
        for (const name of destinations) if (!allowed.has(name)) throw new InputError(`Unconfigured delivery destination: ${name}`);
        input.destinations = destinations;
      }
      printSubmission(acceptSubmission(path, input), json);
      break;
    }
    case 'list': {
      checkUsage(args, ['source', 'limit'], 0);
      const rawLimit = getString(args, 'limit');
      const rawSource = getString(args, 'source');
      const options: { source?: string; limit?: number } = {};
      if (rawLimit !== undefined) options.limit = Number(rawLimit);
      if (rawSource !== undefined) options.source = rawSource;
      printSubmissionList(listSubmissions(path, options), json);
      break;
    }
    case 'get': {
      checkUsage(args, [], 1);
      printSubmissionDetails(getSubmission(path, args.positionals[0] ?? ''), json);
      break;
    }
    case 'stats': {
      checkUsage(args, [], 0);
      printStats(ledgerStats(path), json);
      break;
    }
    case 'enqueue': {
      checkUsage(args, ['submission', 'destination', 'config', 'allow-local-http'], 0);
      const id = getString(args, 'submission');
      const destination = getString(args, 'destination');
      if (!id || !destination) throw new InputError('Provide --submission ID and --destination NAME.');
      if (!configured().has(destination)) throw new InputError(`Unconfigured delivery destination: ${destination}`);
      const result = queueSubmissionDelivery(path, id, destination);
      printValue(result, true);
      break;
    }
    case 'deliveries': {
      checkUsage(args, ['status', 'limit', 'offset'], 0);
      const options: { status?: DeliveryStatus; limit?: number; offset?: number } = {};
      const status = getString(args, 'status');
      const limit = getString(args, 'limit');
      const offset = getString(args, 'offset');
      if (status !== undefined) options.status = status as DeliveryStatus;
      if (limit !== undefined) options.limit = Number(limit);
      if (offset !== undefined) options.offset = Number(offset);
      printValue(pageDeliveries(path, options), true);
      break;
    }
    case 'delivery': {
      checkUsage(args, [], 1);
      const id = args.positionals[0] ?? '';
      const delivery = getDelivery(path, id);
      if (!delivery) throw new InputError('Delivery not found.');
      printValue({ delivery, attempts: listDeliveryAttempts(path, id) }, true);
      break;
    }
    case 'delivery-stats': {
      checkUsage(args, [], 0);
      printValue(deliveryStats(path), true);
      break;
    }
    case 'verify': {
      checkUsage(args, [], 0);
      const result = verifyLedger(path);
      if (json) printValue(result, true);
      else {
        console.log(result.ok ? 'Ledger integrity: OK' : 'Ledger integrity: FAILED');
        console.log(`Submissions: ${result.submissions}  Events: ${result.events}`);
        for (const issue of result.issues) console.log(`  [${issue.code}] ${issue.detail}`);
      }
      if (!result.ok) process.exitCode = 1;
      break;
    }
    case 'export': {
      checkUsage(args, ['output'], 0);
      const output = getString(args, 'output');
      if (!output) throw new InputError('Missing required option --output.');
      const result = exportLedger(path, output);
      if (json) printValue(result, true);
      else {
        console.log(`Exported ${result.submissions} submissions and ${result.events} events to ${result.path}`);
        console.log('Note: The export contains full submission payloads. Store it securely.');
      }
      break;
    }
    default:
      throw new InputError(`Unknown command '${args.command}'. Run 'submissionledger help'.`);
  }
}

try {
  run();
} catch (error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`submissionledger: ${message}`);
  if (process.env.SUBMISSIONLEDGER_DEBUG === '1' && error instanceof Error) {
    console.error(error.stack);
  }
  process.exitCode = error instanceof ConflictError ? 3 : error instanceof InputError ? 2 :
    error instanceof LedgerError ? 1 : 1;
}
