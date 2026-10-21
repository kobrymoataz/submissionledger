import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { HttpError } from './errors.js';

export function validateApiToken(token: string | undefined): string {
  if (!token || token.length < 24 || token.length > 512 || /\s/.test(token)) {
    throw new Error('Set SUBMISSIONLEDGER_API_TOKEN to a random secret of at least 24 characters (no whitespace).');
  }
  return token;
}

export function requireBearer(request: IncomingMessage, expectedToken: string): void {
  const header = request.headers.authorization;
  if (!header || !/^Bearer [^\s]+$/.test(header)) {
    throw new HttpError(401, 'unauthorized', 'A valid bearer token is required.', {
      'WWW-Authenticate': 'Bearer realm="submissionledger"',
    });
  }
  const actual = Buffer.from(header.slice(7), 'utf8');
  const expected = Buffer.from(expectedToken, 'utf8');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new HttpError(401, 'unauthorized', 'A valid bearer token is required.', {
      'WWW-Authenticate': 'Bearer realm="submissionledger"',
    });
  }
}
