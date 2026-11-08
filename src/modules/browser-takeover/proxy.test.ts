import http from 'http';
import net from 'net';
import type { AddressInfo } from 'net';
import type { Duplex } from 'stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createTakeoverProxy, DASHBOARD_TOKEN_COOKIE, TAKEOVER_COOKIE } from './proxy.js';

vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  BROWSER_TAKEOVER_ORIGIN: 'https://browser.example.test',
}));

const BINDING = 'binding-0123456789abcdef';
const WIDENED_LINK = 'link-widened-0123456789';
const DOLLAR_HOST_LINK = 'link-dollar-host-012345';
const CONTAINER = 'nanoclaw-v2-example-1';
const DASHBOARD = `${DASHBOARD_TOKEN_COOKIE}=dash-token`;

let upstream: http.Server;
let proxy: http.Server;
let proxyPort: number;
let upstreamHits: http.IncomingMessage[];
let opened: string[];
let upgraded: Duplex[];
let spends: string[];

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

function request(
  path: string,
  opts: { method?: string; cookie?: string; headers?: http.OutgoingHttpHeaders } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: proxyPort,
        path,
        method: opts.method ?? 'GET',
        headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...opts.headers },
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function rawUpgrade(
  cookie: string | null,
  method = 'GET',
  path = '/api/session/1/stream',
  origin: string | null = 'https://browser.example.test',
): Promise<string> {
  return new Promise((resolve, reject) => {
    const sock = net.connect(proxyPort, '127.0.0.1', () => {
      sock.write(
        `${method} ${path} HTTP/1.1\r\nHost: 127.0.0.1:3001\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n` +
          (origin ? `Origin: ${origin}\r\n` : '') +
          (cookie ? `Cookie: ${cookie}\r\n` : '') +
          '\r\n',
      );
    });
    let got = '';
    let pinged = false;
    const done = () => {
      sock.destroy();
      resolve(got);
    };
    sock.on('data', (d) => {
      got += d.toString();
      if (got.includes('pong')) return done();
      if (!got.includes('\r\n\r\n')) return;
      if (!got.includes(' 101 ')) return done();
      if (!pinged) {
        pinged = true;
        sock.write('ping');
      }
    });
    sock.on('close', () => resolve(got));
    sock.on('error', reject);
  });
}

beforeEach(async () => {
  upstreamHits = [];
  upgraded = [];
  spends = [];
  opened = [];
  upstream = http.createServer((req, res) => {
    upstreamHits.push(req);
    res.setHeader('Set-Cookie', [`${TAKEOVER_COOKIE}=forged; Path=/`, 'dash=1; Path=/']);
    res.end('dashboard');
  });
  upstream.on('upgrade', (req, socket) => {
    upstreamHits.push(req);
    upgraded.push(socket);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.on('data', (d) => socket.write(d.toString() === 'ping' ? 'pong' : 'unexpected'));
  });
  const upstreamPort = await listen(upstream);
  proxy = createTakeoverProxy({
    openUpstream: (name) => {
      opened.push(name);
      return net.connect(upstreamPort, '127.0.0.1');
    },
    describeLink: (token) => {
      if (token === WIDENED_LINK) return { host: 'app.example.com', extraHosts: ['login.idp.example'] };
      if (token === DOLLAR_HOST_LINK) return { host: "$'.example.com", extraHosts: ['login.idp.example'] };
      return null;
    },
    consumeLink: (token) =>
      spends.push(token) && token === 'link-0123456789abcdef' ? { bindingId: BINDING, maxAgeSeconds: 7200 } : null,
    resolveBinding: (id) => (id === BINDING ? { containerName: CONTAINER, dashboardToken: 'dash-token' } : null),
  });
  proxyPort = await listen(proxy);
});

afterEach(async () => {
  for (const socket of upgraded) socket.destroy();
  proxy.closeAllConnections();
  upstream.closeAllConnections();
  await Promise.all([proxy, upstream].map((s) => new Promise((r) => s.close(r))));
});

describe('browser takeover proxy', () => {
  it('a GET of a link spends nothing, so a link scanner or unfurler cannot burn it', async () => {
    const res = await request('/t/link-0123456789abcdef');
    expect(res.status).toBe(200);
    expect(res.body).toContain('<form method="post"');
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(spends).toEqual([]);
  });

  it('shows an ordinary link the same page it always did', async () => {
    const res = await request('/t/link-0123456789abcdef');
    expect(res.body).toBe(
      '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
        '<title>Agent browser takeover</title>' +
        '<form method="post" style="font:16px system-ui;margin:20vh auto;max-width:28em;text-align:center">' +
        '<p>An agent is waiting for you to sign in in its browser. This link works once.</p>' +
        '<button style="font:inherit;padding:.6em 1.2em">Open the agent\'s browser</button></form>',
    );
  });

  it('names what a widened link hands over before the owner presses anything, and spends nothing', async () => {
    const res = await request(`/t/${WIDENED_LINK}`);
    expect(res.body).toContain(
      '<p>This agent alone gets its session for <b>app.example.com</b> and your sign-in at ' +
        '<b>login.idp.example</b>. That sign-in can open other apps that use it, not only app.example.com.</p>',
    );
    expect(spends).toEqual([]);
  });

  it('prints a host the agent supplied literally, whatever a replacement pattern would make of it', async () => {
    const res = await request(`/t/${DOLLAR_HOST_LINK}`);
    expect(res.body).toContain('<b>$&#39;.example.com</b>');
    expect(res.body.match(/<button/g)).toHaveLength(1);
  });

  it('answers the viewer that the host is alive from the host alone, and only to a bound viewer', async () => {
    expect((await request('/alive')).status).toBe(403);

    const res = await request('/alive', { cookie: `${TAKEOVER_COOKIE}=${BINDING}` });

    expect(res.status).toBe(204);
    expect(opened).toEqual([]);
  });

  it('a POST spends the link into an HttpOnly host cookie and sends the viewer to the page', async () => {
    const res = await request('/t/link-0123456789abcdef', { method: 'POST' });
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe('/');
    expect(res.headers['set-cookie']).toEqual([
      `${TAKEOVER_COOKIE}=${BINDING}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=7200`,
    ]);
    expect(spends).toEqual(['link-0123456789abcdef']);
    expect(opened).toEqual([]);
  });

  it('answers 410 for a link it cannot spend', async () => {
    const res = await request('/t/link-unknown-0000000000', { method: 'POST' });
    expect(res.status).toBe(410);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('answers 400 to a request target the URL parser rejects, instead of throwing out of the handler', async () => {
    const got = await new Promise<string>((resolve, reject) => {
      const sock = net.connect(proxyPort, '127.0.0.1', () => sock.write('GET //[ HTTP/1.1\r\nHost: x\r\n\r\n'));
      let data = '';
      sock.on('data', (d) => {
        data += d.toString();
        if (data.includes('\r\n\r\n')) sock.destroy();
      });
      sock.on('close', () => resolve(data));
      sock.on('error', reject);
    });
    expect(got).toMatch(/^HTTP\/1\.1 400 /);
  });

  it('refuses a request with no live binding without touching any container', async () => {
    expect((await request('/')).status).toBe(403);
    expect((await request('/', { cookie: `${TAKEOVER_COOKIE}=stale` })).status).toBe(403);
    expect(opened).toEqual([]);
  });

  it('serves its own viewer page to a bound browser, without touching the container', async () => {
    const res = await request('/', { cookie: `${TAKEOVER_COOKIE}=${BINDING}` });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(res.headers['content-security-policy']).toContain("default-src 'none'");
    expect(res.headers['content-security-policy']).toContain("frame-ancestors 'none'");
    expect(res.headers['content-security-policy']).toContain("connect-src 'self' wss://browser.example.test");
    expect(res.body).toContain('/api/sessions');
    expect(opened).toEqual([]);
  });

  it('forwards the session list with only the dashboard token and the origin it requires, and no cookie back', async () => {
    const res = await request('/api/sessions', { cookie: `a=1; ${TAKEOVER_COOKIE}=${BINDING}; dash=2` });
    expect(res.status).toBe(200);
    expect(res.body).toBe('dashboard');
    expect(opened).toEqual([CONTAINER]);
    expect(upstreamHits[0].headers.cookie).toBe(DASHBOARD);
    expect(upstreamHits[0].headers.origin).toBe('https://browser.example.test');
    expect(upstreamHits[0].headers.host).toBe('browser.example.test');
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it.each(['/api/exec', '/api/session/1/tabs', '/_next/static/chunks/app.js', '/api/sessions/extra'])(
    'answers 404 to the dashboard path %s instead of forwarding it',
    async (path) => {
      const res = await request(path, { cookie: `${TAKEOVER_COOKIE}=${BINDING}` });
      expect(res.status).toBe(404);
      expect(opened).toEqual([]);
    },
  );

  it('blocks every write method, so the dashboard exec API is unreachable', async () => {
    const res = await request('/api/exec', { method: 'POST', cookie: `${TAKEOVER_COOKIE}=${BINDING}` });
    expect(res.status).toBe(405);
    expect(opened).toEqual([]);
  });

  it('bridges a bound session-stream upgrade both ways, presenting only the dashboard token upstream', async () => {
    const got = await rawUpgrade(`${TAKEOVER_COOKIE}=${BINDING}; dash=2`);
    expect(got).toContain('101 Switching Protocols');
    expect(got).toContain('pong');
    expect(upstreamHits[0].headers.cookie).toBe(DASHBOARD);
    expect(upstreamHits[0].headers.origin).toBe('https://browser.example.test');
    expect(upstreamHits[0].headers.host).toBe('browser.example.test');
    expect(opened).toEqual([CONTAINER]);
  });

  it.each([['https://board.example.test'], ['https://browser.example.test.evil.test'], [null]])(
    'refuses a bound stream upgrade opened by another page (Origin %s), since the proxy vouches for the origin upstream',
    async (origin) => {
      const got = await rawUpgrade(`${TAKEOVER_COOKIE}=${BINDING}`, 'GET', '/api/session/1/stream', origin);
      expect(got).toContain('403 Forbidden');
      expect(opened).toEqual([]);
    },
  );

  it.each([
    [{ origin: 'https://board.example.test' }],
    [{ 'sec-fetch-site': 'same-site' }],
    [{ 'sec-fetch-site': 'cross-site' }],
  ])('refuses the session list to a request from another page (%j)', async (headers) => {
    const res = await request('/api/sessions', { cookie: `${TAKEOVER_COOKIE}=${BINDING}`, headers });
    expect(res.status).toBe(403);
    expect(opened).toEqual([]);
  });

  it('answers HEAD with 405 like every other non-GET method', async () => {
    const res = await request('/', { method: 'HEAD', cookie: `${TAKEOVER_COOKIE}=${BINDING}` });
    expect(res.status).toBe(405);
  });

  it('refuses a write method smuggled in as an upgrade, so the exec API stays unreachable', async () => {
    const got = await rawUpgrade(`${TAKEOVER_COOKIE}=${BINDING}`, 'POST');
    expect(got).toContain('405 Method Not Allowed');
    expect(opened).toEqual([]);
  });

  it('refuses an upgrade of any other dashboard path', async () => {
    const got = await rawUpgrade(`${TAKEOVER_COOKIE}=${BINDING}`, 'GET', '/api/events');
    expect(got).toContain('404 Not Found');
    expect(opened).toEqual([]);
  });

  it('refuses an unbound WebSocket upgrade', async () => {
    const got = await rawUpgrade(null);
    expect(got).toContain('403 Forbidden');
    expect(opened).toEqual([]);
  });
});
