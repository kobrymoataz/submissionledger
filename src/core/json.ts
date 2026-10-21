import { createHash } from 'node:crypto';
import { InputError } from './errors.js';
import type { JsonObject, JsonValue } from './types.js';

export const MAX_PAYLOAD_BYTES = 64 * 1024;

function normalize(value: unknown, depth: number, seen: WeakSet<object>): JsonValue {
  if (depth > 32) throw new InputError('The payload is too deeply nested (maximum depth: 32).');

  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new InputError('Payload numbers must be finite.');
    return value;
  }
  if (typeof value !== 'object') {
    throw new InputError('The payload must contain only JSON-compatible values.');
  }
  if (seen.has(value)) throw new InputError('Circular references are not supported.');
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item, depth + 1, seen));
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new InputError('The payload must contain plain JSON objects.');
    }
    const output: JsonObject = Object.create(null) as JsonObject;
    for (const key of Object.keys(value).sort()) {
      output[key] = normalize((value as Record<string, unknown>)[key], depth + 1, seen);
    }
    return output;
  } finally {
    seen.delete(value);
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalize(value, 0, new WeakSet<object>()));
}

export function preparePayload(value: unknown): { payloadJson: string; digest: string } {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InputError('The submission payload must be a JSON object.');
  }
  const payloadJson = canonicalJson(value);
  if (Buffer.byteLength(payloadJson, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw new InputError('The submission payload exceeds the 64 KiB limit.');
  }
  return { payloadJson, digest: sha256(payloadJson) };
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function parseStoredPayload(payloadJson: string): JsonObject {
  // Only data produced by preparePayload is written to the database.
  return JSON.parse(payloadJson) as JsonObject;
}
