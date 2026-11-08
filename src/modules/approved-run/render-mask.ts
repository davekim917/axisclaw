/**
 * How a Render env value is shown to an agent or on a card. A key on the resource's plaintext list is shown as is,
 * except that a value holding an `@` (a URL's userinfo) or a URL-like value we cannot parse is masked whole, and a
 * URL's query and fragment (where tokens hide) are masked; every other value is masked. A mask is the
 * value's length and a keyed HMAC-SHA256: the key never leaves the host, so a short secret cannot be recovered by
 * hashing guesses, while two equal values still mask the same ("matches dev", "changed since").
 */
import { createHmac, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { RenderClassification } from './render-request.js';
import { APPROVED_RUN_DIR, type RenderResource, type RenderTarget } from './targets.js';

const KEY_PATH = path.join(APPROVED_RUN_DIR, 'render-mask.key');
const HMAC_SHOWN = 16;
const KEY_BYTES = 32;

/**
 * The key one target masks with. Each target gets its own, derived from the host key, so a value an agent can set
 * on one target and read back masked cannot be compared with a secret's mask on another.
 */
export function maskKey(targetId: string, keyPath: string = KEY_PATH): Buffer {
  return createHmac('sha256', hostKey(keyPath)).update(`target\0${targetId}`, 'utf8').digest();
}

/** Reads the host's key, creating it on first use; `wx` makes a concurrent first use converge on one key. */
function hostKey(keyPath: string): Buffer {
  const checked = (key: Buffer): Buffer => {
    if (key.length !== KEY_BYTES) throw new Error(`${keyPath} is not a ${KEY_BYTES}-byte key; remove it to regenerate`);
    return key;
  };
  try {
    return checked(fs.readFileSync(keyPath));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  fs.mkdirSync(path.dirname(keyPath), { recursive: true, mode: 0o700 });
  // Written whole aside and linked into place, so no reader ever sees a partly written key.
  const staged = `${keyPath}.${process.pid}.${randomBytes(4).toString('hex')}`;
  fs.writeFileSync(staged, randomBytes(KEY_BYTES), { mode: 0o600, flag: 'wx' });
  try {
    fs.linkSync(staged, keyPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    fs.rmSync(staged, { force: true });
  }
  return checked(fs.readFileSync(keyPath));
}

/** What a card or report shows for a request: keyed, because the request's plain sha256 covers a secret value. */
export function requestRef(sha: string, key: Buffer): string {
  return createHmac('sha256', key).update(`request\0${sha}`, 'utf8').digest('hex').slice(0, 12);
}

export function maskValue(value: string, key: Buffer): string {
  const mac = createHmac('sha256', key).update(value, 'utf8').digest('hex').slice(0, HMAC_SHOWN);
  return `‹masked len=${value.length} hmac=${mac}›`;
}

function maskUrlParts(value: string, key: Buffer): string {
  // A URL carries a credential in its userinfo, and the userinfo's edges (an unencoded `#`, `?` or `/`, several hosts,
  // no scheme) are exactly what parsers disagree on, so a listed value holding an `@` is masked whole.
  if (value.includes('@')) return maskValue(value, key);
  let url: URL;
  try {
    url = new URL(value);
    // eslint-disable-next-line no-catch-all/no-catch-all -- a value URL cannot parse is judged below
  } catch {
    return /:\/\/|[?#]/.test(value) ? maskValue(value, key) : value;
  }
  if (!url.search && !url.hash) return value;
  const { search, hash } = url;
  url.search = '';
  url.hash = '';
  let shown = url.toString();
  if (search) shown = `${shown}?${maskValue(search.slice(1), key)}`;
  if (hash) shown = `${shown}#${maskValue(hash.slice(1), key)}`;
  return shown;
}

export function showEnvValue(resource: RenderResource, envKey: string, value: string, key: Buffer): string {
  return resource.plaintextEnv.includes(envKey) ? maskUrlParts(value, key) : maskValue(value, key);
}

/**
 * Render's answer to an env write, with the value it echoes masked the way the card masks the request. An answer
 * whose value is not a plain string, or that is not an object at all, is masked whole.
 */
export function maskRenderResponse(target: RenderTarget, c: RenderClassification, body: unknown, key: Buffer): unknown {
  if ((c.op !== 'env-set' && c.op !== 'env-delete') || body === null || body === undefined) return body;
  if (typeof body !== 'object' || Array.isArray(body)) return maskValue(JSON.stringify(body), key);
  const b = body as Record<string, unknown>;
  if (!('value' in b)) return body;
  if (typeof b.value !== 'string') return { ...b, value: maskValue(JSON.stringify(b.value), key) };
  return { ...b, value: showEnvValue(target.resources[c.resource as string], c.key as string, b.value, key) };
}
