#!/usr/bin/env node
import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { checkUsage, getString, hasFlag, parseArguments } from './cli/arguments.js';
import { printStats, printSubmission, printSubmissionDetails, printSubmissionList, printValue } from './cli/format.js';
import { ConflictError, InputError, LedgerError } from './core/errors.js';
import { acceptSubmission, getSubmission, ledgerStats, listSubmissions } from './ledger/submissions.js';
import { initializeLedger } from './storage/sqlite.js';

const HELP = `SubmissionLedger v0.1.0

Usage: submissionledger <command> [options]

Commands:
  init                         Create a ledger in the current directory
  submit --file PATH           Accept a JSON object from a file
  submit --data JSON           Accept a JSON object from a string
  list [--limit N]             List recent submissions (default 20, max 100)
  get ID                       Show a submission and its payload
  stats                        Show local ledger statistics
  help                         Show this help

Options:
  --db PATH                    SQLite file (default ./.submissionledger/ledger.sqlite)
  --source NAME                Source namespace (default cli)
  --key KEY                    Optional idempotency key (scoped to the source)
  --json                       Machine-readable JSON output
  --version                    Show version

Examples:
  submissionledger init
  submissionledger submit --file examples/application.json --source website --key app-001
  submissionledger list --limit 10
  submissionledger get 00000000-0000-0000-0000-000000000000

Without --key, two identical payloads are treated as separate submissions.
The ledger is local. Data is not encrypted at rest. Don't commit database files.
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
    console.log('0.1.0');
    return;
  }
  if (hasFlag(args, 'help') || args.command === 'help') {
    console.log(HELP);
    return;
  }
  const path = getString(args, 'db') ?? process.env.SUBMISSIONLEDGER_DB ?? '.submissionledger/ledger.sqlite';
  const json = hasFlag(args, 'json');
  switch (args.command) {
    case 'init': {
      checkUsage(args, [], 0);
      const result = initializeLedger(path);
      if (json) printValue(result, true);
      else console.log(`${result.created ? 'Ledger created' : 'Ledger ready'}: ${result.path}`);
      break;
    }
    case 'submit': {
      checkUsage(args, ['file', 'data', 'source', 'key'], 0);
      const input: { payload: unknown; source?: string; idempotencyKey?: string } = {
        payload: parsePayload(args),
      };
      const source = getString(args, 'source');
      const key = getString(args, 'key');
      if (source !== undefined) input.source = source;
      if (key !== undefined) input.idempotencyKey = key;
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
