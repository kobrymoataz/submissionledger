import { InputError } from './errors.js';

const SOURCE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;
const KEY_RE = /^[A-Za-z0-9][A-Za-z0-9_./:@-]{0,127}$/;

export function validateSource(source: string | undefined): string {
  const value = source ?? 'cli';
  if (!SOURCE_RE.test(value)) {
    throw new InputError('Source must be 1–64 characters: letters, digits, _, ., : or -.');
  }
  return value;
}

export function validateIdempotencyKey(key: string | undefined): string | null {
  if (key === undefined) return null;
  if (!KEY_RE.test(key)) {
    throw new InputError('Idempotency key must be 1–128 characters without spaces.');
  }
  return key;
}

export function validateLimit(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) {
    throw new InputError('Limit must be a whole number between 1 and 100.');
  }
  return value;
}
