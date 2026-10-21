# SubmissionLedger

**Keep every submission accounted for, from intake to delivery.**

[![CI](https://github.com/kobrymoataz/submissionledger/actions/workflows/ci.yml/badge.svg)](https://github.com/kobrymoataz/submissionledger/actions/workflows/ci.yml)
[![Release](https://img.shields.io/badge/release-v0.3.0-27272a)](https://github.com/kobrymoataz/submissionledger/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-27272a)](LICENSE)

SubmissionLedger is a small, self-hosted service for reliably accepting JSON submissions and delivering them to webhook destinations. SQLite stores the original submission, an acceptance event and any requested delivery jobs in a single transaction. A separate worker signs and sends those jobs, then records the outcome of each attempt.

The service is intentionally local-first. No external queue service, broker or cloud account is required.

## Why this exists

A user submits a form and the browser times out. You don't know if the request was saved. A second request might create a duplicate. Even when the submission is saved, the outbound webhook might fail or the process might shut down before delivery.

SubmissionLedger addresses both parts: **idempotent intake** and a **persistent, leased delivery queue**. It does not claim exactly-once delivery. The receiving service must handle repeated delivery IDs safely.

## V0.3 features

- SQLite-backed submissions, stable idempotency keys and original payload hashes.
- Authenticated local REST API and command-line tools.
- Atomic submission + outbox inserts for up to eight configured destinations.
- Manual enqueue for existing submissions, without duplicating jobs.
- Webhook worker with durable leases, lease-expiry recovery, bounded retries and HMAC-SHA256 signatures.
- Delivery status and attempt history, without echoing payloads in list responses.
- HTTP 2xx success, retryable timeouts/408/425/429/5xx, permanent failures for other statuses.
- Schema v1 to v2 migration retaining existing submission records and acceptance event hashes.

These are deliberately small building blocks, not a hosted form builder, email sender or enterprise queue.

## Requirements

Node.js **22.13+** and npm. Node.js 24 is recommended. The standard Node SQLite module is used and may display an experimental warning on some Node 22 versions.

```bash
git clone https://github.com/kobrymoataz/submissionledger.git
cd submissionledger
npm ci
npm run build
npm run cli -- init
```

`init` upgrades an existing schema v1 ledger to v2. If you have an existing database, **stop the API and worker and take an SQLite backup before running it**. See [migration notes](docs/DELIVERY.md#migrating-from-v02).

The default database is `.submissionledger/ledger.sqlite` relative to the working directory. `SUBMISSIONLEDGER_DB` overrides it. Never commit databases or exported JSONL files.

## Local webhook walkthrough

The example receiver only listens on your computer, and is not intended for public deployment.

Create two local secrets and keep them outside Git:

```bash
umask 077
mkdir -p "$HOME/.config/submissionledger"
test -f "$HOME/.config/submissionledger/api-token" || openssl rand -hex 32 > "$HOME/.config/submissionledger/api-token"
test -f "$HOME/.config/submissionledger/demo-secret" || openssl rand -hex 32 > "$HOME/.config/submissionledger/demo-secret"
npm run cli -- init
```

Open **three terminals**, each in the project directory.

**Terminal A: local webhook receiver**

```bash
export SL_DEMO_SIGNING_SECRET="$(cat "$HOME/.config/submissionledger/demo-secret")"
node examples/webhook-receiver.mjs
```

**Terminal B: submission API**

```bash
export SUBMISSIONLEDGER_API_TOKEN="$(cat "$HOME/.config/submissionledger/api-token")"
export SUBMISSIONLEDGER_DELIVERY_CONFIG="$PWD/examples/webhooks.local.json"
export SUBMISSIONLEDGER_ALLOW_LOCAL_HTTP=1
npm run api
```

**Terminal C: send a submission and process its delivery**

```bash
export SUBMISSIONLEDGER_API_TOKEN="$(cat "$HOME/.config/submissionledger/api-token")"
export SL_DEMO_SIGNING_SECRET="$(cat "$HOME/.config/submissionledger/demo-secret")"

curl -i -X POST http://127.0.0.1:8787/v1/submissions \
  -H "Authorization: Bearer $SUBMISSIONLEDGER_API_TOKEN" \
  -H 'Content-Type: application/json' \
  -H 'Idempotency-Key: local-demo-001' \
  --data @examples/http-delivery.json

npm run worker -- --config examples/webhooks.local.json --allow-local-http --once
npm run cli -- deliveries
npm run cli -- delivery-stats
```

Repeat the POST with the same payload/key: it returns the same submission, not a second delivery. To run the worker continuously instead, omit `--once`.

**Important:** loopback HTTP is allowed only with the explicit development option. Configured production URLs must use HTTPS. Webhooks include the full submission payload. Do not send unnecessary personal information or secrets.

## API overview

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Public process health |
| `POST` | `/v1/submissions` | Accept a JSON payload, optionally queue delivery destinations |
| `GET` | `/v1/submissions` | Paginated submission summaries |
| `GET` | `/v1/submissions/:id` | Retrieve one submission (includes payload) |
| `POST` | `/v1/submissions/:id/deliveries` | Enqueue a configured destination for an existing submission |
| `GET` | `/v1/deliveries` | Paginated delivery states |
| `GET` | `/v1/deliveries/:id` | Delivery and attempt history |
| `GET` | `/v1/deliveries/stats` | Counts by status |
| `GET` | `/v1/stats` | Intake totals |
| `GET` | `/v1/ledger/verify` | Acceptance event integrity report |

All `/v1` routes require a bearer token. To deliver to a destination, it must be declared in the operator's JSON configuration; callers cannot submit arbitrary URLs. A retry of an idempotency key must have the same payload and original destination set. The URL configuration and signing secrets are not stored in SQLite.

Read [HTTP reference](docs/API.md), [delivery design](docs/DELIVERY.md) and [OpenAPI](docs/openapi.yaml).

## Delivery guarantee

**At least once, not exactly once.** A worker can successfully send a request but crash before recording success. A recovered lease may send it again. Receivers should deduplicate `X-SubmissionLedger-Delivery-Id` and verify `X-SubmissionLedger-Signature` using their shared secret and the *raw* request body.

Retries use bounded exponential backoff (starting at five seconds), respect a reasonable `Retry-After` delay, and stop after five attempts by default. Dead jobs remain visible but are not requeued in v0.3. Manual recovery workflows are planned for v0.4.

## Safety and scope

- Database payloads and JSONL exports are **not encrypted at rest**. Back them up and set filesystem permissions.
- The HTTP server binds to loopback by default. It does not provide TLS termination, rate limiting, users/roles or per-source access control. Never expose it directly to the public internet.
- HMAC signatures authenticate payload origin to receivers; they do not encrypt outbound data.
- `verify` checks acceptance event hashes and does **not** audit the mutable delivery tables. Local hash chains are not tamper-proof evidence against a privileged attacker.
- Endpoint URLs come from a trusted operator-managed configuration; redirects are never followed. Do not share configuration write access with untrusted users.
- Responses from remote webhooks are not saved. Operational errors record only a generic category/status, never the response body.

See [SECURITY.md](SECURITY.md) for responsible disclosure.

## Contributing

Install dependencies and run all checks before opening a PR:

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The test suite covers storage, migrations, worker leases, retry policy, signature verification and actual local HTTP exchanges. GitHub Actions runs Node.js 22 and 24 on Ubuntu and macOS.

Issues and contributions are welcome: [CONTRIBUTING.md](CONTRIBUTING.md).

## Roadmap

- **v0.1**: Local SQLite ledger and CLI. Released.
- **v0.2**: Authenticated HTTP API. Released.
- **v0.3**: Durable outbox and signed webhook worker. Current release.
- **v0.4**: Operator-controlled dead-letter recovery and reconciliation.
- **v0.5**: External connectors and integration tests.
- **v0.6**: Verifiable receipt documents.
- **v0.7**: Operations dashboard.
- **v0.8**: Framework adapters.
- **v0.9**: Deployment and security hardening.
- **v1.0**: Stable interfaces and production-readiness review.

MIT licensed. Maintained by [@kobrymoataz](https://github.com/kobrymoataz).
