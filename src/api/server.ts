import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { ConflictError, InputError, LedgerError } from '../core/errors.js';
import { ledgerStats } from '../ledger/submissions.js';
import { VERSION } from '../version.js';
import { HttpError } from './errors.js';
import { requireBearer, validateApiToken } from './security.js';
import { createContext, ensureMethod, fail, ok } from './transport.js';

export interface ApiLog {
  requestId: string;
  method: string;
  status: number;
  durationMs: number;
}

export interface ApiOptions {
  dbPath: string;
  token: string;
  onRequest?: (entry: ApiLog) => void;
}

export function createApiServer(options: ApiOptions): Server {
  const token = validateApiToken(options.token);
  // Fail at startup if the database has not been initialized or has an unsupported schema.
  ledgerStats(options.dbPath);

  const server = createServer(async (request, response) => {
    const started = performance.now();
    let requestId: string = randomUUID();
    response.once('finish', () => {
      options.onRequest?.({
        requestId,
        method: request.method ?? 'UNKNOWN',
        status: response.statusCode,
        durationMs: Math.round(performance.now() - started),
      });
    });
    try {
      const context = createContext(request);
      requestId = context.requestId;
      const pathname = context.url.pathname;
      if (pathname === '/health') {
        ensureMethod(request.method, 'GET');
        ok(response, context, 200, { service: 'submissionledger', version: VERSION, status: 'ok' });
        return;
      }
      if (pathname === '/v1' || pathname.startsWith('/v1/')) {
        requireBearer(request, token);
      }
      throw new HttpError(404, 'not_found', 'Endpoint not found.');
    } catch (error) {
      if (response.headersSent) return;
      if (error instanceof HttpError) fail(response, requestId, error);
      else if (error instanceof ConflictError) fail(response, requestId, new HttpError(409, 'idempotency_conflict', error.message));
      else if (error instanceof InputError) fail(response, requestId, new HttpError(422, 'invalid_input', error.message));
      else if (error instanceof LedgerError) fail(response, requestId, new HttpError(503, 'ledger_unavailable', 'Ledger operation could not be completed.'));
      else fail(response, requestId, new HttpError(500, 'internal_error', 'Internal server error.'));
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}
