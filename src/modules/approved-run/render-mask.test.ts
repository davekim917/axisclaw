import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { maskKey, maskRenderResponse, maskValue, showEnvValue } from './render-mask.js';
import { classifyRenderRequest } from './render-request.js';
import type { RenderTarget } from './targets.js';

const KEY = Buffer.alloc(32, 7);
const RESOURCE = { label: 'Acme backend', plaintextEnv: ['NODE_ENV', 'PEER_URL'] };
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

describe('maskValue', () => {
  it('shows length and a keyed HMAC, never the plain sha256 a guess could be checked against', () => {
    const masked = maskValue('hunter2', KEY);
    expect(masked).toMatch(/^‹masked len=7 hmac=[0-9a-f]{16}›$/);
    expect(masked).not.toContain(createHash('sha256').update('hunter2').digest('hex').slice(0, 16));
    expect(maskValue('hunter2', KEY)).toBe(masked);
    expect(maskValue('hunter2', Buffer.alloc(32, 8))).not.toBe(masked);
  });
});

describe('showEnvValue', () => {
  it('shows a listed key in plaintext and masks every other key', () => {
    expect(showEnvValue(RESOURCE, 'NODE_ENV', 'production', KEY)).toBe('production');
    expect(showEnvValue(RESOURCE, 'JWT_SECRET', 'production', KEY)).toBe(maskValue('production', KEY));
  });

  it("masks a listed URL's query, keeps the rest readable, and masks a URL with userinfo whole", () => {
    expect(showEnvValue(RESOURCE, 'PEER_URL', 'https://peer.example.com/api?token=abc', KEY)).toBe(
      `https://peer.example.com/api?${maskValue('token=abc', KEY)}`,
    );
    const userinfo = 'user:pass';
    const withUser = `https://${userinfo}@peer.example.com/api`;
    expect(showEnvValue(RESOURCE, 'PEER_URL', withUser, KEY)).toBe(maskValue(withUser, KEY));
  });
});

describe('a listed connection string URL cannot take apart', () => {
  it.each([
    'mongodb://admin:hunter2@h1:27017,h2:27017/db?replicaSet=rs0',
    'postgres://user:pa/ss@host/db',
    'postgres://user:p#ss@host/db',
    'user:secret@host:5432/db',
    'postgres://user:1#ss@host/db',
    'https://abc#def@host/x',
    'https://tok?en@host/x',
    'api.example.com/hook?token=abc',
    '/callback?api_key=abc',
    '//cdn.example.com/x?sig=abc',
    'example.com/x#sig=abc',
  ])('is masked whole rather than shown (%s)', (value) => {
    expect(showEnvValue({ label: 'x', plaintextEnv: ['DB_URL'] }, 'DB_URL', value, KEY)).toBe(maskValue(value, KEY));
  });

  it('masks a fragment as well as a query', () => {
    expect(showEnvValue(RESOURCE, 'PEER_URL', 'https://peer.example.com/hook#sig=abc', KEY)).toBe(
      `https://peer.example.com/hook#${maskValue('sig=abc', KEY)}`,
    );
  });
});

describe('maskRenderResponse', () => {
  const SRV = 'srv-aaaaaaaaaaaaaaaaaaaa';
  const TARGET: RenderTarget = {
    id: 'acme-render',
    label: 'Acme Render',
    entrySha: 'e'.repeat(64),
    kind: 'render',
    mode: 'execute',
    agentGroups: ['ag-1'],
    approvers: ['slack:U1'],
    execute: { secret: 's', onecliAgent: 'approved-run-acme-render', adminUserId: 'usr-aaaaaaaaaaaaaaaaaaaa' },
    resources: { [SRV]: { label: 'Acme backend', plaintextEnv: ['NODE_ENV'] } },
  };
  const envSet = (key: string) =>
    classifyRenderRequest(TARGET, { method: 'PUT', path: `/v1/services/${SRV}/env-vars/${key}`, body: { value: 'x' } });
  const job = classifyRenderRequest(TARGET, {
    method: 'POST',
    path: `/v1/services/${SRV}/jobs`,
    body: { startCommand: 'node reindex.js' },
  });

  it.each([
    [
      'an echoed secret value',
      envSet('JWT_SECRET'),
      { key: 'JWT_SECRET', value: 'hunter2' },
      { key: 'JWT_SECRET', value: maskValue('hunter2', KEY) },
    ],
    [
      'a listed plaintext value',
      envSet('NODE_ENV'),
      { key: 'NODE_ENV', value: 'production' },
      { key: 'NODE_ENV', value: 'production' },
    ],
    [
      'a value that is not a string, whole',
      envSet('JWT_SECRET'),
      { value: ['hunter2'] },
      { value: maskValue('["hunter2"]', KEY) },
    ],
    ['an answer that is not an object, whole', envSet('JWT_SECRET'), 'hunter2', maskValue('"hunter2"', KEY)],
    ['an answer with no value, as is', envSet('JWT_SECRET'), { message: 'forbidden' }, { message: 'forbidden' }],
    ['no answer, as is', envSet('JWT_SECRET'), null, null],
    [
      'an answer to an operation that sets no env value, as is',
      job,
      { id: 'job-1', startCommand: 'node reindex.js' },
      { id: 'job-1', startCommand: 'node reindex.js' },
    ],
  ])('masks %s', (_name, c, body, shown) => {
    expect(maskRenderResponse(TARGET, c, body, KEY)).toEqual(shown);
  });
});

describe('maskKey', () => {
  it('refuses a key file of the wrong length instead of masking with it', () => {
    const dir = uniqueTmpRoot('render-mask-short');
    dirs.push(dir);
    const file = path.join(dir, 'render-mask.key');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, '');
    expect(() => maskKey('t-1', file)).toThrow(/is not a 32-byte key/);
  });

  it('creates a private key once and returns the same key after', () => {
    const dir = uniqueTmpRoot('render-mask-test');
    dirs.push(dir);
    const file = path.join(dir, 'sub', 'render-mask.key');
    const first = maskKey('t-1', file);
    expect(first).toHaveLength(32);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(maskKey('t-1', file).equals(first)).toBe(true);
  });

  it('gives each target its own key, so one value masks differently under two targets', () => {
    const dir = uniqueTmpRoot('render-mask-targets');
    dirs.push(dir);
    const file = path.join(dir, 'render-mask.key');
    const lab = maskKey('lab', file);
    const prod = maskKey('prod', file);
    expect(lab.equals(prod)).toBe(false);
    expect(maskValue('guess-1', lab)).not.toBe(maskValue('guess-1', prod));
    expect(maskValue('guess-1', maskKey('prod', file))).toBe(maskValue('guess-1', prod));
  });
});
