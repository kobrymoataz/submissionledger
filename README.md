# SubmissionLedger

**Reliable local intake for applications, forms and other submissions.**

[![CI](https://github.com/kobrymoataz/submissionledger/actions/workflows/ci.yml/badge.svg)](https://github.com/kobrymoataz/submissionledger/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v0.1.0-27272a)](https://github.com/kobrymoataz/submissionledger/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-27272a)](LICENSE)

SubmissionLedger records incoming JSON submissions in a local SQLite database. It handles retries using caller-supplied idempotency keys, records acceptance events, and lets you inspect or export what was received. There is no service to run, no hosted account and no external data transfer.

This is an early release. The current interface is a CLI; HTTP endpoints and delivery workers are planned for later versions.

## Why it exists

When an application is sent twice because someone refreshes a page or a connection times out, you need a predictable answer: *was it already accepted, and did the data change?* SubmissionLedger keeps that decision explicit and inspectable.

The first release addresses one part of that problem: local receipt and durable storage. It does not send emails, synchronize remote systems or guarantee exactly-once delivery across services.

## Quick start

Requires **Node.js 22.13 or newer** (Node 24 is recommended) and npm.

```bash
git clone https://github.com/kobrymoataz/submissionledger.git
cd submissionledger
npm ci
npm run build

npm run cli -- init
npm run cli -- submit --file examples/application.json --source website --key app-001
npm run cli -- list
npm run cli -- stats
npm run cli -- verify
```

The default database is `./.submissionledger/ledger.sqlite`, relative to your current working directory. Use `--db PATH` or `SUBMISSIONLEDGER_DB` to choose a different location. SQLite and its journal files are excluded from Git.

### Try a retry

```bash
npm run cli -- submit --file examples/application.json --source website --key app-001
```

The second request returns **replayed** with the original submission ID. If the same `source` and `key` are used with different payload contents, the CLI rejects the request with exit code `3`. It never quietly overwrites the original submission.

Without `--key`, identical payloads create separate submissions. This is intentional: identical answers are not necessarily duplicate applications. Keys are case-sensitive and scoped to the source.

## Commands

| Command | Purpose |
| --- | --- |
| `init` | Create or reopen the SQLite ledger |
| `submit --file PATH` | Accept a JSON object from a file |
| `submit --data JSON` | Accept an inline JSON object |
| `list [--limit N]` | Show up to 100 recent submissions, without payload bodies |
| `get ID` | Display one submission and its payload |
| `stats` | Show counts and source breakdown |
| `verify` | Check payload hashes, event links and SQLite integrity |
| `export --output PATH` | Create a JSON Lines export after verification |

Use `--json` with commands that return data. Run `npm run cli -- help` for the complete reference. See [CLI details](docs/CLI.md) for return codes and examples.

### Verify and export

```bash
npm run cli -- verify
npm run cli -- export --output ./backups/ledger-2026-10-21.jsonl
```

Exports contain the **full payload of every submission** and must be stored securely. Existing export files are never silently overwritten. On Unix systems they are created with restrictive file permissions.

## Under the hood

- **Local-first**: Node.js, built-in `node:sqlite`, no runtime dependencies.
- **Durable writes**: SQLite transactions and write-ahead logging.
- **Replay safety**: `(source, idempotency_key)` is unique; equal canonical JSON replays the original result; different data returns a conflict.
- **Small audit trail**: One acceptance event per new submission, with SHA-256 digests linked to the preceding event.
- **Transparent checks**: `verify` checks event continuity, payload digests and database integrity. It reports discrepancies; it does not repair or conceal them.
- **Portable output**: JSON Lines for backups and inspection.

Read [Design and limitations](docs/DESIGN.md) before using the ledger with sensitive or operationally important records.

**Important:** SHA-256 hashes do not provide authenticity on their own. Anyone with full write access to the database can recompute a hash chain. This is a consistency check, not a tamper-proof or legally certified audit record.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

There are no native npm addons or database services to install. Node 22 may display an experimental warning for its built-in SQLite module; it is not a test failure.

## Roadmap

- **v0.1**: Local ledger, idempotent intake, CLI, verification, JSONL export. **Current.**
- **v0.2**: HTTP intake API, request validation and request tracing.
- **v0.3**: Durable outbox and delivery workers for webhooks.
- **v0.4**: Delivery retries, backoff, dead-letter handling and reconciliation.
- **v0.5**: External connectors, starting with Google Sheets.
- **v0.6**: Receipt documents and verifiable reference links.
- **v0.7**: Operations dashboard and manual recovery tools.
- **v0.8**: Framework adapters and integration examples.
- **v0.9**: Security review, load tests, deployment templates.
- **v1.0**: Stable API and production-readiness documentation.

Planned features are not part of v0.1, and the roadmap can change with feedback.

## Contributing

Bug reports and focused pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) and [SECURITY.md](SECURITY.md) before opening security-related issues.

MIT licensed. Maintained by [@kobrymoataz](https://github.com/kobrymoataz).
