import { describe, expect, it } from 'vitest';

import { classifyRenderRequest, requestSha } from './render-request.js';
import type { RenderTarget } from './targets.js';

const SRV = 'srv-aaaaaaaaaaaaaaaaaaaa';
const CRN = 'crn-bbbbbbbbbbbbbbbbbbbb';
const DPG = 'dpg-cccccccccccccccccccc-a';
const UNLISTED = 'srv-zzzzzzzzzzzzzzzzzzzz';

const TARGET: RenderTarget = {
  id: 'acme-render',
  label: 'Acme Render',
  entrySha: 'e'.repeat(64),
  kind: 'render',
  mode: 'execute',
  agentGroups: ['ag-1'],
  approvers: ['slack:U1'],
  execute: {
    secret: 'approved-run-acme-render token',
    onecliAgent: 'approved-run-acme-render',
    adminUserId: 'usr-aaaaaaaaaaaaaaaaaaaa',
  },
  resources: {
    [SRV]: { label: 'Acme backend', plaintextEnv: ['NODE_ENV'] },
    [CRN]: { label: 'Acme nightly', plaintextEnv: [] },
    [DPG]: { label: 'Acme db', plaintextEnv: [] },
  },
};

describe('classifyRenderRequest', () => {
  it.each([
    ['env-set', { method: 'PUT', path: `/v1/services/${SRV}/env-vars/FEATURE_X`, body: { value: 'on' } }, 'FEATURE_X'],
    ['env-delete', { method: 'DELETE', path: `/v1/services/${CRN}/env-vars/OLD_KEY` }, 'OLD_KEY'],
    ['job', { method: 'POST', path: `/v1/services/${SRV}/jobs`, body: { startCommand: 'node x.js' } }, null],
    [
      'job',
      { method: 'POST', path: `/v1/services/${CRN}/jobs`, body: { startCommand: 'run', planId: 'plan-1' } },
      null,
    ],
    ['auto-deploy', { method: 'PATCH', path: `/v1/services/${SRV}`, body: { autoDeploy: 'no' } }, null],
    [
      'domain-add',
      { method: 'POST', path: `/v1/services/${SRV}/custom-domains`, body: { name: 'app.example.com' } },
      null,
    ],
    [
      'domain-verify',
      { method: 'POST', path: `/v1/services/${SRV}/custom-domains/app.example.com/verify` },
      'app.example.com',
    ],
    ['routes', { method: 'PUT', path: `/v1/services/${SRV}/routes`, body: [{ type: 'redirect' }] }, null],
  ])('accepts %s and keeps the request exactly as sent', (op, request, key) => {
    const c = classifyRenderRequest(TARGET, request);
    expect(c).toMatchObject({ tier: 'card', op, key, denyReasons: [] });
    expect(c.request).toEqual({ ...request, body: (request as { body?: unknown }).body ?? null });
  });

  it.each([
    ['service delete', { method: 'DELETE', path: `/v1/services/${SRV}` }],
    ['service suspend', { method: 'POST', path: `/v1/services/${SRV}/suspend` }],
    ['service resume', { method: 'POST', path: `/v1/services/${SRV}/resume` }],
    ['service create', { method: 'POST', path: '/v1/services', body: { name: 'x' } }],
    ['database delete', { method: 'DELETE', path: `/v1/postgres/${DPG}` }],
    ['database change', { method: 'PATCH', path: `/v1/postgres/${DPG}`, body: { name: 'x' } }],
    ['database export', { method: 'POST', path: `/v1/postgres/${DPG}/export` }],
    ['database credentials', { method: 'POST', path: `/v1/postgres/${DPG}/credentials`, body: {} }],
    ['secret file', { method: 'PUT', path: `/v1/services/${SRV}/secret-files/a.pem`, body: { content: 'x' } }],
    ['deploy', { method: 'POST', path: `/v1/services/${SRV}/deploys`, body: {} }],
    ['environment change', { method: 'PATCH', path: '/v1/environments/evm-aaaaaaaaaaaaaaaaaaaa', body: {} }],
    [
      'start command',
      { method: 'PATCH', path: `/v1/services/${SRV}`, body: { serviceDetails: { startCommand: 'sh' } } },
    ],
    [
      'pre-deploy command',
      { method: 'PATCH', path: `/v1/services/${SRV}`, body: { serviceDetails: { preDeployCommand: 'sh' } } },
    ],
    ['repo and branch', { method: 'PATCH', path: `/v1/services/${SRV}`, body: { repo: 'x', branch: 'y' } }],
    [
      'auto-deploy plus another field',
      { method: 'PATCH', path: `/v1/services/${SRV}`, body: { autoDeploy: 'no', branch: 'y' } },
    ],
    ['env value that is not a string', { method: 'PUT', path: `/v1/services/${SRV}/env-vars/A`, body: { value: 1 } }],
    [
      'env body with an extra field',
      { method: 'PUT', path: `/v1/services/${SRV}/env-vars/A`, body: { value: 'x', generateValue: true } },
    ],
    ['job without a command', { method: 'POST', path: `/v1/services/${SRV}/jobs`, body: {} }],
    ['body on a delete', { method: 'DELETE', path: `/v1/services/${SRV}/env-vars/A`, body: { value: 'x' } }],
    ['unlisted resource', { method: 'PUT', path: `/v1/services/${UNLISTED}/env-vars/A`, body: { value: 'x' } }],
    [
      'custom domain on a cron job',
      { method: 'POST', path: `/v1/services/${CRN}/custom-domains`, body: { name: 'a.example.com' } },
    ],
    ['GET', { method: 'GET', path: `/v1/services/${SRV}/env-vars` }],
    [
      'extra request field',
      { method: 'POST', path: `/v1/services/${SRV}/jobs`, body: { startCommand: 'a' }, headers: {} },
    ],
    ['oversized body', { method: 'PUT', path: `/v1/services/${SRV}/routes`, body: ['x'.repeat(70 * 1024)] }],
  ])('denies %s', (_name, request) => {
    const c = classifyRenderRequest(TARGET, request);
    expect(c.tier).toBe('deny');
    expect(c.request).toBeNull();
    expect(c.denyReasons).toHaveLength(1);
  });
});

describe('the path guard', () => {
  it.each([
    ['a dot segment', `/v1/services/${SRV}/../${UNLISTED}/env-vars/A`, 'the path may hold only plain segments'],
    ['an empty segment', `/v1/services//${SRV}/env-vars/A`, 'the path may hold only plain segments'],
    [
      'an encoded slash',
      `/v1/services/${SRV}%2F..%2F${UNLISTED}/env-vars/A`,
      'the path may not hold a query, fragment, escape or backslash',
    ],
    [
      'a query string',
      `/v1/services/${SRV}/env-vars/A?x=1`,
      'the path may not hold a query, fragment, escape or backslash',
    ],
    [
      'a backslash',
      `/v1/services/${SRV}\\..\\${UNLISTED}/env-vars/A`,
      'the path may not hold a query, fragment, escape or backslash',
    ],
  ])('refuses %s before any operation is matched', (_name, path, reason) => {
    expect(classifyRenderRequest(TARGET, { method: 'PUT', path, body: { value: 'x' } }).denyReasons).toEqual([reason]);
  });
});

describe('requestSha', () => {
  it('binds the request, not the order its body keys arrived in', () => {
    const a = { method: 'POST' as const, path: '/v1/x', body: { startCommand: 'a', planId: 'p' } };
    const b = { method: 'POST' as const, path: '/v1/x', body: { planId: 'p', startCommand: 'a' } };
    expect(requestSha(a)).toBe(requestSha(b));
    expect(requestSha({ ...a, body: { startCommand: 'b', planId: 'p' } })).not.toBe(requestSha(a));
  });
});
