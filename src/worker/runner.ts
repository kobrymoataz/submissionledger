import { createHmac } from 'node:crypto';
import type { DispatchResult } from '../ledger/dispatch.js';
import { claimDueDelivery, finishDelivery } from '../ledger/dispatch.js';
import { getSubmission } from '../ledger/submissions.js';
import type { WebhookConfig } from './config.js';
import { signingSecrets } from './config.js';
import { InputError } from '../core/errors.js';

export interface WorkerOptions {
  dbPath: string;
  config: WebhookConfig;
  env?: NodeJS.ProcessEnv;
  maxBatch?: number;
  timeoutMs?: number;
  leaseMs?: number;
  now?: () => Date;
  transport?: typeof fetch;
  onDelivery?: (item: { id: string; destination: string; attempt: number; outcome: string }) => void;
}

export function retryAfterSeconds(value: string | null, now: Date): number | undefined {
  if (value === null) return undefined;
  if (/^\d{1,8}$/.test(value)) return Math.min(3600, Number(value));
  const absolute = Date.parse(value);
  if (!Number.isFinite(absolute)) return undefined;
  return Math.min(3600, Math.max(0, Math.ceil((absolute - now.getTime()) / 1000)));
}

export async function runDeliveryBatch(options: WorkerOptions): Promise<{
  processed: number; delivered: number; retried: number; dead: number; stale: number;
}> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const leaseMs = options.leaseMs ?? 30_000;
  const maxBatch = options.maxBatch ?? 20;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000 ||
      !Number.isInteger(leaseMs) || leaseMs < timeoutMs + 3000 || leaseMs > 600_000 ||
      !Number.isInteger(maxBatch) || maxBatch < 1 || maxBatch > 100) {
    throw new InputError('Invalid worker limits: timeout 100-60000ms, lease >= timeout+3000ms, maxBatch 1-100.');
  }
  const secrets = signingSecrets(options.config, options.env ?? process.env);
  const now = options.now ?? (() => new Date());
  const transport = options.transport ?? fetch;
  const names = Object.keys(options.config.destinations);
  const totals = { processed: 0, delivered: 0, retried: 0, dead: 0, stale: 0 };
  for (let index = 0; index < maxBatch; index += 1) {
    const job = claimDueDelivery(options.dbPath, names, { now: now(), leaseMs });
    if (!job) break;
    totals.processed += 1;
    const target = options.config.destinations[job.destination];
    const secret = secrets[job.destination];
    if (!target || !secret) throw new InputError('Unknown worker destination.');
    const submission = getSubmission(options.dbPath, job.submissionId);
    const body = JSON.stringify({
      event: 'submission.accepted', deliveryId: job.id,
      submission: { id: submission.id, source: submission.source,
        receivedAt: submission.receivedAt, payloadSha256: submission.payloadSha256, payload: submission.payload },
    });
    const signature = createHmac('sha256', secret).update(body).digest('hex');
    let outcome: DispatchResult;
    try {
      const response = await transport(target.url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'SubmissionLedger/0.3',
          'X-SubmissionLedger-Delivery-Id': job.id,
          'X-SubmissionLedger-Attempt': String(job.attempt),
          'X-SubmissionLedger-Signature': `sha256=${signature}`,
          'X-SubmissionLedger-Event': 'submission.accepted',
        },
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status >= 200 && response.status < 300) {
        outcome = { kind: 'success', httpStatus: response.status };
      } else {
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500;
        const retryAfter = retryAfterSeconds(response.headers.get('retry-after'), now());
        outcome = { kind: 'failure', httpStatus: response.status,
          errorCode: response.status >= 300 && response.status < 400 ? 'redirect_blocked' : `http_${response.status}`,
          retryable, ...(retryAfter === undefined ? {} : { retryAfterSeconds: retryAfter }) };
      }
      // Never inspect, log or persist the remote response body.
      await response.body?.cancel();
    } catch (error) {
      outcome = { kind: 'failure', httpStatus: null,
        errorCode: error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError') ?
          'request_timeout' : 'network_error', retryable: true };
    }
    const result = finishDelivery(options.dbPath, job, outcome, now());
    if (!result.applied) totals.stale += 1;
    else if (result.status === 'delivered') totals.delivered += 1;
    else if (result.status === 'retry') totals.retried += 1;
    else if (result.status === 'dead') totals.dead += 1;
    options.onDelivery?.({ id: job.id, destination: job.destination, attempt: job.attempt,
      outcome: result.applied ? result.status ?? 'unknown' : 'stale' });
  }
  return totals;
}
