# Contributing

Thanks for considering a contribution.

SubmissionLedger is deliberately small at this stage. Before proposing a large feature, open an issue to discuss the scope and expected behavior.

## Setup

Node.js 22.13 or newer is required. Node 24 is recommended.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

## Pull requests

1. Create a short branch from `main`.
2. Keep the change focused and add a regression test when fixing a bug.
3. Update the relevant documentation if a command or behavior changes.
4. Run the checks above, then open a pull request with a brief explanation and manual reproduction steps.

If you change the database schema, describe migrations and compatibility before implementation. Never commit live submissions, tokens or personal data.

Contributions are reviewed for correctness, clarity and their effect on the local-first model.
