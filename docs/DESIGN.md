# Design notes

SubmissionLedger is a local-first TypeScript service using Node's built-in SQLite support.

## Core operations

The intake flow validates JSON, normalizes it deterministically and computes a SHA-256 hash. An explicit idempotency key is unique within its source. A single SQLite transaction stores the submission, its acceptance event and optionally the queued outbox rows. Replay responses do not add another acceptance event. The original delivery destination set is stored separately from mutable operational delivery records.

The event log uses SHA-256 links to detect accidental modifications. It is not protected by an independent trust anchor; a privileged editor could rewrite the local chain. `verify` and JSONL export continue to cover **only** submissions and acceptance events.

## HTTP boundary

The REST server uses Node's HTTP primitives. It requires a single bearer token for `/v1` requests, validates request bodies and enforces size limits. By default it only binds to loopback. All new delivery routes follow the v0.2 response envelope and use only operator-configured destinations.

## Outbox

SQLite schema v2 adds one outbox job per submission/destination and an attempt table. Jobs are leased transactionally with `BEGIN IMMEDIATE`, providing basic competing-worker safety on a single SQLite host. A lease token fences stale completion writes. Expired leases may be reclaimed and delivered again, so a remote receiver must deduplicate by the stable delivery ID.

The worker signs outbound JSON with HMAC-SHA256, requires HTTPS except explicitly allowed loopback HTTP, and never follows redirects or saves response bodies. `Retry-After` and exponential backoff govern bounded retries, with dead jobs retained for operator inspection. The worker is independently deployable and cannot be replaced with the API's HTTP process without changing the concurrency model.

Read [DELIVERY.md](DELIVERY.md) for the wire format, failure behavior and migration instructions.

## Not implemented

No distributed consensus, multi-tenant access control, encrypted storage, email transport, automatic dead-letter replay, per-destination rate limits, hosted dashboard, retention scheduler or production readiness certification is provided at this stage.
