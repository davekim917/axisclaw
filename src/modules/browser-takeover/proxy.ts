import http from 'http';
import type { Duplex } from 'stream';

import { BROWSER_TAKEOVER_ORIGIN, BROWSER_TAKEOVER_PORT } from '../../config.js';
import { log } from '../../log.js';
import { DASHBOARD_CONTAINER_PORT, openContainerLoopback } from './bridge.js';
import { escapeHtml } from '../mcp-oauth/loopback.js';
import { consumeTakeoverLink, describeTakeoverLink, resolveTakeoverBinding } from './service.js';
import { VIEWER_PAGE } from './viewer.js';

export const TAKEOVER_COOKIE = '__Host-nc-browser-takeover';
export const DASHBOARD_TOKEN_COOKIE = '__Host-agent-browser-dashboard-token';
const LINK_PATH_RE = /^\/t\/([A-Za-z0-9_-]{16,128})$/;
const STREAM_PATH_RE = /^\/api\/session\/\d{1,5}\/stream$/;
const SESSIONS_PATH = '/api/sessions';
const ALIVE_PATH = '/alive';
// The sidecar's dashboard allowlists exactly BROWSER_TAKEOVER_ORIGIN, and a tunnel may rewrite Host on the way in.
const UPSTREAM_HOST = BROWSER_TAKEOVER_ORIGIN.replace(/^https?:\/\//, '');
const CONFIRM_PAGE =
  '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
  '<title>Agent browser takeover</title>' +
  '<form method="post" style="font:16px system-ui;margin:20vh auto;max-width:28em;text-align:center">' +
  '<p>An agent is waiting for you to sign in in its browser. This link works once.</p>' +
  '<button style="font:inherit;padding:.6em 1.2em">Open the agent\'s browser</button></form>';
// Safari before CSP Level 3 does not let 'self' match a wss: URL, so the stream's origin is named outright.
const VIEWER_CSP =
  "default-src 'none'; frame-ancestors 'none'; img-src data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  `connect-src 'self' ${BROWSER_TAKEOVER_ORIGIN.replace(/^http/, 'ws')}`;

export interface TakeoverProxyDeps {
  openUpstream: (containerName: string) => Duplex;
  describeLink: typeof describeTakeoverLink;
  consumeLink: typeof consumeTakeoverLink;
  resolveBinding: typeof resolveTakeoverBinding;
}

const defaultDeps: TakeoverProxyDeps = {
  openUpstream: (name) => openContainerLoopback(name, DASHBOARD_CONTAINER_PORT),
  describeLink: describeTakeoverLink,
  consumeLink: consumeTakeoverLink,
  resolveBinding: resolveTakeoverBinding,
};

function bindingId(req: http.IncomingMessage): string | null {
  const pair = (req.headers.cookie ?? '')
    .split(';')
    .map((p) => p.trim())
    .find((p) => p.startsWith(`${TAKEOVER_COOKIE}=`));
  return pair ? pair.slice(TAKEOVER_COOKIE.length + 1) : null;
}

function confirmPage(link: ReturnType<typeof describeTakeoverLink>): string {
  if (!link || link.extraHosts.length === 0) return CONFIRM_PAGE;
  const host = escapeHtml(link.host);
  const extra = link.extraHosts.map(escapeHtml).join(', ');
  return CONFIRM_PAGE.replace(
    '<button',
    () =>
      `<p>This agent alone gets its session for <b>${host}</b> and your sign-in at <b>${extra}</b>. ` +
      `That sign-in can open other apps that use it, not only ${host}.</p><button`,
  );
}

const dashboardCookie = (token: string) => `${DASHBOARD_TOKEN_COOKIE}=${encodeURIComponent(token)}`;

// The proxy presents the trusted origin upstream, so the dashboard's own origin check no longer says which page is
// asking; a same-site page carries the Lax binding cookie, so the browser's own headers are checked here instead.
// A WebSocket handshake always carries Origin; a same-origin fetch carries none, but may carry Sec-Fetch-Site.
const fromViewer = (req: http.IncomingMessage) => {
  const { origin } = req.headers;
  const site = req.headers['sec-fetch-site'];
  return origin !== undefined ? origin === BROWSER_TAKEOVER_ORIGIN : site === undefined || site === 'same-origin';
};

function plain(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

/**
 * Serves the takeover origin: `/t/<link>` spends a link and pins the viewer to one sidecar, `/` is the viewer page, and
 * the only requests forwarded to the sidecar's agent-browser dashboard are the two that page needs, a GET of its
 * session list and the GET upgrade of a session stream. Everything else the dashboard serves (`/api/exec` runs
 * arbitrary agent-browser commands) stays out of reach.
 */
export function createTakeoverProxy(deps: TakeoverProxyDeps = defaultDeps): http.Server {
  const { openUpstream, describeLink, consumeLink, resolveBinding } = deps;
  const bindingFor = (req: http.IncomingMessage) => {
    const id = bindingId(req);
    return id ? resolveBinding(id) : null;
  };
  const server = http.createServer((req, res) => {
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://takeover.invalid').pathname;
    } catch {
      plain(res, 400, 'Bad request.');
      return;
    }
    const link = LINK_PATH_RE.exec(path);
    // Link unfurlers and mail/chat safe-link scanners GET a URL before its owner does; only a submitted form spends it.
    if (link && req.method === 'GET') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end(confirmPage(describeLink(link[1])));
      return;
    }
    if (link && req.method === 'POST') {
      const spent = consumeLink(link[1]);
      if (!spent) {
        plain(res, 410, 'This takeover link has expired or was already used. Ask the agent for a new one.');
        return;
      }
      res.writeHead(303, {
        'Set-Cookie': `${TAKEOVER_COOKIE}=${spent.bindingId}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${spent.maxAgeSeconds}`,
        Location: '/',
        'Cache-Control': 'no-store',
        'Referrer-Policy': 'no-referrer',
      });
      res.end();
      return;
    }

    const binding = bindingFor(req);
    if (!binding) {
      plain(res, 403, 'No active browser takeover. Open the link the agent sent you.');
      return;
    }
    if (req.method !== 'GET') {
      plain(res, 405, 'Only viewing and the live viewport are available during a takeover.');
      return;
    }
    if (path === '/') {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': VIEWER_CSP,
        'Referrer-Policy': 'no-referrer',
      });
      res.end(VIEWER_PAGE);
      return;
    }
    if (path === ALIVE_PATH) {
      res.writeHead(204, { 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (path !== SESSIONS_PATH) {
      plain(res, 404, 'Not found.');
      return;
    }
    if (!fromViewer(req)) {
      plain(res, 403, 'Only the takeover viewer may read the session list.');
      return;
    }

    const upstream = http.request(
      {
        method: 'GET',
        path: SESSIONS_PATH,
        headers: {
          host: UPSTREAM_HOST,
          // A same-origin GET carries no Origin, and the dashboard answers only one naming its allowed origin.
          origin: BROWSER_TAKEOVER_ORIGIN,
          accept: 'application/json',
          cookie: dashboardCookie(binding.dashboardToken),
        },
        createConnection: () => openUpstream(binding.containerName),
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, {
          'Content-Type': upRes.headers['content-type'] ?? 'application/json',
          'Cache-Control': 'no-store',
        });
        // An upstream lost mid-body ends the response with no error to report, and pipe() never ends res for it.
        upRes.on('close', () => {
          if (!upRes.complete) res.destroy();
        });
        upRes.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      log.warn('Browser takeover: upstream request failed', { containerName: binding.containerName, err });
      if (!res.headersSent) plain(res, 502, 'The agent browser did not answer.');
      else res.destroy();
    });
    upstream.end();
  });

  // Node routes any request carrying `Upgrade` here, whatever its method, so the read-only rule is enforced again:
  // a WebSocket handshake is always a GET.
  server.on('upgrade', (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
    const binding = bindingFor(req);
    if (!binding) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    if (req.method !== 'GET') {
      socket.end('HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\n\r\n');
      return;
    }
    let path: string;
    try {
      path = new URL(req.url ?? '/', 'http://takeover.invalid').pathname;
    } catch {
      path = '';
    }
    if (!STREAM_PATH_RE.test(path)) {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }
    if (req.headers.origin !== BROWSER_TAKEOVER_ORIGIN) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const upstream = openUpstream(binding.containerName);
    const lines = [`GET ${path} HTTP/1.1`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      if (['cookie', 'host', 'origin'].includes(name.toLowerCase())) continue;
      lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    lines.push(`Host: ${UPSTREAM_HOST}`, `Origin: ${BROWSER_TAKEOVER_ORIGIN}`);
    lines.push(`Cookie: ${dashboardCookie(binding.dashboardToken)}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    const close = () => {
      upstream.destroy();
      socket.destroy();
    };
    upstream.on('error', close);
    socket.on('error', close);
    upstream.on('close', close);
    socket.on('close', close);
  });

  return server;
}

let running: http.Server | null = null;

/** Loopback only: the tunnel that serves BROWSER_TAKEOVER_ORIGIN is the sole way in. No origin, no listener. */
export function startBrowserTakeoverProxy(): void {
  if (running || !BROWSER_TAKEOVER_ORIGIN) return;
  running = createTakeoverProxy();
  running.on('error', (err) => log.error('Browser takeover proxy failed', { port: BROWSER_TAKEOVER_PORT, err }));
  running.listen(BROWSER_TAKEOVER_PORT, '127.0.0.1', () =>
    log.info('Browser takeover proxy started', { port: BROWSER_TAKEOVER_PORT, origin: BROWSER_TAKEOVER_ORIGIN }),
  );
}
