import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './errors.js';

export const MAX_HTTP_BODY_BYTES = 96 * 1024;

export interface RequestContext {
  readonly requestId: string;
  readonly url: URL;
}

export function createContext(request: IncomingMessage): RequestContext {
  const raw = request.url ?? '';
  if (!raw.startsWith('/') || raw.startsWith('//')) {
    throw new HttpError(400, 'invalid_target', 'The request target must be a relative path.');
  }
  let url: URL;
  try {
    url = new URL(raw, 'http://localhost');
  } catch {
    throw new HttpError(400, 'invalid_target', 'The request URL is invalid.');
  }
  return { requestId: randomUUID(), url };
}

export function respond(
  response: ServerResponse,
  requestId: string,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const encoded = Buffer.from(JSON.stringify(body), 'utf8');
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(encoded.length),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Request-Id': requestId,
    ...headers,
  });
  response.end(encoded);
}

export function ok(response: ServerResponse, context: RequestContext, status: number, data: unknown,
  headers: Record<string, string> = {}): void {
  respond(response, context.requestId, status, { data, requestId: context.requestId }, headers);
}

export function fail(response: ServerResponse, requestId: string, error: HttpError): void {
  respond(response, requestId, error.status, {
    error: { code: error.code, message: error.message },
    requestId,
  }, error.headers);
}

export function ensureMethod(actual: string | undefined, expected: string): void {
  if (actual !== expected) {
    throw new HttpError(405, 'method_not_allowed', `Use ${expected} for this endpoint.`, { Allow: expected });
  }
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const contentType = request.headers['content-type'];
  if (typeof contentType !== 'string' ||
      !/^application\/json(?:\s*;\s*charset=utf-8)?\s*$/i.test(contentType)) {
    throw new HttpError(415, 'unsupported_media_type', 'Send Content-Type: application/json.');
  }
  if (request.headers['content-encoding'] && request.headers['content-encoding'] !== 'identity') {
    throw new HttpError(415, 'unsupported_content_encoding', 'Compressed request bodies are not supported.');
  }
  const lengthHeader = request.headers['content-length'];
  if (lengthHeader && Number(lengthHeader) > MAX_HTTP_BODY_BYTES) {
    throw new HttpError(413, 'body_too_large', 'The request body exceeds 96 KiB.', { Connection: 'close' });
  }
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunk of request) {
      const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      bytes += part.length;
      if (bytes > MAX_HTTP_BODY_BYTES) {
        throw new HttpError(413, 'body_too_large', 'The request body exceeds 96 KiB.', { Connection: 'close' });
      }
      chunks.push(part);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, 'incomplete_body', 'Could not read the complete request body.');
  }
  if (!bytes) throw new HttpError(400, 'empty_body', 'A JSON body is required.');
  try {
    return JSON.parse(Buffer.concat(chunks, bytes).toString('utf8')) as unknown;
  } catch {
    throw new HttpError(400, 'invalid_json', 'The request body is not valid JSON.');
  }
}
