import http from 'http';
import type { Socket } from 'net';
import type { Duplex } from 'stream';

import { PREVIEW_ORIGIN_SUFFIX, PREVIEW_PORT } from '../../config.js';
import { log } from '../../log.js';
import { openContainerLoopback } from '../browser-takeover/bridge.js';
import { handleMobileRequest, isMobileHost } from '../mobile/http.js';
import { handleGroupCallRequest, handleGroupCallUpgrade } from '../voice-call/group/http.js';
import { handleVoiceCallRequest } from '../voice-call/http.js';
import { PREVIEW_ID_RE, resolvePreview } from './service.js';

// Below Node's default 5s server keepAliveTimeout (Vite's dev server is a Node server), so the proxy drops an idle
// upstream connection before the app can close it under a request being written to it.
const UPSTREAM_IDLE_MS = 2_000;
const MAX_DECODE_ROUNDS = 4;
/** Each WebSocket holds its own `docker exec` and relay for its whole life, outside the HTTP pool's socket cap. */
export const MAX_UPGRADES_PER_PREVIEW = 32;
// Across every preview on the host: each upstream connection is a host `docker exec` process of roughly 25 MB, so
// these two bound those processes at about 2.5 GB. Requests waiting for a connection are not bounded.
export const MAX_UPSTREAM_CONNECTIONS = 48;
export const MAX_UPGRADES_TOTAL = 64;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
// A WebSocket handshake needs its own Connection and Upgrade headers.
const UPGRADE_DROP = new Set([...HOP_BY_HOP].filter((h) => h !== 'connection' && h !== 'upgrade'));

export interface PreviewProxyDeps {
  openUpstream: (containerName: string, port: number) => Duplex;
  resolve: typeof resolvePreview;
}

const defaultDeps: PreviewProxyDeps = { openUpstream: openContainerLoopback, resolve: resolvePreview };

/** Hop-by-hop headers, plus any the message's own Connection header names, are dropped; the rest pass in order. */
function endToEndHeaders(raw: string[], drop: ReadonlySet<string> = HOP_BY_HOP): string[] {
  const named = new Set<string>();
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() !== 'connection' || !drop.has('connection')) continue;
    for (const token of raw[i + 1].split(',')) named.add(token.trim().toLowerCase());
  }
  const out: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i].toLowerCase();
    if (drop.has(name) || named.has(name)) continue;
    out.push(raw[i], raw[i + 1]);
  }
  return out;
}

const BAD_REQUEST = { status: 400, body: 'Bad request.' } as const;
const ESCAPES_ROOT = { status: 403, body: 'This path is not served through a live preview.' } as const;
const OUTSIDE_CHECKOUTS = { status: 403, body: "Preview serves files only from the agent's checkouts." } as const;
/** Where an agent container mounts its repository checkouts, and so the only files `/@fs/` may reach. */
const FS_ALLOWED_ROOT = '/workspace/worktrees/';
const FS_PREFIX = '/@fs';

/**
 * Decoded to a fixed point first, so no encoding gets past either rule. `..` or a backslash is how a path escapes the
 * app's root. `/@fs/<absolute path>` reads any file the dev server's `server.fs.allow` admits, which by default is the
 * whole workspace root it detects and can reach the credentials mounted under /home/node, so every `/@fs/` in the
 * path, including after `/@id/`, must name a file under the checkouts. pnpm resolves Vite's client and deps to the
 * checkout's own node_modules/.pnpm, so a monorepo still loads.
 */
export function pathVerdict(target: string | undefined): { status: 400 | 403; body: string } | null {
  if (!target?.startsWith('/')) return BAD_REQUEST;
  let path = target.split('?')[0];
  for (let round = 0; ; round += 1) {
    if (round === MAX_DECODE_ROUNDS) return BAD_REQUEST;
    let next: string;
    try {
      next = decodeURIComponent(path);
    } catch (err) {
      if (err instanceof URIError) return BAD_REQUEST;
      throw err;
    }
    if (next === path) break;
    path = next;
  }
  if (path.includes('..') || path.includes('\\')) return ESCAPES_ROOT;
  const lower = path.toLowerCase();
  for (let at = lower.indexOf(`${FS_PREFIX}/`); at !== -1; at = lower.indexOf(`${FS_PREFIX}/`, at + 1)) {
    if (!path.startsWith(FS_ALLOWED_ROOT, at + FS_PREFIX.length)) return OUTSIDE_CHECKOUTS;
  }
  return null;
}

/** The id is the Host's first label, and the rest must be exactly the configured suffix. */
export function previewIdFromHost(host: string | undefined): string | null {
  if (!host || !PREVIEW_ORIGIN_SUFFIX) return null;
  const tail = `.${PREVIEW_ORIGIN_SUFFIX}`;
  const lower = host.toLowerCase();
  if (!lower.endsWith(tail)) return null;
  const id = lower.slice(0, -tail.length);
  return PREVIEW_ID_RE.test(id) ? id : null;
}

/**
 * Keeps upstream connections open between requests, since each one is a `docker exec` and a dev page loads hundreds
 * of modules. The bridge stream is not a net.Socket, so the socket-tuning calls the base Agent makes are no-ops on it.
 */
class ContainerAgent extends http.Agent {
  private readonly idle = new WeakMap<Duplex, NodeJS.Timeout>();

  constructor(private readonly openUpstream: PreviewProxyDeps['openUpstream']) {
    super({ keepAlive: true, maxSockets: 16, maxFreeSockets: 8, maxTotalSockets: MAX_UPSTREAM_CONNECTIONS });
  }

  override createConnection(options: http.ClientRequestArgs): Duplex {
    const stream = this.openUpstream(String(options.host), Number(options.port));
    const self = () => stream;
    return Object.assign(stream, { ref: self, unref: self, setKeepAlive: self, setNoDelay: self, setTimeout: self });
  }

  override keepSocketAlive(socket: Duplex): boolean {
    // Node returns whether the socket may be kept; @types/node declares it void.
    const kept = super.keepSocketAlive(socket) as unknown as boolean;
    if (kept) {
      const timer = setTimeout(() => socket.destroy(), UPSTREAM_IDLE_MS);
      timer.unref();
      this.idle.set(socket, timer);
    }
    return kept;
  }

  override reuseSocket(socket: Duplex, request: http.ClientRequest): void {
    clearTimeout(this.idle.get(socket));
    this.idle.delete(socket);
    super.reuseSocket(socket, request);
  }
}

function plain(res: http.ServerResponse, status: number, body: string): void {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  403: 'Forbidden',
  404: 'Not Found',
  503: 'Service Unavailable',
};
const NOT_FOUND = 'No live preview at this address.';

/**
 * Serves `https://<id>.<PREVIEW_ORIGIN_SUFFIX>`: forwards every request, WebSocket upgrades included, to the port the
 * agent opened inside its own container. Host passes through unchanged because the app allowlists the preview host.
 */
export function createPreviewProxy(deps: PreviewProxyDeps = defaultDeps): http.Server {
  const { openUpstream, resolve } = deps;
  const agent = new ContainerAgent(openUpstream);
  const liveUpgrades = new WeakMap<AbortSignal, number>();
  let totalUpgrades = 0;
  const targetFor = (req: http.IncomingMessage) => {
    const id = previewIdFromHost(req.headers.host);
    return id ? resolve(id) : null;
  };

  const server = http.createServer((req, res) => {
    if (isMobileHost(req.headers.host)) {
      handleMobileRequest(req, res);
      return;
    }
    const id = previewIdFromHost(req.headers.host);
    if (id && (handleVoiceCallRequest(id, req, res) || handleGroupCallRequest(id, req, res))) return;
    const target = targetFor(req);
    if (!target) {
      plain(res, 404, NOT_FOUND);
      return;
    }
    const verdict = pathVerdict(req.url);
    if (verdict) {
      plain(res, verdict.status, verdict.body);
      return;
    }
    const upstream = http.request(
      {
        agent,
        host: target.containerName,
        port: target.port,
        setHost: false,
        method: req.method,
        path: req.url,
        headers: endToEndHeaders(req.rawHeaders),
      },
      (upRes) => {
        res.writeHead(upRes.statusCode ?? 502, upRes.statusMessage, endToEndHeaders(upRes.rawHeaders));
        // An upstream lost mid-body ends the response with no error to report, and pipe() never ends res for it.
        upRes.on('close', () => {
          if (!upRes.complete) res.destroy();
        });
        upRes.pipe(res);
      },
    );
    // Set before the proxy itself destroys the upstream, whose error is then its own doing, not the app's.
    let abandoned = false;
    upstream.on('error', (err) => {
      if (abandoned) return;
      log.warn('Preview: upstream request failed', { containerName: target.containerName, port: target.port, err });
      if (!res.headersSent) plain(res, 502, 'The preview app did not answer. Is it still running on its port?');
      else res.destroy();
    });
    const revoke = () => {
      abandoned = true;
      req.destroy();
      upstream.destroy();
      res.destroy();
    };
    target.revoked.addEventListener('abort', revoke, { once: true });
    // An app may answer before it has read the request body, so revocation stays armed until both directions close.
    let open = 2;
    const settle = () => {
      open -= 1;
      if (open === 0) target.revoked.removeEventListener('abort', revoke);
    };
    req.once('close', settle);
    res.once('close', () => {
      settle();
      if (res.writableFinished) return;
      abandoned = true;
      upstream.destroy();
    });
    req.pipe(upstream);
  });

  server.on('upgrade', (req: http.IncomingMessage, socket: Socket, head: Buffer) => {
    const refuse = (status: 400 | 403 | 404 | 503, body: string) =>
      socket.end(
        `HTTP/1.1 ${status} ${STATUS_TEXT[status]}\r\nContent-Type: text/plain; charset=utf-8\r\n` +
          `Content-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`,
      );
    const id = previewIdFromHost(req.headers.host);
    if (id && handleGroupCallUpgrade(id, req, socket, head)) return;
    const target = targetFor(req);
    if (!target) return refuse(404, NOT_FOUND);
    const verdict = pathVerdict(req.url);
    if (verdict) return refuse(verdict.status, verdict.body);
    const live = liveUpgrades.get(target.revoked) ?? 0;
    if (live >= MAX_UPGRADES_PER_PREVIEW) return refuse(503, 'Too many live connections to this preview.');
    if (totalUpgrades >= MAX_UPGRADES_TOTAL) return refuse(503, 'Too many live preview connections on this host.');
    liveUpgrades.set(target.revoked, live + 1);
    totalUpgrades += 1;

    const upstream = openUpstream(target.containerName, target.port);
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    const headers = endToEndHeaders(req.rawHeaders, UPGRADE_DROP);
    for (let i = 0; i < headers.length; i += 2) lines.push(`${headers[i]}: ${headers[i + 1]}`);
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      liveUpgrades.set(target.revoked, (liveUpgrades.get(target.revoked) ?? 1) - 1);
      totalUpgrades -= 1;
      target.revoked.removeEventListener('abort', close);
      upstream.destroy();
      socket.destroy();
    };
    target.revoked.addEventListener('abort', close, { once: true });
    upstream.on('error', (err: NodeJS.ErrnoException) => {
      // Either end hanging up on a live socket surfaces as a premature close; that is a closed tab, not a failure.
      if (!closed && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
        log.warn('Preview: upstream upgrade failed', { containerName: target.containerName, port: target.port, err });
      }
      close();
    });
    socket.on('error', close);
    // A WebSocket is never half-closed, so the client hanging up ends the relay too.
    socket.on('end', close);
    upstream.on('close', close);
    socket.on('close', close);
  });

  server.on('close', () => agent.destroy());
  return server;
}

let running: http.Server | null = null;

/** Loopback only: the wildcard tunnel route for `*.<PREVIEW_ORIGIN_SUFFIX>` is the sole way in. No suffix, no listener. */
export function startPreviewProxy(): void {
  if (running || !PREVIEW_ORIGIN_SUFFIX) return;
  running = createPreviewProxy();
  running.on('error', (err) => log.error('Preview proxy failed', { port: PREVIEW_PORT, err }));
  running.listen(PREVIEW_PORT, '127.0.0.1', () =>
    log.info('Preview proxy started', { port: PREVIEW_PORT, suffix: PREVIEW_ORIGIN_SUFFIX }),
  );
}
