# Changelog

All notable changes to SubmissionLedger are documented here. Releases follow semantic versioning while the public API is still under active development.

## [0.3.0] - 2026-10-21

### Added
- Persistent SQLite outbox, dispatch attempt history and schema v1 to v2 migration.
- Atomic destination scheduling at intake and manual enqueue for existing submissions.
- Signed webhook POST delivery with a standalone worker, lease recovery, fencing and bounded retries.
- Delivery API endpoints, CLI commands, local example receiver and deployment guidance.
- New integration tests for retries, delivery signatures, data compatibility and HTTP routes.

### Notes
- Outbound delivery is at least once; receivers should deduplicate delivery IDs.
- The `verify` command and JSONL export cover the intake event ledger, not mutable delivery state.
- Back up old SQLite databases before migrating. Rollback needs the backup.

## [0.2.0] - 2026-10-21

- Local authenticated HTTP API, request IDs, paging, validation and health endpoint.

## [0.1.0] - 2026-10-21

- Local SQLite intake, idempotency, CLI, linked event hashes and JSONL export.
