import type { IncomingMessage, ServerResponse } from 'http';
import { timingSafeEqual } from 'crypto';

import { log } from '../../log.js';
import { VoiceServiceError } from './live.js';
import { logMicReport } from './mic-report.js';
import { callPageHtml } from './page.js';
import { getVoiceCall, type CallPageEvent, type VoiceCall } from './registry.js';
import {
  answerVoiceCall,
  connectVoiceAudio,
  hangUpVoiceCall,
  logAudioReport,
  voiceCallUrl,
  VoiceCallRefused,
} from './service.js';

const MAX_BODY_BYTES = 256 * 1024;
const SSE_PING_MS = 15_000;

const SECURITY_HEADERS = {
  'cache-control': 'no-store',
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'permissions-policy': 'microphone=(self)',
  'x-robots-tag': 'noindex',
};

/**
 * Cloudflare answers an origin's 502 or 504 with its own error page, so the phone or browser behind it never gets this
 * body; a status written here as a literal cannot be one of them.
 */
type ReachesClient<S extends number> = S extends 502 | 504 ? never : S;

export function send<S extends number>(
  res: ServerResponse,
  status: ReachesClient<S>,
  body: string,
  type = 'application/json',
): void {
  res.writeHead(status, { ...SECURITY_HEADERS, 'content-type': `${type}; charset=utf-8` });
  res.end(body);
}

export const json = <S extends number>(res: ServerResponse, status: ReachesClient<S>, body: unknown) =>
  send(res, status, JSON.stringify(body));

export class BodyTooLarge extends Error {}

/** An overrun is cut off where it stands, unless `answerOverrun`: then the caller answers, with `Connection: close`. */
export function readBody(req: IncomingMessage, maxBytes = MAX_BODY_BYTES, answerOverrun = false): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new BodyTooLarge('too large'));
        if (!answerOverrun) req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function tokenMatches(call: VoiceCall, url: URL): boolean {
  const given = Buffer.from(url.searchParams.get('t') ?? '');
  const expected = Buffer.from(call.token ?? '');
  return expected.length > 0 && given.length === expected.length && timingSafeEqual(given, expected);
}

/** Streams a call's page events until the page goes; `subscribe` returns its own unsubscribe. */
export function streamEvents<E extends { type: string }>(
  req: IncomingMessage,
  res: ServerResponse,
  subscribe: (write: (event: E) => void) => () => void,
): void {
  res.writeHead(200, { ...SECURITY_HEADERS, 'content-type': 'text/event-stream', connection: 'keep-alive' });
  const ping = setInterval(() => res.write(': ping\n\n'), SSE_PING_MS);
  const stop = subscribe((event) => {
    res.write(`data: ${JSON.stringify(event)}\n\n`);
    if (event.type === 'ended') res.end();
  });
  req.on('close', () => {
    clearInterval(ping);
    stop();
  });
}

/**
 * Serves `https://<call id>.<suffix>/…` on the preview listener. Returns false when the id is no live call, so the
 * preview proxy answers it as it answers any unknown id.
 */
export function handleVoiceCallRequest(id: string, req: IncomingMessage, res: ServerResponse): boolean {
  const call = getVoiceCall(id);
  if (!call) return false;
  let url: URL;
  try {
    url = new URL(req.url ?? '/', voiceCallUrl(id));
  } catch {
    json(res, 400, { error: 'Bad request.' });
    return true;
  }
  const method = req.method ?? 'GET';

  if (method === 'GET' && url.pathname === '/') {
    if (call.state !== 'ringing') send(res, 410, 'This call link has already been used.', 'text/plain');
    else {
      res.setHeader(
        'content-security-policy',
        "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; media-src 'self' blob: mediastream:; frame-ancestors 'none'; base-uri 'none'",
      );
      send(res, 200, callPageHtml(call.agentName), 'text/html');
    }
    return true;
  }
  if (method === 'GET' && url.pathname === '/events') {
    if (!tokenMatches(call, url)) json(res, 403, { error: 'Not this call.' });
    else
      streamEvents<CallPageEvent>(req, res, (write) => {
        call.listeners.add(write);
        return () => call.listeners.delete(write);
      });
    return true;
  }
  if (method !== 'POST' || !['/offer', '/connected', '/hangup'].includes(url.pathname)) {
    json(res, 404, { error: 'Not found.' });
    return true;
  }
  // Every preview is a sibling subdomain running agent-written code, so a state change must come from this page.
  if (req.headers.origin !== voiceCallUrl(id)) {
    json(res, 403, { error: 'Wrong origin.' });
    return true;
  }

  void (async () => {
    try {
      const body = await readBody(req);
      if (url.pathname === '/offer') {
        const sdp = (JSON.parse(body || '{}') as { sdp?: unknown }).sdp;
        if (typeof sdp !== 'string' || !sdp.startsWith('v=0') || sdp.length > MAX_BODY_BYTES) {
          json(res, 400, { error: 'Invalid offer.' });
          return;
        }
        json(res, 200, await answerVoiceCall(call, sdp));
        return;
      }
      if (!tokenMatches(call, url)) {
        json(res, 403, { error: 'Not this call.' });
        return;
      }
      if (url.pathname === '/connected') {
        connectVoiceAudio(call);
        logMicReport(call.id, body);
      } else {
        const ended = JSON.parse(body || '{}') as { dropped?: unknown; stats?: unknown };
        logAudioReport(call, ended.stats);
        hangUpVoiceCall(call, ended.dropped === true);
      }
      json(res, 200, { ok: true });
    } catch (err) {
      const known = err instanceof VoiceCallRefused || err instanceof VoiceServiceError;
      if (!known) log.warn('Voice call: request failed', { callId: id.slice(0, 8), path: url.pathname, err });
      if (!res.headersSent) json(res, known ? 409 : 500, { error: known ? err.message : 'The call failed.' });
    }
  })();
  return true;
}
