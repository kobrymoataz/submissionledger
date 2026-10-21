import type { LedgerStats, Submission, SubmissionSummary, SubmitResult } from '../core/types.js';

export function printValue(value: unknown, asJson: boolean): void {
  if (asJson) console.log(JSON.stringify(value, null, 2));
}

export function printSubmission(result: SubmitResult, asJson: boolean): void {
  if (asJson) return printValue(result, true);
  const { submission, outcome } = result;
  console.log(outcome === 'accepted' ? 'Submission accepted.' : 'Submission already recorded (idempotent replay).');
  console.log(`  ID:      ${submission.id}`);
  console.log(`  Source:  ${submission.source}`);
  console.log(`  Key:     ${submission.idempotencyKey ?? '(none)'}`);
  console.log(`  SHA-256: ${submission.payloadSha256}`);
  console.log(`  Time:    ${submission.receivedAt}`);
}

export function printSubmissionDetails(submission: Submission, asJson: boolean): void {
  if (asJson) return printValue(submission, true);
  console.log(`Submission: ${submission.id}`);
  console.log(`Source:     ${submission.source}`);
  console.log(`Key:        ${submission.idempotencyKey ?? '(none)'}`);
  console.log(`Received:   ${submission.receivedAt}`);
  console.log(`SHA-256:    ${submission.payloadSha256}`);
  console.log('Payload:');
  console.log(JSON.stringify(submission.payload, null, 2));
}

export function printSubmissionList(submissions: SubmissionSummary[], asJson: boolean): void {
  if (asJson) return printValue(submissions, true);
  if (submissions.length === 0) {
    console.log('No submissions found.');
    return;
  }
  console.log(`${'ID'.padEnd(38)} ${'SOURCE'.padEnd(18)} RECEIVED (UTC)`);
  for (const submission of submissions) {
    console.log(`${submission.id.padEnd(38)} ${submission.source.slice(0, 18).padEnd(18)} ${submission.receivedAt}`);
  }
}

export function printStats(stats: LedgerStats, asJson: boolean): void {
  if (asJson) return printValue(stats, true);
  console.log(`Submissions:       ${stats.submissions}`);
  console.log(`Recorded events:   ${stats.events}`);
  console.log(`With replay keys:  ${stats.withIdempotencyKey}`);
  if (stats.bySource.length > 0) {
    console.log('Sources:');
    for (const source of stats.bySource) console.log(`  ${source.source}: ${source.count}`);
  }
}
