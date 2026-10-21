# Changelog

All notable releases are recorded here. Version numbers follow semantic versioning during the pre-v1 period.

## 0.2.0 - HTTP intake

- Added a bearer-token-protected HTTP API using the built-in Node.js HTTP server.
- Added JSON submission intake, replay reporting and conflict status codes.
- Added record retrieval, filtered pagination, statistics and ledger verification routes.
- Added request identifiers, bounded request bodies, restricted content types and explicit error responses.
- Kept the existing SQLite schema and CLI commands compatible with v0.1 data.
- Added API integration tests, examples, an OpenAPI document and operation notes.

## 0.1.0 - Local ledger

- Added SQLite intake, canonical JSON normalization and caller-provided idempotency keys.
- Added the command-line interface, audit event chain, integrity checks and JSONL export.
- Added basic regression tests, CI and contribution guidelines.
