import { spawn } from 'child_process';
import { EventEmitter } from 'events';
import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import { Duplex, PassThrough } from 'stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '../../log.js';
import { openContainerLoopback } from '../browser-takeover/bridge.js';
import {
  createPreviewProxy,
  MAX_UPGRADES_PER_PREVIEW,
  MAX_UPGRADES_TOTAL,
  MAX_UPSTREAM_CONNECTIONS,
  pathVerdict,
  previewIdFromHost,
} from './proxy.js';

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  PREVIEW_ORIGIN_SUFFIX: 'preview.example.test',
}));
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const ID = '0123456789abcdef0123456789abcdef';
const HOST = `${ID}.preview.example.test`;
const CONTAINER = 'nanoclaw-v2-example-1';
const APP_PORT = 5173;

let upstream: http.Server;
let upstreamPort: number;
let proxy: http.Server;
let proxyPort: number;
let hits: { method?: string; url?: string; headers: http.IncomingHttpHeaders; body: string }[];
let opened: { containerName: string; port: number }[];
let raw: net.Socket[];
let streams: Duplex[];
let revocation: AbortController;
let earlyBody: string;
let held: (() => void)[];
let others: Map<string, { containerName: string; revoked: AbortSignal }>;

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

beforeEach(async () => {
  hits = [];
  opened = [];
  raw = [];
  streams = [];
  revocation = new AbortController();
  earlyBody = '';
  held = [];
  others = new Map();
  upstream = http.createServer((req, res) => {
    if (req.url === '/early') {
      req.on('data', (d) => (earlyBody += d.toString()));
      res.end('early');
      return;
    }
    if (req.url === '/held') {
      held.push(() => res.end('from-app'));
      return;
    }
    if (req.url === '/stream') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('first');
      return;
    }
    let body = '';
    req.on('data', (d) => (body += d.toString()));
    req.on('end', () => {
      hits.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(201, [
        'Set-Cookie',
        'a=1',
        'Set-Cookie',
        'b=2',
        'Content-Type',
        'text/plain',
        'Keep-Alive',
        'timeout=77',
      ]);
      res.end('from-app');
    });
  });
  upstream.on('upgrade', (req, socket) => {
    hits.push({ method: req.method, url: req.url, headers: req.headers, body: '' });
    raw.push(socket as net.Socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(`echo:${d.toString()}`));
  });
  upstreamPort = await listen(upstream);
  // Stands in for the docker-exec bridge: a Duplex that is not a net.Socket.
  const openUpstream = (containerName: string, port: number): Duplex => {
    opened.push({ containerName, port });
    const socket = net.connect(upstreamPort, '127.0.0.1');
    raw.push(socket);
    const stream = Duplex.from({ readable: socket, writable: socket });
    stream.on('close', () => socket.destroy());
    streams.push(stream);
    return stream;
  };
  proxy = createPreviewProxy({ openUpstream, resolve: resolveTarget });
  proxyPort = await listen(proxy);
});

afterEach(async () => {
  for (const s of raw) s.destroy();
  proxy.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([proxy, upstream].map((s) => new Promise((r) => s.close(r))));
});

function request(
  path: string,
  opts: { method?: string; host?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; rawHeaders: string[]; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path,
        method: opts.method ?? 'GET',
        headers: { host: opts.host ?? HOST, ...opts.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (d) => (body += d.toString()));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, rawHeaders: res.rawHeaders, body }),
        );
      },
    );
    req.on('error', reject);
    req.end(opts.body);
  });
}

async function until(done: () => boolean): Promise<void> {
  for (let i = 0; i < 100 && !done(); i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(done()).toBe(true);
}

function resolveTarget(id: string) {
  if (id === ID) return { containerName: CONTAINER, port: APP_PORT, revoked: revocation.signal };
  const other = others.get(id);
  return other ? { ...other, port: APP_PORT } : null;
}

function morePreviews(count: number): string[] {
  return Array.from({ length: count }, (_, i) => {
    const id = `${i + 1}`.padStart(32, 'a');
    others.set(id, { containerName: `nanoclaw-v2-other-${i + 1}`, revoked: new AbortController().signal });
    return `${id}.preview.example.test`;
  });
}

/** Sends a raw upgrade request and resolves with the first chunk the proxy answers. */
function upgrade(path: string, host = HOST): Promise<{ socket: net.Socket; first: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxyPort, '127.0.0.1', () =>
      socket.write(
        `GET ${path} HTTP/1.1\r\nHost: ${host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
          'Sec-WebSocket-Protocol: vite-hmr\r\nOrigin: https://' +
          `${host}\r\n\r\n`,
      ),
    );
    raw.push(socket);
    socket.once('data', (d) => resolve({ socket, first: d.toString() }));
    socket.on('error', reject);
  });
}

describe('preview proxy routing', () => {
  it('forwards method, path, query, headers and body to the preview container, with Host unchanged', async () => {
    const res = await request('/api/items?page=2&sort=name', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-example': 'kept', cookie: 'app=1' },
      body: '{"name":"widget"}',
    });
    expect(res.status).toBe(201);
    expect(res.body).toBe('from-app');
    expect(opened).toEqual([{ containerName: CONTAINER, port: APP_PORT }]);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ method: 'POST', url: '/api/items?page=2&sort=name', body: '{"name":"widget"}' });
    expect(hits[0].headers).toMatchObject({ host: HOST, 'x-example': 'kept', cookie: 'app=1' });
  });

  it('passes repeated response headers back and strips hop-by-hop ones both ways', async () => {
    const res = await request('/', { headers: { connection: 'x-drop-me', 'x-drop-me': '1', te: 'trailers' } });
    expect(res.headers['set-cookie']).toEqual(['a=1', 'b=2']);
    expect(res.rawHeaders).not.toContain('timeout=77');
    expect(hits[0].headers['x-drop-me']).toBeUndefined();
    expect(hits[0].headers.te).toBeUndefined();
  });

  it('reuses one upstream connection across sequential requests instead of a docker exec each', async () => {
    for (let i = 0; i < 15; i += 1) expect((await request(`/src/m${i}.ts`)).status).toBe(201);
    expect(opened).toHaveLength(1);
    // Each reuse must take back the listeners the last request left, or they pile up on a long-lived connection.
    expect(streams[0].listenerCount('error')).toBeLessThan(5);
  });

  it.each([
    ['an unknown id', `ffffffffffffffffffffffffffffffff.preview.example.test`],
    ['a host outside the suffix', `${ID}.preview.example.org`],
    ['an extra label', `x.${ID}.preview.example.test`],
    ['the bare suffix', 'preview.example.test'],
    ['a malformed id', 'not-an-id.preview.example.test'],
  ])('answers 404 for %s without touching any container', async (_label, host) => {
    const res = await request('/', { host });
    expect(res.status).toBe(404);
    expect(res.body).toBe('No live preview at this address.');
    expect(opened).toEqual([]);
  });

  it.each([
    '/@fs/workspace/worktrees/x/node_modules/.pnpm/vite@6.3.5/node_modules/vite/dist/client/env.mjs',
    '/@id//@fs/workspace/worktrees/x/packages/ui/src/button.tsx',
    '/%40fs/workspace/worktrees/x/node_modules/.vite/deps/react.js?v=1',
  ])('forwards %s, a file under the agent checkouts that a pnpm workspace serves through /@fs/', async (path) => {
    expect((await request(path)).status).toBe(201);
    expect(hits[0].url).toBe(path);
  });

  it.each([
    '/@fs/home/node/.aws/credentials',
    '/@fs/home/node/.gcp/service-account.json',
    '/@fs/workspace/agent/CLAUDE.md',
    '/@fs/workspace/extra/notes.md',
    '/@fs/workspace/worktrees',
    '/@fs/workspace/worktreesX/secret',
    '/@fs//workspace/worktrees/x/a.js',
    '/@FS/home/node/.aws/credentials',
    '/%40fs/home/node/.aws/credentials',
    '/%2540fs/home/node/.aws/credentials',
    '/@fs/home/node/%2Esnowflake/config',
    '/@id//@fs/home/node/.aws/credentials',
    '/@id/__x00__/@fs/workspace/agent/CLAUDE.md',
    '/@fs/workspace/worktrees/x/@fs/home/node/.aws/credentials',
  ])('refuses %s with 403, outside the agent checkouts', async (path) => {
    const res = await request(path);
    expect(res.status).toBe(403);
    expect(res.body).toBe("Preview serves files only from the agent's checkouts.");
    expect(opened).toEqual([]);
  });

  it.each([
    '/src/../../etc/passwd',
    '/@fs/workspace/worktrees/x/../../agent/CLAUDE.md',
    '/%40fs/workspace/worktrees/%2e%2e/agent/CLAUDE.md',
    '/src/%2e%2e/secret',
    '/src/%252e%252e/secret',
    '/src\\..\\secret',
    '/src%5csecret',
  ])('refuses %s with 403 before forwarding', async (path) => {
    const res = await request(path);
    expect(res.status).toBe(403);
    expect(opened).toEqual([]);
  });

  it('answers 400 to a path that does not decode', async () => {
    expect((await request('/src/%E0%A4%A')).status).toBe(400);
    expect(opened).toEqual([]);
  });

  it('answers 502 when nothing answers on the preview port', async () => {
    const failing = createPreviewProxy({
      openUpstream: () => {
        const d = new Duplex({
          read() {},
          write(_c, _e, cb) {
            cb();
          },
        });
        setImmediate(() => d.destroy());
        return d;
      },
      resolve: () => ({ containerName: CONTAINER, port: APP_PORT, revoked: new AbortController().signal }),
    });
    const port = await listen(failing);
    const status = await new Promise<number>((resolve, reject) =>
      http
        .get({ host: '127.0.0.1', port, path: '/', headers: { host: HOST } }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        })
        .on('error', reject),
    );
    failing.closeAllConnections();
    await new Promise((r) => failing.close(r));
    expect(status).toBe(502);
  });

  it('forwards a WebSocket upgrade (HMR) with Host and the handshake headers, then carries frames both ways', async () => {
    const { socket, first } = await upgrade('/?token=example');
    expect(first).toMatch(/^HTTP\/1\.1 101 /);
    expect(hits[0]).toMatchObject({ method: 'GET', url: '/?token=example' });
    expect(hits[0].headers).toMatchObject({
      host: HOST,
      upgrade: 'websocket',
      connection: 'Upgrade',
      'sec-websocket-protocol': 'vite-hmr',
      origin: `https://${HOST}`,
    });
    const echoed = new Promise<string>((resolve) => socket.once('data', (d) => resolve(d.toString())));
    socket.write('frame');
    expect(await echoed).toBe('echo:frame');
  });

  it('ending the preview cuts a WebSocket and a streaming response already open through it', async () => {
    const { socket } = await upgrade('/?token=example');
    const wsClosed = new Promise((resolve) => socket.on('close', resolve));
    const streamClosed = new Promise<string>((resolve, reject) => {
      const req = http.get({ host: '127.0.0.1', port: proxyPort, path: '/stream', headers: { host: HOST } }, (res) => {
        res.once('data', () => revocation.abort());
        res.on('close', () => resolve(res.complete ? 'complete' : 'cut'));
      });
      req.on('error', () => resolve('cut'));
      setTimeout(() => reject(new Error('stream never ended')), 3000);
    });
    expect(await streamClosed).toBe('cut');
    await wsClosed;
  });

  it('ending the preview also stops a request body the app answered before reading', async () => {
    const req = http.request({
      host: '127.0.0.1',
      port: proxyPort,
      path: '/early',
      method: 'POST',
      headers: { host: HOST, 'transfer-encoding': 'chunked' },
    });
    req.on('error', () => {});
    const answered = new Promise<void>((resolve) => req.on('response', (res) => res.resume().on('end', resolve)));
    req.write('before');
    await answered;
    await until(() => earlyBody === 'before');
    revocation.abort();
    await new Promise((resolve) => setTimeout(resolve, 50));
    req.write('after');
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(earlyBody).toBe('before');
    req.destroy();
  });

  it(`caps live WebSockets at ${MAX_UPGRADES_PER_PREVIEW} per preview, freeing a slot when one closes`, async () => {
    const open: { socket: net.Socket }[] = [];
    for (let i = 0; i < MAX_UPGRADES_PER_PREVIEW; i += 1) open.push(await upgrade('/'));
    expect((await upgrade('/')).first).toMatch(/^HTTP\/1\.1 503 /);
    expect(opened).toHaveLength(MAX_UPGRADES_PER_PREVIEW);
    const closed = new Promise((resolve) => open[0].socket.on('close', resolve));
    open[0].socket.destroy();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await upgrade('/')).first).toMatch(/^HTTP\/1\.1 101 /);
  });

  it(`caps live WebSockets across every preview at ${MAX_UPGRADES_TOTAL}, freeing a slot when one closes`, async () => {
    const hosts = [HOST, ...morePreviews(MAX_UPGRADES_TOTAL / MAX_UPGRADES_PER_PREVIEW)];
    const open: { socket: net.Socket }[] = [];
    for (let i = 0; i < MAX_UPGRADES_TOTAL; i += 1) open.push(await upgrade('/', hosts[i % (hosts.length - 1)]));
    const refused = await upgrade('/', hosts[hosts.length - 1]);
    expect(refused.first).toMatch(/^HTTP\/1\.1 503 /);
    expect(refused.first).toContain('on this host');
    expect(opened).toHaveLength(MAX_UPGRADES_TOTAL);
    const closed = new Promise((resolve) => open[0].socket.on('close', resolve));
    open[0].socket.destroy();
    await closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect((await upgrade('/', hosts[hosts.length - 1])).first).toMatch(/^HTTP\/1\.1 101 /);
  });

  it('refuses an upgrade for an unknown id or a refused path', async () => {
    expect((await upgrade('/', `ffffffffffffffffffffffffffffffff.preview.example.test`)).first).toMatch(
      /^HTTP\/1\.1 404 /,
    );
    expect((await upgrade('/src/%2e%2e/secret')).first).toMatch(/^HTTP\/1\.1 403 /);
    expect((await upgrade('/@id//@fs/home/node/.aws/credentials')).first).toMatch(/^HTTP\/1\.1 403 /);
    expect(opened).toEqual([]);
  });
});

describe('the app host', () => {
  const APP = 'app.preview.example.test';

  it.each([APP, APP.toUpperCase()])('hands %s to the app API, ahead of any preview', async (host) => {
    const notFound = await request('/v1/no-such-route', { host });
    expect([notFound.status, JSON.parse(notFound.body)]).toEqual([404, { error: 'Not found.' }]);

    const page = await request('/pair', { host });
    expect([page.status, page.headers['content-type']]).toEqual([200, 'text/html; charset=utf-8']);
    expect(hits).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('leaves every other host to the preview routing', async () => {
    expect((await request('/pair')).body).toBe('from-app');
    for (const host of ['app.other.example.test', 'x.app.preview.example.test']) {
      expect((await request('/pair', { host })).body).toBe('No live preview at this address.');
    }
  });

  it('offers no WebSocket on the app host', async () => {
    expect((await upgrade('/pair', APP)).first).toMatch(/^HTTP\/1\.1 404 /);
    expect(opened).toEqual([]);
  });
});

describe('preview proxy over the docker-exec bridge', () => {
  type FakeExec = EventEmitter & { stdin: PassThrough; stdout: PassThrough; kill: ReturnType<typeof vi.fn> };
  let children: FakeExec[];
  let uncaught: unknown[];
  const onUncaught = (err: unknown) => uncaught.push(err);

  /** A `docker exec` whose pipes carry a real connection to the app, so the real openContainerLoopback wraps it. */
  function fakeExec(behavior: 'relay' | 'exits' | 'unspawnable' | 'out of file descriptors'): FakeExec {
    const child = Object.assign(new EventEmitter(), {
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      kill: vi.fn(() => true),
    });
    if (behavior === 'out of file descriptors') {
      // What Node's spawn returns on EMFILE/ENFILE: no pipes, and the failure on the next tick.
      Object.assign(child, { stdin: undefined, stdout: undefined });
      process.nextTick(() => child.emit('error', Object.assign(new Error('spawn docker EMFILE'), { code: 'EMFILE' })));
      return child;
    }
    children.push(child);
    if (behavior === 'relay') {
      const socket = net.connect(upstreamPort, '127.0.0.1');
      raw.push(socket);
      child.stdin.pipe(socket).pipe(child.stdout);
      child.kill.mockImplementation(() => {
        socket.destroy();
        setImmediate(() => child.emit('exit', null, 'SIGTERM'));
        return true;
      });
    } else if (behavior === 'exits') {
      setImmediate(() => child.emit('exit', 1, null));
    } else {
      process.nextTick(() => child.emit('error', Object.assign(new Error('spawn docker EAGAIN'), { code: 'EAGAIN' })));
    }
    return child;
  }

  async function bridgedProxy(behavior: Parameters<typeof fakeExec>[0]) {
    vi.mocked(spawn).mockImplementation((() => fakeExec(behavior)) as unknown as typeof spawn);
    const server = createPreviewProxy({
      openUpstream: openContainerLoopback,
      resolve: resolveTarget,
    });
    const port = await listen(server);
    const get = (path = '/', host = HOST) =>
      new Promise<{ status: number; body: string }>((resolve, reject) =>
        http
          .get({ host: '127.0.0.1', port, path, agent: false, headers: { host } }, (res) => {
            let body = '';
            res.on('data', (d) => (body += d.toString()));
            res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
          })
          .on('error', reject),
      );
    const close = () => new Promise((r) => server.close(r));
    return { port, get, close };
  }

  beforeEach(() => {
    children = [];
    uncaught = [];
    process.on('uncaughtException', onUncaught);
    // The host's own handler exits on an uncaught exception, which would end the run before the assertion reads it.
    vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
  });

  afterEach(() => {
    process.off('uncaughtException', onUncaught);
    vi.mocked(spawn).mockRestore();
    vi.restoreAllMocks();
  });

  it('survives a page load of more parallel requests than the agent pools, and kills every exec it drops', async () => {
    const warn = vi.spyOn(log, 'warn');
    const { get, close } = await bridgedProxy('relay');
    const pending = Promise.all(Array.from({ length: 120 }, () => get('/held')));
    await until(() => held.length === 16);
    const release = setInterval(() => held.splice(0).forEach((answer) => answer()), 5);
    const results = await pending;
    clearInterval(release);
    await new Promise((resolve) => setImmediate(resolve));
    expect(uncaught).toEqual([]);
    // The agent itself drops what its free pool cannot hold, before the server closes.
    await until(() => children.some((c) => c.kill.mock.calls.length > 0));
    await close();
    await until(() => children.every((c) => c.kill.mock.calls.length > 0));
    expect(uncaught).toEqual([]);
    expect(results.filter((r) => r.status !== 200 || r.body !== 'from-app')).toEqual([]);
    expect(warn).not.toHaveBeenCalled();
  });

  it(`holds at most ${MAX_UPSTREAM_CONNECTIONS} execs across every preview, queueing the rest`, async () => {
    const { get, close } = await bridgedProxy('relay');
    const hosts = [HOST, ...morePreviews(3)];
    const pending = Promise.all(hosts.flatMap((host) => Array.from({ length: 20 }, () => get('/held', host))));
    await until(() => held.length === MAX_UPSTREAM_CONNECTIONS);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held).toHaveLength(MAX_UPSTREAM_CONNECTIONS);
    expect(children).toHaveLength(MAX_UPSTREAM_CONNECTIONS);
    const release = setInterval(() => held.splice(0).forEach((answer) => answer()), 5);
    const results = await pending;
    clearInterval(release);
    await close();
    expect(uncaught).toEqual([]);
    expect(results.filter((r) => r.status !== 200 || r.body !== 'from-app')).toEqual([]);
  });

  it('cuts a response whose exec dies in the middle of the body', async () => {
    const { port, close } = await bridgedProxy('relay');
    const outcome = await new Promise<string>((resolve) =>
      http
        .get({ host: '127.0.0.1', port, path: '/stream', agent: false, headers: { host: HOST } }, (res) => {
          res.once('data', () => children[0].emit('exit', null, 'SIGKILL'));
          res.on('close', () => resolve(res.complete ? 'complete' : 'cut'));
        })
        .on('error', () => resolve('cut')),
    );
    await close();
    expect(outcome).toBe('cut');
    expect(uncaught).toEqual([]);
  });

  it.each([
    ['exits before answering', 'exits'],
    ['cannot be spawned', 'unspawnable'],
    ['cannot be spawned for lack of file descriptors', 'out of file descriptors'],
  ] as const)('answers 502 when the exec %s', async (_label, behavior) => {
    const { get, close } = await bridgedProxy(behavior);
    expect((await get()).status).toBe(502);
    await close();
    await new Promise((resolve) => setImmediate(resolve));
    expect(uncaught).toEqual([]);
  });
});

describe('pathVerdict / previewIdFromHost', () => {
  it('lets ordinary dev-server paths through', () => {
    for (const p of [
      '/',
      '/src/main.tsx?t=123',
      '/@vite/client',
      '/@id/react',
      '/@fs/workspace/worktrees/x/node_modules/vite/dist/client/client.mjs',
      '/node_modules/.vite/deps/react.js?v=1',
    ])
      expect(pathVerdict(p)).toBeNull();
  });

  it('accepts the id case-insensitively and nothing else', () => {
    expect(previewIdFromHost(HOST.toUpperCase())).toBe(ID);
    expect(previewIdFromHost(`${HOST}:443`)).toBeNull();
    expect(previewIdFromHost(undefined)).toBeNull();
  });
});
