/**
 * The Render request an agent proposes, judged in-tree: Render has no classifier to pin, so this table is the whole
 * policy. A request is accepted only as one of the operations below, against a resource the target lists, with a
 * body of exactly the shape that operation allows. Everything else is denied and nothing is shown.
 */
import { createHash } from 'node:crypto';

import { ENV_KEY_RE, type RenderTarget } from './targets.js';

type RenderMethod = 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RenderRequest {
  method: RenderMethod;
  path: string;
  body: unknown;
}

type OpKind = 'env-set' | 'env-delete' | 'job' | 'auto-deploy' | 'domain-add' | 'domain-verify' | 'routes';

export interface RenderClassification {
  tier: 'card' | 'deny';
  denyReasons: string[];
  op: OpKind | null;
  /** The resource the request names, and the env key or domain when the operation has one. */
  resource: string | null;
  key: string | null;
  /** The request exactly as it will be sent; its sha256 binds the card. */
  request: RenderRequest | null;
}

const MAX_BODY_BYTES = 64 * 1024;
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const METHODS = new Set<string>(['POST', 'PUT', 'PATCH', 'DELETE']);
/** Characters a path segment may hold; nothing that could re-route the request once a URL parser reads it. */
const SEGMENT_RE = /^[A-Za-z0-9_.-]+$/;

interface OpSpec {
  kind: OpKind;
  method: RenderMethod;
  /** `{id}` is a listed resource, `{key}` an env key, `{domain}` a domain name; other segments are literal. */
  template: string[];
  resourcePrefixes: string[];
  body: (body: unknown) => string | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function exactKeys(v: unknown, required: string[], optional: string[] = []): v is Record<string, unknown> {
  if (!isPlainObject(v)) return false;
  const keys = Object.keys(v);
  return required.every((k) => k in v) && keys.every((k) => required.includes(k) || optional.includes(k));
}

const noBody = (b: unknown) => (b === undefined || b === null ? null : 'this operation takes no body');

const OPS: OpSpec[] = [
  {
    kind: 'env-set',
    method: 'PUT',
    template: ['v1', 'services', '{id}', 'env-vars', '{key}'],
    resourcePrefixes: ['srv', 'crn'],
    body: (b) =>
      exactKeys(b, ['value']) && typeof b.value === 'string' ? null : 'the body must be exactly {"value": "<string>"}',
  },
  {
    kind: 'env-delete',
    method: 'DELETE',
    template: ['v1', 'services', '{id}', 'env-vars', '{key}'],
    resourcePrefixes: ['srv', 'crn'],
    body: noBody,
  },
  {
    kind: 'job',
    method: 'POST',
    template: ['v1', 'services', '{id}', 'jobs'],
    resourcePrefixes: ['srv', 'crn'],
    body: (b) =>
      exactKeys(b, ['startCommand'], ['planId']) &&
      typeof b.startCommand === 'string' &&
      b.startCommand.trim() !== '' &&
      (b.planId === undefined || typeof b.planId === 'string')
        ? null
        : 'the body must be {"startCommand": "<command>"} with an optional "planId"',
  },
  {
    kind: 'auto-deploy',
    method: 'PATCH',
    template: ['v1', 'services', '{id}'],
    resourcePrefixes: ['srv', 'crn'],
    body: (b) =>
      exactKeys(b, ['autoDeploy']) && (b.autoDeploy === 'yes' || b.autoDeploy === 'no')
        ? null
        : 'a service change may only set {"autoDeploy": "yes" | "no"}; any other setting is a dashboard step',
  },
  {
    kind: 'domain-add',
    method: 'POST',
    template: ['v1', 'services', '{id}', 'custom-domains'],
    resourcePrefixes: ['srv'],
    body: (b) =>
      exactKeys(b, ['name']) && typeof b.name === 'string' && DOMAIN_RE.test(b.name)
        ? null
        : 'the body must be exactly {"name": "<domain>"}',
  },
  {
    kind: 'domain-verify',
    method: 'POST',
    template: ['v1', 'services', '{id}', 'custom-domains', '{domain}', 'verify'],
    resourcePrefixes: ['srv'],
    body: noBody,
  },
  {
    kind: 'routes',
    method: 'PUT',
    template: ['v1', 'services', '{id}', 'routes'],
    resourcePrefixes: ['srv'],
    body: (b) => (Array.isArray(b) || isPlainObject(b) ? null : 'the body must be a JSON array or object of routes'),
  },
];

function deny(reason: string): RenderClassification {
  return { tier: 'deny', denyReasons: [reason], op: null, resource: null, key: null, request: null };
}

function matchTemplate(
  template: string[],
  segments: string[],
): { id: string; key: string | null; domain: string | null } | null {
  if (template.length !== segments.length) return null;
  let id: string | null = null;
  let key: string | null = null;
  let domain: string | null = null;
  for (const [i, part] of template.entries()) {
    const seg = segments[i];
    if (part === '{id}') id = seg;
    else if (part === '{key}') {
      if (!ENV_KEY_RE.test(seg)) return null;
      key = seg;
    } else if (part === '{domain}') {
      if (!DOMAIN_RE.test(seg)) return null;
      domain = seg;
    } else if (part !== seg) return null;
  }
  return id ? { id, key, domain } : null;
}

export function classifyRenderRequest(target: RenderTarget, raw: unknown): RenderClassification {
  if (!isPlainObject(raw)) return deny('the request must be an object with method, path and body');
  if (!exactKeys(raw, ['method', 'path'], ['body'])) return deny('the request may hold only method, path and body');
  const { method, path, body } = raw;
  if (typeof method !== 'string' || !METHODS.has(method)) return deny('the method must be POST, PUT, PATCH or DELETE');
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > 512) return deny('the path is invalid');
  if (/[?#%\\]/.test(path)) return deny('the path may not hold a query, fragment, escape or backslash');
  const segments = path.slice(1).split('/');
  if (segments.some((s) => !SEGMENT_RE.test(s) || s === '.' || s === '..')) {
    return deny('the path may hold only plain segments');
  }
  const bodyBytes = body === undefined ? 0 : Buffer.byteLength(JSON.stringify(body), 'utf8');
  if (bodyBytes > MAX_BODY_BYTES) return deny(`the body is over ${MAX_BODY_BYTES / 1024} KB`);
  for (const op of OPS) {
    if (op.method !== method) continue;
    const m = matchTemplate(op.template, segments);
    if (!m) continue;
    if (!target.resources[m.id]) return deny(`resource ${m.id} is not one this target may change`);
    if (!op.resourcePrefixes.some((p) => m.id.startsWith(`${p}-`))) {
      return deny(`this operation does not apply to resource ${m.id}`);
    }
    const bodyProblem = op.body(body);
    if (bodyProblem) return deny(bodyProblem);
    return {
      tier: 'card',
      denyReasons: [],
      op: op.kind,
      resource: m.id,
      key: m.key ?? m.domain,
      request: { method: op.method, path, body: body ?? null },
    };
  }
  return deny(`${method} ${path} is not an operation this lane runs; it stays a human step in the Render dashboard`);
}

/** The bytes the card binds: key order fixed, so the same request always hashes the same. */
function canonicalRequest(request: RenderRequest): string {
  const sortKeys = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sortKeys)
      : isPlainObject(v)
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, sortKeys(v[k])]),
          )
        : v;
  return JSON.stringify({ method: request.method, path: request.path, body: sortKeys(request.body) });
}

export function requestSha(request: RenderRequest): string {
  return createHash('sha256').update(canonicalRequest(request)).digest('hex');
}
