# HTTP API reference (v0.2)

The API is intentionally narrow. It builds on the same SQLite schema and validation used by the CLI. There are no migrations from v0.1 to v0.2.

## Start locally

In the project directory, run `npm ci`, `npm run build` and `npm run cli -- init` before starting the server. The default URL is `http://127.0.0.1:8787`.

All `/v1` routes require `Authorization: Bearer <token>`; `/health` is unauthenticated. The environment variable `SUBMISSIONLEDGER_API_TOKEN` must contain a secret of at least 24 characters with no whitespace. Generate one with `openssl rand -hex 32`. Keep it out of Git and shell history. The same value must be available to your HTTP client.

- `SUBMISSIONLEDGER_DB`: SQLite database path. Default: `./.submissionledger/ledger.sqlite`.
- `SUBMISSIONLEDGER_API_HOST`: Bind address. Default: `127.0.0.1`.
- `SUBMISSIONLEDGER_API_PORT`: Port number, from 1 to 65535. Default: `8787`.

Do not bind to a public address without a reverse proxy providing HTTPS and appropriate network controls. Bearer tokens provide access to all submitted data; there are no user roles.

## POST /v1/submissions

Header `Content-Type: application/json` is required. Header `Idempotency-Key` is optional (1 to 128 characters). Body:

```json
{
  "source": "website",
  "payload": {
    "reference": "APP-1001",
    "name": "Example Applicant",
    "programme": "Computing"
  }
}
```

The `source` defaults to `api` if omitted. It is a namespace of 1 to 64 permitted characters. The `payload` must be a JSON object. Any top-level body keys other than `source` and `payload` are rejected.

An accepted submission returns HTTP `201`:

```json
{
  "data": {
    "outcome": "accepted",
    "submission": {
      "id": "05cc7b03-629d-49e2-9f83-598a5032dc2e",
      "source": "website",
      "idempotencyKey": "demo-001",
      "payload": {"reference": "APP-1001", "name": "Example Applicant", "programme": "Computing"},
      "payloadSha256": "<64 hexadecimal characters>",
      "receivedAt": "<ISO 8601 timestamp>"
    }
  },
  "requestId": "<request UUID>"
}
```

This response is illustrative. Identifiers, hashes and timestamps are generated at runtime.

Reusing `(source, Idempotency-Key)` with the same canonical payload returns HTTP `200`, `outcome: replayed`, the same submission ID, and `Idempotency-Replayed: true`. Reusing the pair with different payload data returns HTTP `409` without changing the record. No idempotency key means every POST creates a new submission.

## GET /v1/submissions

Optional query parameters:

| Parameter | Default | Allowed |
| --- | --- | --- |
| `source` | No filter | Source name (1 to 64 characters) |
| `limit` | 20 | Integer from 1 to 100 |
| `offset` | 0 | Integer from 0 to 10000 |

Response fields inside `data`: `items`, `limit`, `offset`, `hasMore`, `nextOffset`. An item includes `id`, `source`, `idempotencyKey`, `payloadSha256` and `receivedAt`. It does not contain the payload. `nextOffset` is `null` when there are no more records. Ordering is by receipt time descending, then ID descending.

Offset pagination is not a snapshot. New records can shift offsets between requests. Use exports for a stable historical view.

## GET /v1/submissions/:id

Requires an existing submission UUID. Responds with the same full `submission` fields returned by POST under `data`. A missing valid UUID returns HTTP `404` and `submission_not_found`.

## GET /v1/stats

Returns `submissions`, `events`, `withIdempotencyKey`, and `bySource`. The counts are queried from SQLite.

## GET /v1/ledger/verify

Runs a synchronous consistency check and returns `ok`, `submissions`, `events` and `issues`. `ok: false` is a valid HTTP `200` report; check this field rather than only the HTTP status. The endpoint can take longer on large databases. It is for operators, not a high-frequency health probe.

## GET /health

Returns basic process information, including the version. The route is public and does not inspect stored submissions. Use monitoring appropriate to your deployment for storage availability.

## Errors and tracing

Every response has an `X-Request-Id` header. JSON errors have the following shape:

```json
{
  "error": {
    "code": "idempotency_conflict",
    "message": "Idempotency key is already associated with different data."
  },
  "requestId": "<request UUID>"
}
```

Known errors:

- `400`: Invalid JSON, invalid UUID or query, missing body.
- `401`: No valid bearer token for a `/v1` route.
- `404`: Unrecognized endpoint or unknown submission.
- `405`: Wrong method. Check the `Allow` header.
- `409`: Idempotency key reused with different payload data.
- `413`: Raw request body exceeds 96 KiB.
- `415`: Unsupported media type or content encoding.
- `422`: Invalid submission fields, or normalized payload exceeds 64 KiB.
- `500` / `503`: Internal failure or unavailable ledger. Internal details are not returned.

Request logs contain an ID, method, status and duration. They do not include JSON request bodies or bearer tokens. The API does not set permissive CORS headers.
