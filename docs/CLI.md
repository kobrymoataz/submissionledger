# Command-line reference

Examples assume dependencies have been installed and the project has been compiled (`npm ci && npm run build`). Replace `npm run cli --` with `submissionledger` if you install the package as a CLI.

## Initialize

```bash
npm run cli -- init
npm run cli -- init --db ./work/intake.sqlite
```

Re-running `init` on an existing SubmissionLedger database is safe. An unfamiliar nonempty database is rejected.

## Accept submissions

```bash
npm run cli -- submit \
  --file ./examples/application.json \
  --source admissions \
  --key admission-2026-001 \
  --json
```

For small manual tests, inline JSON works:

```bash
npm run cli -- submit --data '{"interest":"data engineering"}'
```

The JSON root must be an object, not an array or string. The canonical payload has a 64 KiB limit; input files have a 256 KiB raw size limit.

## Inspect

```bash
npm run cli -- list --limit 10
npm run cli -- list --source admissions --json
npm run cli -- get SUBMISSION_ID
npm run cli -- stats --json
```

`get` shows the full payload. Treat CLI output as potentially sensitive.

## Check and export

```bash
npm run cli -- verify --json
npm run cli -- export --output ./private-backups/ledger.jsonl
```

The export writes a manifest line, followed by submission lines and event lines. It will not overwrite an existing file. The export is refused when integrity checks fail.

## Database location

By default, the database is created in `./.submissionledger/ledger.sqlite`, relative to the current working directory. You can also set an environment variable:

```bash
export SUBMISSIONLEDGER_DB="$HOME/ledger-data/intake.sqlite"
npm run cli -- init
npm run cli -- stats
```

`--db PATH` overrides the environment variable for that command.

## Exit statuses

- `0`: command completed; a replay of an identical request is also successful
- `1`: general error, or `verify` found integrity problems
- `2`: invalid command, input, parameters, or missing ledger
- `3`: idempotency key conflict (same source/key, different payload)

Human output is the default. Use `--json` for programmatic consumers. Exceptions are printed without a stack trace unless `SUBMISSIONLEDGER_DEBUG=1` is set.
