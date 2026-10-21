# Contributing

Thanks for considering a contribution. Changes that make the existing contract clearer or more reliable are especially welcome.

## Local checks

Use Node.js 22.13 or newer, preferably Node 24.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

The HTTP tests start short-lived local servers with temporary SQLite files. No external database or internet connection is needed after dependencies are installed.

## Pull requests

1. Branch from `main` and keep the change focused.
2. Include a regression test for behavior changes. For API changes, cover HTTP status codes and authentication.
3. Update the documentation and OpenAPI definition if the endpoint contract changes.
4. Run the checks and describe any compatibility concerns in the pull request.

A schema change needs an explicit migration plan. Do not commit real submissions, local SQLite files, bearer tokens, backups or other private data.

Before submitting large feature proposals, open an issue so maintainers can discuss scope and expected behavior.
