import type { IncomingMessage, ServerResponse } from 'node:http';
import { InputError } from '../core/errors.js';
import { deliveryStats, getDelivery, listDeliveryAttempts, pageDeliveries, queueSubmissionDelivery, validateDestinations, validateDestination } from '../ledger/delivery.js';
import type { DeliveryStatus } from '../ledger/delivery.js';
import type { SubmitInput } from '../core/types.js';
import { acceptSubmission, getSubmission, ledgerStats, pageSubmissions } from '../ledger/submissions.js';
import { verifyLedger } from '../ledger/verification.js';
import { HttpError } from './errors.js';
import { ensureMethod, ok, readJsonBody } from './transport.js';
import type { RequestContext } from './transport.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function parseIntake(value: unknown, request: IncomingMessage, allowed: ReadonlySet<string>): SubmitInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new HttpError(422, 'invalid_body', 'Expected a JSON object with source and payload.');
  }
  const input = value as Record<string, unknown>;
  if (!Object.hasOwn(input, 'payload') || Object.keys(input).some((key) => key !== 'source' && key !== 'payload' && key !== 'destinations')) {
    throw new HttpError(422, 'invalid_body', 'Only source, payload and destinations are accepted; payload is required.');
  }
  if (input.source !== undefined && typeof input.source !== 'string') {
    throw new HttpError(422, 'invalid_source', 'Source must be a string.');
  }
  const header = request.headers['idempotency-key'];
  if (Array.isArray(header)) throw new HttpError(400, 'invalid_header', 'Supply one Idempotency-Key header.');
  const result: SubmitInput = { payload: input.payload, source: typeof input.source === 'string' ? input.source : 'api' };
  if (header !== undefined) result.idempotencyKey = header;
  if (Object.hasOwn(input, 'destinations')) {
    const destinations = validateDestinations(input.destinations);
    for (const name of destinations) {
      if (!allowed.has(name)) throw new HttpError(422, 'unknown_destination', `Destination '${name}' is not configured.`);
    }
    result.destinations = destinations;
  }
  return result;
}

export async function handleRoutes(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
  dbPath: string,
  allowedDestinations: ReadonlySet<string> = new Set(),
): Promise<void> {
  const pathname = context.url.pathname;
  if (pathname === '/v1/submissions') {
    if (request.method === 'POST') {
      if (context.url.search) throw new HttpError(400, 'invalid_query', 'POST does not accept query parameters.');
      const input = parseIntake(await readJsonBody(request), request, allowedDestinations);
      const result = acceptSubmission(dbPath, input);
      ok(response, context, result.outcome === 'accepted' ? 201 : 200, result,
        { Location: `/v1/submissions/${result.submission.id}`, 'Idempotency-Replayed': result.outcome === 'replayed' ? 'true' : 'false' });
      return;
    }
    ensureMethod(request.method, 'GET');
    const query = context.url.searchParams;
    for (const key of query.keys()) {
      if (key !== 'source' && key !== 'limit' && key !== 'offset') throw new HttpError(400, 'invalid_query', `Unknown query parameter: ${key}.`);
      if (query.getAll(key).length !== 1) throw new HttpError(400, 'invalid_query', `Duplicate query parameter: ${key}.`);
    }
    const rawLimit = query.get('limit');
    if (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) {
      throw new HttpError(400, 'invalid_query', 'Limit must be a whole number between 1 and 100.');
    }
    const rawOffset = query.get('offset');
    if (rawOffset !== null && !/^(0|[1-9]\d*)$/.test(rawOffset)) {
      throw new HttpError(400, 'invalid_query', 'Offset must be a whole number from 0 to 10000.');
    }
    const options: { source?: string; limit?: number; offset?: number } = {};
    if (rawLimit !== null) options.limit = Number(rawLimit);
    if (rawOffset !== null) options.offset = Number(rawOffset);
    if (query.has('source')) options.source = query.get('source') ?? '';
    const page = pageSubmissions(dbPath, options);
    ok(response, context, 200, page);
    return;
  }

  if (pathname === '/v1/stats' || pathname === '/v1/ledger/verify') {
    ensureMethod(request.method, 'GET');
    if (context.url.search) throw new HttpError(400, 'invalid_query', 'This endpoint does not accept query parameters.');
    const result = pathname === '/v1/stats' ? ledgerStats(dbPath) : verifyLedger(dbPath);
    ok(response, context, 200, result);
    return;
  }

  if (pathname === '/v1/deliveries/stats') {
    ensureMethod(request.method, 'GET');
    if (context.url.search) throw new HttpError(400, 'invalid_query', 'Query parameters are not supported.');
    ok(response, context, 200, deliveryStats(dbPath));
    return;
  }

  if (pathname === '/v1/deliveries') {
    ensureMethod(request.method, 'GET');
    const query = context.url.searchParams;
    for (const key of query.keys()) {
      if (!['status', 'limit', 'offset'].includes(key) || query.getAll(key).length !== 1) {
        throw new HttpError(400, 'invalid_query', 'Unexpected or repeated delivery query parameter.');
      }
    }
    const rawLimit = query.get('limit');
    const rawOffset = query.get('offset');
    if (rawLimit !== null && !/^[1-9]\d*$/.test(rawLimit)) throw new HttpError(400, 'invalid_query', 'Invalid limit.');
    if (rawOffset !== null && !/^(0|[1-9]\d*)$/.test(rawOffset)) throw new HttpError(400, 'invalid_query', 'Invalid offset.');
    const options: { status?: DeliveryStatus; limit?: number; offset?: number } = {};
    if (rawLimit !== null) options.limit = Number(rawLimit);
    if (rawOffset !== null) options.offset = Number(rawOffset);
    if (query.has('status')) options.status = query.get('status') as DeliveryStatus;
    ok(response, context, 200, pageDeliveries(dbPath, options));
    return;
  }

  const deliveryMatch = /^\/v1\/deliveries\/([^/]+)$/.exec(pathname);
  if (deliveryMatch) {
    ensureMethod(request.method, 'GET');
    if (context.url.search) throw new HttpError(400, 'invalid_query', 'Query parameters are not supported.');
    const id = deliveryMatch[1] ?? '';
    if (!UUID_RE.test(id)) throw new HttpError(400, 'invalid_id', 'Expected a delivery UUID.');
    const delivery = getDelivery(dbPath, id);
    if (!delivery) throw new HttpError(404, 'delivery_not_found', 'Delivery not found.');
    ok(response, context, 200, { delivery, attempts: listDeliveryAttempts(dbPath, id) });
    return;
  }

  const queueMatch = /^\/v1\/submissions\/([^/]+)\/deliveries$/.exec(pathname);
  if (queueMatch) {
    ensureMethod(request.method, 'POST');
    if (context.url.search) throw new HttpError(400, 'invalid_query', 'Query parameters are not supported.');
    const id = queueMatch[1] ?? '';
    if (!UUID_RE.test(id)) throw new HttpError(400, 'invalid_id', 'Expected a submission UUID.');
    const body = await readJsonBody(request);
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).join(',') !== 'destination') {
      throw new HttpError(422, 'invalid_body', 'Expected {"destination":"name"}.');
    }
    const destination = validateDestination((body as { destination: unknown }).destination);
    if (!allowedDestinations.has(destination)) {
      throw new HttpError(422, 'unknown_destination', `Destination '${destination}' is not configured.`);
    }
    try {
      const queued = queueSubmissionDelivery(dbPath, id, destination);
      ok(response, context, queued.created ? 201 : 200, queued);
    } catch (error) {
      if (error instanceof InputError && error.message === 'Submission not found.') {
        throw new HttpError(404, 'submission_not_found', 'Submission not found.');
      }
      throw error;
    }
    return;
  }

  const single = /^\/v1\/submissions\/([^/]+)$/.exec(pathname);
  if (single) {
    ensureMethod(request.method, 'GET');
    if (context.url.search) throw new HttpError(400, 'invalid_query', 'This endpoint does not accept query parameters.');
    const id = single[1] ?? '';
    if (!UUID_RE.test(id)) throw new HttpError(400, 'invalid_id', 'Expected a submission UUID.');
    try {
      ok(response, context, 200, getSubmission(dbPath, id));
    } catch (error) {
      if (error instanceof InputError && error.message.startsWith('Submission not found:')) {
        throw new HttpError(404, 'submission_not_found', 'Submission not found.');
      }
      throw error;
    }
    return;
  }
  throw new HttpError(404, 'not_found', 'Endpoint not found.');
}
