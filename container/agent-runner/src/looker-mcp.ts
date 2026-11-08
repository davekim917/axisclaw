#!/usr/bin/env bun
/**
 * Looker MCP behind the OneCLI gateway. toolbox's Looker client builds its own `http.Transport`, which ignores
 * HTTPS_PROXY, so its calls would skip the gateway. It runs in client-OAuth mode instead (it sends whatever
 * Authorization it is given and never logs in) against a loopback forwarder that re-sends each call to the one
 * configured Looker origin through the gateway, which replaces the placeholder with the vaulted access token.
 */
import { bridgeStdioTo } from './remote-mcp-bridge.js';

const PLACEHOLDER_AUTHORIZATION = 'token onecli-managed';
const READY_TIMEOUT_MS = 30_000;
// Just past toolbox's own 600s Looker timeout, so a slow query ends with toolbox's answer rather than the bridge's.
const CALL_TIMEOUT_MS = 610_000;
const STRIPPED_REQUEST_HEADERS = ['host', 'x-forwarded-for', 'x-real-ip', 'connection', 'proxy-authorization'];
// fetch has already decoded the body, so the upstream encoding and length no longer describe it.
const STRIPPED_RESPONSE_HEADERS = ['content-encoding', 'content-length', 'transfer-encoding', 'connection'];

function log(msg: string): void {
  console.error(`[looker-mcp] ${msg}`);
}

/** The configured Looker API origin: https, no credentials, path, query or fragment. */
export function lookerOrigin(raw: string | undefined): string {
  if (!raw) throw new Error('LOOKER_BASE_URL is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('LOOKER_BASE_URL is not a URL');
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
    throw new Error('LOOKER_BASE_URL must be a bare https origin');
  }
  if (url.pathname !== '/' && url.pathname !== '') throw new Error('LOOKER_BASE_URL must have no path');
  return url.origin;
}

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

/**
 * Forwards a request addressed to `selfHost` (the forwarder's own loopback authority) to `origin`, keeping only
 * the method, path, query, headers and body. Anything that names another destination is refused.
 */
export function makeLookerForwarder(
  origin: string,
  selfHost: () => string,
  fetchImpl: FetchLike = fetch,
): (req: Request) => Promise<Response> {
  const refused = (): Response => new Response('looker-mcp forwarder: refused destination', { status: 403 });
  return async (req) => {
    if (req.method === 'CONNECT') return refused();
    const incoming = new URL(req.url);
    if (incoming.host !== selfHost()) return refused();
    const target = new URL(`${origin}${incoming.pathname}${incoming.search}`);
    if (target.origin !== origin) return refused();
    const headers = new Headers(req.headers);
    for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name);
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
    const upstream = await fetchImpl(target, {
      method: req.method,
      headers,
      body: hasBody ? await req.arrayBuffer() : undefined,
      redirect: 'manual',
    });
    const outHeaders = new Headers(upstream.headers);
    for (const name of STRIPPED_RESPONSE_HEADERS) outHeaders.delete(name);
    return new Response(upstream.body, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: outHeaders,
    });
  };
}

/** The forwarder on a free loopback port. */
export function serveLookerForwarder(
  origin: string,
  fetchImpl?: FetchLike,
): { server: ReturnType<typeof Bun.serve>; host: string } {
  let host = '';
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    // Bun drops a connection that is silent for 10 seconds by default, and nothing crosses it while Looker runs a query.
    idleTimeout: 0,
    fetch: makeLookerForwarder(origin, () => host, fetchImpl),
  });
  host = `127.0.0.1:${server.port}`;
  return { server, host };
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: () => new Response() });
  const port = probe.port;
  probe.stop(true);
  if (port === undefined) throw new Error('could not reserve a loopback port');
  return port;
}

async function waitForToolbox(url: string, child: { exitCode: number | null }): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`toolbox exited with code ${child.exitCode} before it was ready`);
    try {
      await fetch(url, { method: 'GET' });
      return;
    } catch {
      await Bun.sleep(200);
    }
  }
  throw new Error(`toolbox did not answer on ${url} within ${READY_TIMEOUT_MS}ms`);
}

async function main(): Promise<void> {
  const origin = lookerOrigin(process.env.LOOKER_BASE_URL);
  if (!process.env.HTTPS_PROXY) log('WARN: HTTPS_PROXY not set — Looker calls will go out without the gateway token');

  const { server: forwarder, host: selfHost } = serveLookerForwarder(origin);

  const toolboxPort = await freePort();
  const toolbox = Bun.spawn(
    [
      'toolbox',
      '--prebuilt',
      'looker',
      '--address',
      '127.0.0.1',
      '--port',
      String(toolboxPort),
      '--allowed-hosts',
      '127.0.0.1',
    ],
    {
      env: {
        ...process.env,
        LOOKER_BASE_URL: `http://${selfHost}`,
        LOOKER_USE_CLIENT_OAUTH: 'true',
      },
      stdin: 'ignore',
      // stdout belongs to the MCP protocol of this process.
      stdout: 'ignore',
      stderr: 'inherit',
    },
  );
  const stop = (): void => {
    toolbox.kill();
    forwarder.stop(true);
  };
  process.once('exit', stop);

  await waitForToolbox(`http://127.0.0.1:${toolboxPort}/`, toolbox);
  await bridgeStdioTo(
    'looker',
    `http://127.0.0.1:${toolboxPort}/mcp`,
    { Authorization: PLACEHOLDER_AUTHORIZATION },
    CALL_TIMEOUT_MS,
    { origin },
  );
}

if (import.meta.main) {
  main().catch((err) => {
    log(`fatal: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
    process.exit(1);
  });
}
