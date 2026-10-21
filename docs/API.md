# HTTP API (v0.3)

The API listens at `127.0.0.1:8787` by default. Set `SUBMISSIONLEDGER_API_HOST`, `SUBMISSIONLEDGER_API_PORT`, `SUBMISSIONLEDGER_DB`, `SUBMISSIONLEDGER_API_TOKEN` and optionally `SUBMISSIONLEDGER_DELIVERY_CONFIG`. Every `/v1` route requires `Authorization: Bearer <token>`; `/health` is public.

The bearer token must be at least 24 characters. Use HTTPS and a reverse proxy if traffic ever leaves the host; the built-in listener is not intended for direct internet exposure.

## Create a submission

```http
POST /v1/submissions
Content-Type: application/json
Authorization: Bearer <token>
Idempotency-Key: application-001
```

```json
{
  "source": "website",
  "payload": { "reference": "A-100" },
  "destinations": ["audit"]
}
```

`destinations` is optional, must contain at most eight unique configured names, and must not contain arbitrary URLs. The API validates the entire request **before** a database transaction. The submission, acceptance event and outbox rows are committed together.

Status: `201` for a new submission, `200` for an identical idempotency replay, `409` for a key/payload/destination conflict, `422` for invalid fields or unconfigured destinations. `Location` points to the submission. The body is wrapped in `{ "data": ..., "requestId": "..." }` and retains the v0.2 acceptance response shape.

Without `Idempotency-Key`, identical POSTs are separate submissions. The idempotency key is scoped to `source`; replays must send the same original destination set, regardless of any later manual enqueues.

## Queue an existing submission

```http
POST /v1/submissions/:id/deliveries
Content-Type: application/json
Authorization: Bearer <token>
```

```json
{ "destination": "audit" }
```

Returns `201` for a newly queued job, `200` if that submission/destination pair was already queued, `404` for unknown submission IDs, and `422` for unconfigured destination names.

## Inspect delivery

| Route | Result |
| --- | --- |
| `GET /v1/deliveries` | `{items, total, hasMore, nextOffset}` (payloads excluded) |
| `GET /v1/deliveries?status=retry&limit=20&offset=0` | Filter by one status |
| `GET /v1/deliveries/stats` | Pending, leased, retry, delivered and dead counts |
| `GET /v1/deliveries/:id` | Delivery and the ordered attempt history |

Delivery statuses: `pending`, `leased`, `retry`, `delivered`, `dead`. Each job has a stable UUID and a destination name; no destination URLs or signing secrets are returned. Requests use standard `400`, `401`, `404`, `405` and `422` errors where relevant.

## Existing routes

The v0.2 routes remain available:

- `GET /health`: process-level health, public
- `GET /v1/submissions?source=website&limit=20&offset=0`: summary list
- `GET /v1/submissions/:id`: one submission with payload
- `GET /v1/stats`: intake statistics
- `GET /v1/ledger/verify`: acceptance event consistency check

The API has a 96 KiB raw request cap and the normalized payload has a 64 KiB limit. No browser CORS policy is enabled by default.

## Running the worker

The HTTP API **does not send webhooks by itself**. Run the worker as a separate process using the same SQLite path and destination configuration. See [Delivery engine](DELIVERY.md).
