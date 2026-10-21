# Command-line reference

Build with `npm run build`, then invoke `npm run cli -- <command>`. The commands use the same database as the API/worker and accept `--db PATH` or `SUBMISSIONLEDGER_DB`.

## Intake and inspection

```bash
npm run cli -- init
npm run cli -- submit --file examples/application.json --source website --key application-001
npm run cli -- list --limit 20
npm run cli -- get YOUR_SUBMISSION_UUID
npm run cli -- stats
npm run cli -- verify
npm run cli -- export --output ./backups/submissions.jsonl
```

`init` creates or migrates the schema. Back up existing v0.2 databases before calling it in v0.3. `submit` accepts `--data JSON` instead of `--file PATH`. `--key` is optional; without it, repeats create distinct submissions. `--json` is available on the CLI.

## Queue deliveries

The destination must be present in your operator-managed JSON configuration:

```bash
npm run cli -- submit --file examples/application.json --source website \
  --key application-002 --deliver-to demo \
  --config examples/webhooks.local.json --allow-local-http
```

To queue an already accepted submission:

```bash
npm run cli -- enqueue --submission YOUR_SUBMISSION_UUID --destination demo \
  --config examples/webhooks.local.json --allow-local-http
```

The `--deliver-to` argument is a comma-separated list of names, not URLs. Queueing the same submission/destination pair twice returns the existing job.

## Delivery operations

```bash
npm run cli -- deliveries
npm run cli -- deliveries --status retry --limit 20 --offset 0
npm run cli -- delivery YOUR_DELIVERY_UUID
npm run cli -- delivery-stats
```

## Worker

```bash
export SL_DEMO_SIGNING_SECRET="$(cat "$HOME/.config/submissionledger/demo-secret")"
npm run worker -- --config examples/webhooks.local.json --allow-local-http --once
```

Omit `--once` to poll continuously. Worker options include `--db`, `--poll-ms`, `--timeout-ms`, `--lease-ms` and `--max-batch`. See [delivery details](DELIVERY.md).
