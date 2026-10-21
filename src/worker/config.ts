import { readFileSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { InputError } from '../core/errors.js';
import { validateDestination } from '../ledger/delivery.js';

export interface WebhookTarget {
  url: string;
  secretEnv: string;
}
export interface WebhookConfig {
  destinations: Record<string, WebhookTarget>;
}

export function parseWebhookConfig(value: unknown, allowLocalHttp = false): WebhookConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new InputError('Webhook config must be an object.');
  const root = value as Record<string, unknown>;
  if (Object.keys(root).length !== 1 || !Object.hasOwn(root, 'destinations')) {
    throw new InputError('Webhook config requires only a destinations object.');
  }
  const destinations = root.destinations;
  if (!destinations || typeof destinations !== 'object' || Array.isArray(destinations)) {
    throw new InputError('Webhook destinations must be an object.');
  }
  const entries = Object.entries(destinations);
  if (entries.length < 1 || entries.length > 32) throw new InputError('Configure between 1 and 32 destinations.');
  const targets: Record<string, WebhookTarget> = Object.create(null) as Record<string, WebhookTarget>;
  for (const [name, item] of entries) {
    validateDestination(name);
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new InputError(`Invalid destination: ${name}.`);
    const target = item as Record<string, unknown>;
    if (Object.keys(target).sort().join(',') !== 'secretEnv,url' ||
        typeof target.url !== 'string' || typeof target.secretEnv !== 'string') {
      throw new InputError(`Destination '${name}' must include url and secretEnv.`);
    }
    let url: URL;
    try { url = new URL(target.url); } catch { throw new InputError(`Invalid URL for destination '${name}'.`); }
    const hostname = url.hostname.toLowerCase();
    const local = hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
    const isAllowedLocal = url.protocol === 'http:' && local && allowLocalHttp;
    if ((url.protocol !== 'https:' && !isAllowedLocal) || url.username || url.password || url.hash || !url.hostname ||
      !['', '80', '443'].includes(url.port) && !isAllowedLocal) {
      throw new InputError(`Destination '${name}' requires HTTPS (loopback HTTP needs explicit opt-in).`);
    }
    if (!/^[A-Z][A-Z0-9_]{3,100}$/.test(target.secretEnv)) {
      throw new InputError(`Invalid secretEnv for destination '${name}'.`);
    }
    targets[name] = { url: url.toString(), secretEnv: target.secretEnv };
  }
  return { destinations: targets };
}

export function loadWebhookConfig(path: string, allowLocalHttp = false): WebhookConfig {
  const absolute = resolve(path);
  let raw: string;
  try {
    if (statSync(absolute).size > 64 * 1024) throw new InputError('Webhook config exceeds 64 KiB.');
    raw = readFileSync(absolute, 'utf8');
  } catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError(`Cannot open webhook config: ${absolute}`);
  }
  try { return parseWebhookConfig(JSON.parse(raw) as unknown, allowLocalHttp); }
  catch (error) {
    if (error instanceof InputError) throw error;
    throw new InputError('Webhook config is not valid JSON.');
  }
}

export function signingSecrets(config: WebhookConfig, env: NodeJS.ProcessEnv): Record<string, string> {
  const secrets: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [destination, target] of Object.entries(config.destinations)) {
    const secret = env[target.secretEnv];
    if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
      throw new InputError(`Missing or short signing secret for destination '${destination}' in ${target.secretEnv} (min 32 bytes).`);
    }
    secrets[destination] = secret;
  }
  return secrets;
}
