import { spawn } from 'child_process';
import http from 'http';
import type { AddressInfo } from 'net';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const PRELOAD = path.resolve(__dirname, '../container/skills/live-preview/preview-egress.cjs');

// Every request carries a lookup that fails, so a call that is not tunnelled never reaches DNS or
// the network; it surfaces as the lookup error instead.
const CLIENT = `
const https = require('node:https');
const lookup = (_h, _o, cb) => cb(new Error('direct'));
class ProxyAware extends https.Agent { createConnection(_o, cb) { cb(new Error('own-agent')); } }
const cases = {
  stripeStyle: { host: 'api.example.test', agent: new https.Agent({ keepAlive: true }) },
  defaultAgent: { host: 'api.example.test' },
  urlForm: 'https://api.example.test/v1/balance',
  loopback: { host: '127.0.0.1', port: 9 },
  proxyAware: { host: 'api.example.test', agent: new ProxyAware() },
};
const out = {};
let pending = Object.keys(cases).length;
for (const [name, opts] of Object.entries(cases)) {
  const req = typeof opts === 'string' ? https.get(opts, { lookup }) : https.get({ ...opts, lookup });
  req.on('error', (e) => { out[name] = e.message.split(':')[0]; if (--pending === 0) console.log(JSON.stringify(out)); });
}
`;

let proxy: http.Server;
let connects: { target: string; auth?: string }[];

beforeEach(async () => {
  connects = [];
  proxy = http.createServer();
  proxy.on('connect', (req, socket) => {
    connects.push({ target: req.url!, auth: req.headers['proxy-authorization'] });
    socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
});

afterEach(() => new Promise<void>((resolve) => proxy.close(() => resolve())));

const NO_PROXY_CLIENT = `
const https = require('node:https');
const lookup = (_h, _o, cb) => cb(new Error('direct'));
const out = {};
let pending = 2;
for (const [name, host] of [['internal', 'internal.example.test'], ['external', 'api.example.test']]) {
  https.get({ host, lookup }).on('error', (e) => { out[name] = e.message.split(':')[0]; if (--pending === 0) console.log(JSON.stringify(out)); });
}
`;

const ESM_CLIENT = `
import { request } from 'node:https';
request({ host: 'api.example.test', lookup: (_h, _o, cb) => cb(new Error('direct')) })
  .on('error', (e) => console.log(JSON.stringify({ namedImport: e.message.split(':')[0] })))
  .end();
`;

function runClient(
  env: Record<string, string>,
  script = CLIENT,
  type: 'commonjs' | 'module' = 'commonjs',
): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--require', PRELOAD, `--input-type=${type}`, '-e', script], {
      env: { PATH: process.env.PATH ?? '', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', () => {
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error(`client failed: ${stderr || stdout}`));
      }
    });
  });
}

describe('live-preview egress preload', () => {
  it('tunnels requests that ignore proxy variables through the preview proxy, with its credentials', async () => {
    const { port } = proxy.address() as AddressInfo;
    const result = await runClient({ PREVIEW_HTTPS_PROXY: `http://preview:s3cret@127.0.0.1:${port}` });

    expect(result).toEqual({
      stripeStyle: 'preview proxy refused CONNECT api.example.test',
      defaultAgent: 'preview proxy refused CONNECT api.example.test',
      urlForm: 'preview proxy refused CONNECT api.example.test',
      loopback: 'connect ECONNREFUSED 127.0.0.1',
      proxyAware: 'own-agent',
    });
    expect(connects).toEqual(
      Array(3).fill({
        target: 'api.example.test:443',
        auth: `Basic ${Buffer.from('preview:s3cret').toString('base64')}`,
      }),
    );
  });

  it('sends hosts that NO_PROXY names direct, as Node does', async () => {
    const { port } = proxy.address() as AddressInfo;
    const result = await runClient(
      { PREVIEW_HTTPS_PROXY: `http://preview:s3cret@127.0.0.1:${port}`, NO_PROXY: 'internal.example.test' },
      NO_PROXY_CLIENT,
    );

    expect(result).toEqual({
      internal: 'direct',
      external: 'preview proxy refused CONNECT api.example.test',
    });
    expect(connects.map((c) => c.target)).toEqual(['api.example.test:443']);
  });

  it('tunnels a named ESM import of node:https too', async () => {
    const { port } = proxy.address() as AddressInfo;
    const result = await runClient(
      { PREVIEW_HTTPS_PROXY: `http://preview:s3cret@127.0.0.1:${port}` },
      ESM_CLIENT,
      'module',
    );

    expect(result).toEqual({ namedImport: 'preview proxy refused CONNECT api.example.test' });
    expect(connects.map((c) => c.target)).toEqual(['api.example.test:443']);
  });

  it('changes nothing when no preview proxy is set', async () => {
    const result = await runClient({});

    expect(result).toEqual({
      stripeStyle: 'direct',
      defaultAgent: 'direct',
      urlForm: 'direct',
      loopback: 'connect ECONNREFUSED 127.0.0.1',
      proxyAware: 'own-agent',
    });
    expect(connects).toEqual([]);
  });
});
