# SubmissionLedger

**Keep every submission accounted for.**

[![CI](https://github.com/kobrymoataz/submissionledger/actions/workflows/ci.yml/badge.svg)](https://github.com/kobrymoataz/submissionledger/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v0.2.0-27272a)](https://github.com/kobrymoataz/submissionledger/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-27272a)](LICENSE)

SubmissionLedger is a small, self-hosted intake ledger for JSON submissions. It records each accepted submission and a linked event in one SQLite transaction, handles explicit retries with idempotency keys, and provides a CLI and authenticated HTTP API to inspect the results.

Version 0.2 adds a local HTTP API. It does not deliver email, synchronize webhooks or manage processing queues. Those parts are not implemented yet.

## What it solves

A browser times out after submitting a form. The caller tries again. Was the first request saved? With a stable idempotency key, SubmissionLedger returns the original receipt for identical data or a conflict if the key is reused for different data. Without a key, both requests are accepted as separate records.

The record remains available for inspection, statistics, export and consistency checks. Its SHA-256-linked event log helps detect accidental modifications, but is not a tamper-proof audit system.

## Quick start

Requires Node.js 22.13+ and npm. Node.js 24 is recommended.

```bash
git clone https://github.com/kobrymoataz/submissionledger.git
cd submissionledger
npm ci
npm run build
npm run cli -- init
```

To use the API, create one local bearer token outside the repository:

```bash
umask 077
mkdir -p "$HOME/.config/submissionledger"
test -f "$HOME/.config/submissionledger/api-token" || \
  openssl rand -hex 32 > "$HOME/.config/submissionledger/api-token"
export SUBMISSIONLEDGER_API_TOKEN="$(cat "$HOME/.config/submissionledger/api-token")"
npm run api
```

The server listens on `http://127.0.0.1:8787` by default. Leave it running and open a second Terminal window:

```bash
export SUBMISSIONLEDGER_API_TOKEN="$(cat "$HOME/.config/submissionledger/api-token")"

curl -i http://127.0.0.1:8787/health

curl -i http://127.0.0.1:8787/v1/submissions \
  -H "Authorization: Bearer $SUBMISSIONLEDGER_API_TOKEN"

curl -i -X POST http://127.0.0.1:8787/v1/submissions \
  -H "Authorization: Bearer $SUBMISSIONLEDGER_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: demo-001' \
  --data @examples/http-submission.json
```

Run the POST a second time and it returns `200` with `outcome: replayed` and the same submission ID. A new submission returns `201` and `outcome: accepted`.

## HTTP API

| Method | Endpoint | Result |
| --- | --- | --- |
| `GET` | `/health` | Public process health, no data access |
| `POST` | `/v1/submissions` | Validate and store an intake request |
| `GET` | `/v1/submissions` | Paginated summaries without payloads |
| `GET` | `/v1/submissions/:id` | Full record for an existing UUID |
| `GET` | `/v1/stats` | Submission and event counts |
| `GET` | `/v1/ledger/verify` | Integrity check report |

All `/v1` endpoints require an `Authorization: Bearer <token>` header. There are no browser CORS permissions by default. POST bodies must be JSON with `payload` and optional `source` keys. The `Idempotency-Key` header scopes a retry within the source namespace. Payloads are limited to 64 KiB after normalization; raw HTTP request bodies are limited to 96 KiB.

Responses include `X-Request-Id` and a matching `requestId` field to help trace failures without logging request bodies. The API uses `400`, `401`, `404`, `405`, `409`, `413`, `415` and `422` for common errors.

See [API documentation](docs/API.md) and the [OpenAPI definition](docs/openapi.yaml) for request and response details.

## CLI

The v0.1 commands still work with the same database:

```bash
npm run cli -- submit --file examples/application.json --source website --key app-001
npm run cli -- list --limit 10
npm run cli -- get YOUR_SUBMISSION_ID
npm run cli -- stats
npm run cli -- verify
npm run cli -- export --output ./backups/submissions.jsonl
```

Set `SUBMISSIONLEDGER_DB` to use a different SQLite file with both CLI and API. By default the path is `./.submissionledger/ledger.sqlite`, relative to the working directory.

## Safety and scope

- The HTTP server binds to loopback by default and refuses to start without a bearer token of at least 24 characters.
- Requests use no third-party HTTP or database runtime libraries. The database schema stays at version 1.
- List responses exclude payload bodies. Authenticated detail and intake responses do include full payloads.
- SQLite data and JSONL exports are not encrypted at rest. Do not send passwords, payment details, access tokens or unnecessary personal data.
- No encryption in transit, rate limiting, user roles, consent management or retention policy is provided. Do not expose this service directly to the public Internet.
- Offset pagination can shift while new submissions are being inserted. Use the results as a recent view, not an immutable snapshot.
- The `/health` endpoint reports process availability, not full database readiness.

Read [design notes](docs/DESIGN.md) and [security policy](SECURITY.md) before evaluating a deployment.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run build
```

Tests cover local storage and CLI behavior as well as real HTTP requests against temporary SQLite ledgers. CI runs on Ubuntu and macOS with Node 22 and 24.

## Roadmap

- **v0.1**: SQLite intake, CLI, idempotency, event verification and JSONL export. Released.
- **v0.2**: Authenticated HTTP API, input validation, pagination and request IDs. Current release.
- **v0.3**: Durable outbox and webhook delivery workers.
- **v0.4**: Retry policy, backoff, dead-letter handling and reconciliation.
- **v0.5**: External connectors, starting with Google Sheets.
- **v0.6**: Receipt documents and reference links.
- **v0.7**: Operations dashboard.
- **v0.8**: Framework adapters and integration examples.
- **v0.9**: Deployment tooling, performance and security review.
- **v1.0**: Stable API and production-readiness work.

Plans are subject to change. Features listed after v0.2 are not available in this release.

## Contributing

Issues and focused pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md). Report security issues privately using the instructions in [SECURITY.md](SECURITY.md).

MIT licensed. Maintained by [@kobrymoataz](https://github.com/kobrymoataz).
