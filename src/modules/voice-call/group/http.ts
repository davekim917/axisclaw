import type { IncomingMessage, ServerResponse } from 'http';
import type { Socket } from 'net';
import { timingSafeEqual } from 'crypto';

import { log } from '../../../log.js';
import { json, readBody, send, streamEvents } from '../http.js';
import { logMicReport, MIC_REPORT_MAX_BYTES } from '../mic-report.js';
import { overLimit, SEND_LIMITS } from '../../mobile/limits.js';
import { discardFiles, receiveFile } from '../../mobile/uploads.js';
import { livekitClientScript } from './bridge-page.js';
import { joinPageHtml } from './join-page.js';
import {
  claimLink,
  gate,
  groupCallUrl,
  leave,
  linkFor,
  listen,
  mayShare,
  shareOnCall,
  type GroupPageEvent,
} from './service.js';
import { platformName } from '../prompts.js';

/** Links with a file still arriving: one at a time each, so one page cannot fill the host's disk in parallel. */
const sending = new Set<string>();
/** Files each person shared, on a budget of their own with a phone's reply limits: each one posts in their name. */
const recentShares = new Map<string, number[]>();

const NOT_LIVE = 'Files can be shared only while the call is live.';

async function attach(linkId: string, userId: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!mayShare(linkId)) return json(res, 409, { error: NOT_LIVE });
  if (sending.has(linkId)) return json(res, 429, { error: 'One file at a time. Wait for the last one to finish.' });
  if (overLimit(recentShares, userId, SEND_LIMITS))
    return json(res, 429, { error: 'That is a lot of files at once. Wait a minute and try again.' });
  sending.add(linkId);
  try {
    const received = await receiveFile(req);
    if (!('file' in received)) return json(res, received.status, { error: received.error });
    try {
      const shared = await shareOnCall(linkId, received.file);
      if (shared) json(res, 200, { ok: true, name: received.file.name, inThread: shared.inThread });
      else json(res, 409, { error: NOT_LIVE });
    } finally {
      discardFiles([received.file]);
    }
  } finally {
    sending.delete(linkId);
  }
}

function pageTokenMatches(expected: string | null, url: URL): boolean {
  const given = Buffer.from(url.searchParams.get('t') ?? '');
  const want = Buffer.from(expected ?? '');
  return want.length > 0 && given.length === want.length && timingSafeEqual(given, want);
}

/**
 * Serves `https://<link id>.<suffix>/…` for a group call's participant on the preview listener, LiveKit signaling
 * included. Returns false when the id is no live group-call link.
 */
export function handleGroupCallRequest(linkId: string, req: IncomingMessage, res: ServerResponse): boolean {
  const found = linkFor(linkId);
  if (!found) return false;
  const { call, person } = found;
  if (gate.handleRequest(linkId, req, res)) return true;
  let url: URL;
  try {
    url = new URL(req.url ?? '/', groupCallUrl(linkId));
  } catch {
    json(res, 400, { error: 'Bad request.' });
    return true;
  }
  const method = req.method ?? 'GET';
  if (method === 'GET' && url.pathname === '/') {
    if (person.claimed) send(res, 410, 'This link was already used. Ask the agent to add you again.', 'text/plain');
    else {
      res.setHeader(
        'content-security-policy',
        `default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self' ${groupCallUrl(linkId).replace('https://', 'wss://')}; media-src blob: mediastream:; frame-ancestors 'none'; base-uri 'none'`,
      );
      send(res, 200, joinPageHtml(call.agentName, person.name, platformName(call.route.channelType)), 'text/html');
    }
    return true;
  }
  if (method === 'GET' && url.pathname === '/lk.js') {
    send(res, 200, livekitClientScript(), 'text/javascript');
    return true;
  }
  if (method === 'GET' && url.pathname === '/events') {
    if (!pageTokenMatches(person.pageToken, url)) json(res, 403, { error: 'Not this call.' });
    else streamEvents<GroupPageEvent>(req, res, (write) => listen(person, write));
    return true;
  }
  if (method !== 'POST' || !['/claim', '/leave', '/mic', '/attach'].includes(url.pathname)) {
    json(res, 404, { error: 'Not found.' });
    return true;
  }
  // A refused upload is answered before its body arrives, so closing stops a phone still sending up to 25 MB.
  if (url.pathname === '/attach') res.setHeader('connection', 'close');
  // Every preview is a sibling subdomain running agent-written code, so a state change must come from this page.
  if (req.headers.origin !== groupCallUrl(linkId)) {
    json(res, 403, { error: 'Wrong origin.' });
    return true;
  }
  void (async () => {
    try {
      if (url.pathname === '/claim') {
        const claim = await claimLink(linkId);
        if (claim) json(res, 200, claim);
        else json(res, 410, { error: 'This link no longer works. Ask the agent to add you again.' });
        return;
      }
      if (!pageTokenMatches(person.pageToken, url)) json(res, 403, { error: 'Not this call.' });
      else if (url.pathname === '/attach') await attach(linkId, person.userId, req, res);
      else if (url.pathname === '/mic') {
        logMicReport(call.id, await readBody(req, MIC_REPORT_MAX_BYTES));
        json(res, 200, { ok: true });
      } else {
        await leave(linkId);
        json(res, 200, { ok: true });
      }
    } catch (err) {
      log.warn('Group call: request failed', { path: url.pathname, err });
      if (!res.headersSent) json(res, 500, { error: 'The call failed.' });
    }
  })();
  return true;
}

export function handleGroupCallUpgrade(linkId: string, req: IncomingMessage, socket: Socket, head: Buffer): boolean {
  if (!linkFor(linkId)) return false;
  if (gate.handleUpgrade(linkId, req, socket, head)) return true;
  socket.end('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
  return true;
}
