# Security policy

SubmissionLedger stores submission payloads and delivers them to destinations that the operator configures. Treat it as a developer tool, not as a hosted service with a complete security perimeter.

## Reporting a vulnerability

Please do not publish credentials, personal data, private signing material or exploit details in a public issue. Use the repository's private security reporting mechanism if enabled, or contact the maintainer through the GitHub profile before sharing reproduction details.

## Deployment notes

- Use loopback binding for development. Put the API behind your own TLS reverse proxy, authentication, access control and rate limits before exposing it anywhere else. The built-in bearer token is not a user/role system.
- Set signing secrets of at least 32 bytes in the worker environment; never commit them. Protect access to the destination configuration and the worker host.
- Configure only trusted HTTPS destinations. `--allow-local-http` is explicitly for local loopback testing. HTTP redirects are blocked.
- Webhook messages contain the full submission payload. Use data minimization, retention limits and destination approval processes suitable for your environment.
- A receiver should verify the HMAC signature in constant time, accept repeated delivery IDs safely and apply its own replay and rate controls.
- Avoid uploading databases, WAL files or JSONL exports to public repositories. SQLite files are unencrypted.
- Worker logs only delivery ID, target name, attempt number and result. Do not add request/response body logging without a privacy review.
- `verify` checks the locally stored acceptance event chain; it does not certify an externally anchored audit trail or the mutable outbox.
- This release has no built-in authorization scopes, user account management, encryption at rest, rate limiting, disaster recovery or production readiness guarantee.
