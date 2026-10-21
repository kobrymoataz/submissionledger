# Changelog

## [0.1.0] - 2026-10-21

Initial public release.

- Store JSON submissions locally using SQLite transactions.
- Scope optional idempotency keys to their source.
- Return the original submission on an exact retry and reject key conflicts.
- Record an acceptance event with a linked SHA-256 digest for new submissions.
- Add CLI commands for intake, inspection, counts and verification.
- Export verified records as JSON Lines without overwriting existing files.
- Add automated tests and GitHub Actions CI.

The API, schema and CLI output formats may change before v1.0.
