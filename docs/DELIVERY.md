# Delivery engine

SubmissionLedger v0.3 introduces a persistent outbox next to the intake ledger. It is deliberately small enough to run on a single host without Redis, a broker or a hosted job queue.

## Data model

Schema v2 adds `delivery_spec_json` to `submissions` and two tables:

- `delivery_outbox` stores one job per `(submission_id, destination)`, current state, attempt count, schedule and a temporary lease token.
- `delivery_attempts` records each attempt, its final outcome, HTTP status (if known) and a short error category.

The acceptance event chain remains unchanged. Delivery history is operational state and is not part of the event hash chain. The outbox is not a legal or compliance-grade audit trail.

On initial intake, an optional `destinations` array is validated against the API's configured target names. The submission, acceptance event and all requested outbox rows are committed in **one SQLite transaction**. If anything fails, the whole transaction is rolled back. For existing records, `enqueue`/`POST /v1/submissions/:id/deliveries` inserts one named delivery only once.

When retrying a submission with an `Idempotency-Key`, the original payload and original atomic destination set must match. Later manual deliveries do not alter that original contract.

## Delivery lifecycle

```text
pending  -> leased -> delivered
                 |-> retry -> leased -> ...
                 |-> dead
lease expires -> re-lease with new token, or dead if attempts exhausted
```

1. A worker selects a due job in an SQLite `BEGIN IMMEDIATE` transaction.
2. It increments the attempt count, writes an in-flight attempt and stores a lease token/deadline.
3. It sends a signed HTTP POST and awaits a response (by default 10-second timeout).
4. A 2xx status is success; a retryable status or network failure schedules another attempt; a permanent failure moves the job to `dead`.
5. The completion transaction verifies the lease token. A stale worker cannot overwrite a newer worker's outcome.

Workers use a 30-second lease by default. Lease duration must exceed the HTTP timeout by at least three seconds. If a process dies after sending but before recording success, the lease expires and a later worker retries. This means **at least once** delivery: the receiver must be idempotent.

## Retry policy

Default maximum: five attempts. Backoff is 5, 10, 20, 40 seconds (then longer if max attempts is raised, capped at 15 minutes). An HTTP `Retry-After` delay can increase the next wait up to one hour.

Retryable: HTTP 408, 425, 429, 5xx, timeout, connection errors. Other responses (including redirects) are terminal failures. Redirects are never followed. Response bodies are never retained or printed. Dead deliveries require deliberate operator action; v0.3 has no automatic dead-letter replay.

## Webhook request

```http
POST /endpoint HTTP/1.1
Content-Type: application/json
X-SubmissionLedger-Event: submission.accepted
X-SubmissionLedger-Delivery-Id: <stable job UUID>
X-SubmissionLedger-Attempt: 1
X-SubmissionLedger-Signature: sha256=<lowercase hex HMAC>
```

Example body:

```json
{
  "event": "submission.accepted",
  "deliveryId": "<stable job UUID>",
  "submission": {
    "id": "<submission UUID>",
    "source": "website",
    "receivedAt": "2026-10-21T12:00:00.000Z",
    "payloadSha256": "<digest>",
    "payload": { "reference": "A-001" }
  }
}
```

Signature: `HMAC-SHA256(secret, raw_request_body_utf8)`, prefixed by `sha256=`. Use a constant-time comparison on the receiver and deduplicate the stable delivery ID. Attempts of the same delivery use the same ID and body, with different attempt header values. A timestamp or replay-window signature scheme is not yet provided, so the receiver must keep its own deduplication store.

## Configuration

Targets live in a JSON file controlled by the operator. Only destination names are stored in the outbox.

```json
{
  "destinations": {
    "audit": {
      "url": "https://hooks.example.com/submissions",
      "secretEnv": "SL_AUDIT_SIGNING_SECRET"
    }
  }
}
```

Set `SUBMISSIONLEDGER_DELIVERY_CONFIG` for the API, and supply the same config path to the worker through `--config` or the variable. The worker reads signing secrets from environment variables; they must be at least 32 UTF-8 bytes. Keep them out of the repository and CI logs. Production targets must be HTTPS. `--allow-local-http` enables **only** loopback HTTP for local testing; the API uses `SUBMISSIONLEDGER_ALLOW_LOCAL_HTTP=1` for the same purpose. HTTP redirects are not followed.

```bash
export SUBMISSIONLEDGER_DELIVERY_CONFIG="$PWD/examples/webhooks.local.json"
export SL_DEMO_SIGNING_SECRET="$(cat "$HOME/.config/submissionledger/demo-secret")"
npm run worker -- --config "$SUBMISSIONLEDGER_DELIVERY_CONFIG" --allow-local-http --once
```

No background service manager is supplied in v0.3. For continuous delivery, keep `npm run worker -- --config ...` running under a supervisor you control.

## Migrating from v0.2

V0.2 uses `PRAGMA user_version = 1`. V0.3 uses schema version 2. `npm run cli -- init` creates the new tables, adds `delivery_spec_json` with default `[]`, and updates `user_version` in one transaction. It does not rewrite old submission payloads or acceptance hashes.

**Back up before migration:** stop the API and all workers, then use SQLite's online backup mechanism. macOS normally includes `sqlite3`:

```bash
cd ~/Developer/submissionledger
mkdir -p "$HOME/.config/submissionledger/backups"
sqlite3 .submissionledger/ledger.sqlite \
  ".backup '$HOME/.config/submissionledger/backups/ledger-before-v03.sqlite'"

npm run cli -- init
npm run cli -- verify
```

The backup is a one-time example path: use a different filename if it already exists. The backup may contain private submission data and must be protected. The source database must not be moved or replaced while the API/worker is running.

A v0.2 executable cannot open the migrated v2 database. Keep your backup if you need to roll back the application.

## Operational boundaries

- Delivery jobs and attempts are not currently included in JSONL `export` or `verify` output.
- SQLite WAL mode supports multiple processes on the same host. Do not rely on this design for multi-host network filesystem databases.
- If a configured destination is removed, its pending jobs remain stored but cannot be claimed until that destination is restored to the configuration.
- The API does not start a worker. Use a separate process.
- Offset pagination is best effort under concurrent inserts.
- This release does not include dead-letter replay, per-destination rate limits, role-based permissions or a hosted dashboard.
