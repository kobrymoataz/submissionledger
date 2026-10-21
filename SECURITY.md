# Security policy

SubmissionLedger v0.2 is an early local-first release. It is not intended to be exposed directly to the Internet as an unaudited production intake service. Read [design and limitations](docs/DESIGN.md) and [API reference](docs/API.md) before storing real data.

## Threat boundaries

- The HTTP service binds to `127.0.0.1` by default and requires a bearer token for all `/v1` endpoints. Treat the token as a password because it grants access to all payloads.
- The built-in server serves HTTP, not HTTPS. If exposed outside localhost, put it behind a correctly configured TLS reverse proxy and network access controls. A token alone does not make a public deployment safe.
- There is no per-user access policy, login, rate limiting, encryption at rest, retention schedule or secure secret store.
- SQLite files and exports can contain personal data. Keep them in protected directories and never commit them to Git.
- Hash chaining helps identify inconsistent data; anyone able to edit the entire database can recompute the hashes. The ledger does not provide independently verifiable proof of authenticity.

## Reporting vulnerabilities

Do not post exploit details, tokens or private submissions in a public GitHub issue. Use GitHub private vulnerability reporting when enabled, or open a minimal issue requesting a private contact channel without including technical exploit details.

## Supported versions

Only the latest release line is maintained during the pre-v1 period. No long-term support commitment is offered.
