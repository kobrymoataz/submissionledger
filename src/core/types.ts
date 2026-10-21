export type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;

export interface JsonObject {
  [key: string]: JsonValue;
}

export interface Submission {
  id: string;
  source: string;
  idempotencyKey: string | null;
  payload: JsonObject;
  payloadSha256: string;
  receivedAt: string;
}

export type SubmissionSummary = Omit<Submission, 'payload'>;

export interface SubmitInput {
  payload: unknown;
  source?: string;
  idempotencyKey?: string;
}

export interface SubmitResult {
  outcome: 'accepted' | 'replayed';
  submission: Submission;
}

export interface LedgerStats {
  submissions: number;
  events: number;
  withIdempotencyKey: number;
  bySource: Array<{ source: string; count: number }>;
}
