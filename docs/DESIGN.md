# Design and limitations

## Scope in v0.1

This release is a synchronous, local command-line tool. A submission is a JSON object of at most 64 KiB after canonical serialization. It is stored in SQLite together with a source namespace, a receipt ID and a SHA-256 digest. Each new submission creates one acceptance event in the same database transaction.

The CLI does not run a server or schedule email/webhook delivery. Future versions may add those as separate, durable operations.

## Retry semantics

Idempotency is scoped to `(source, key)`:

1. No key: every call creates a new submission, including identical payloads.
2. New key: persist the submission and an event atomically.
3. Known key, identical canonical JSON: return the original ID with `outcome: replayed`.
4. Known key, different JSON: report a conflict without overwriting the original.

JSON object keys are sorted recursively for comparisons. Array order and string contents remain significant. Only JSON objects are accepted as submissions. The key must be supplied by the caller; a content hash is not used as a deduplication key.

For a browser form, generate the key once per user action and reuse it only for retries of that action. Do not use a constant key for all visitors.

## SQLite

The schema is versioned through `PRAGMA user_version`. Release v0.1 supports schema version 1. SQLite transactions ensure the submission row and its acceptance event either both commit or neither commits. WAL allows practical local reads and writes. The tool sets a 5-second SQLite busy timeout to handle brief write contention.

A database created by a newer schema version is rejected rather than silently downgraded. Import and migration tools are not implemented yet.

## Event history

Events are ordered by an integer sequence. Each event stores:

- event ID, linked submission ID and event type
- event metadata (source, key and payload digest)
- timestamp in UTC
- previous event hash and current hash

`verify` checks stored payload digests, event digests, hash links, event-to-submission consistency, missing acceptance events, and SQLite's integrity and foreign-key checks.

**Not an external trust anchor:** a person with write access can modify records and calculate new hashes. The current design provides a way to discover accidental corruption, not cryptographic proof of authorship, time or non-repudiation.

## Security and privacy

- This release does **not** encrypt payloads at rest. The SQLite file and JSONL exports may contain personal information.
- Database contents never leave the machine through SubmissionLedger; npm and GitHub tooling have their own network behavior.
- `list` hides payload bodies, but `get` and `export` expose them to the local operator.
- Secure access to the host, directory, databases, backups and terminal history with operating-system controls.
- `.gitignore` excludes ledger databases and JSONL files, but do not rely on `.gitignore` as a complete data loss prevention tool.
- Do not store passwords, access tokens, payment card data or unnecessary personal information in submissions.
- No user authentication, access control, record deletion/retention workflow, consent management or legal compliance guarantees are provided.

If you need a multi-user intake service or regulated data processing, v0.1 is not sufficient by itself.

## Known limits

- The JSONL export is produced in memory, so it is intended for small ledgers. Large-data streaming exports are future work.
- Timestamps come from the local system clock; they are not independently attested.
- No import/restore command exists yet.
- SQLite's `node:sqlite` module is marked experimental on some supported Node versions.
- No background scheduler, recovery queue or remote delivery exists in this release.
