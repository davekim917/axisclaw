import type { IncomingMessage, ServerResponse } from 'http';

import { log } from '../../log.js';
import { getUser } from '../permissions/db/users.js';
import { userPlatform, type DiscordReads } from '../voice-call/group/place.js';
import { refuseIfCallCannotOpen, startOrJoinDmCallAs, startOrJoinGroupCallAs } from '../voice-call/group/service.js';
import { BodyTooLarge, json, readBody, send } from '../voice-call/http.js';
import { VoiceCallRefused } from '../voice-call/service.js';
import { CONNECT_PAGE_CSP, connectPageHtml } from './connect-page.js';
import { deleteDevice, findDeviceByKey, findDeviceBySendKey, type MobileDevice } from './devices.js';
import { discordReplyTarget, shownDiscordReplyTarget } from './discord-send.js';
import { PAIR_PAGE, REPLIES_PAGE } from './pair-page.js';
import { appHost, redeemCode } from './pairing.js';
import {
  MAX_REPLY_CHARS,
  redeemClaim,
  replyState,
  sendReply,
  startEnable,
  type Recipient,
  type ReplyTarget,
} from './reply.js';
import {
  CALLBACK_PATH,
  enablesByLink,
  finishConnect,
  NOT_AVAILABLE,
  slackReplyTarget,
  startConnect,
} from './slack-send.js';
import { readThreadMessages } from './thread-messages.js';
import { DAY_MS, MINUTE_MS, overLimit, SEND_LIMITS, type Limit } from './limits.js';
import { discardFiles, MAX_FILES_PER_REPLY, receiveUpload, takeUploads, type ReplyFile } from './uploads.js';
import {
  callInTaskThread,
  CHANNEL_NOT_AVAILABLE,
  channelForNewCall,
  dmForCall,
  listPlaces,
  listThreads,
  openThreadForCall,
  threadForCall,
  threadToRead,
  type ThreadToRead,
} from './threads.js';

const MAX_BODY_BYTES = 4096;
/** Room for the longest reply with every character escaped in JSON. */
const MAX_REPLY_BODY_BYTES = 32 * 1024;
const SEND_ID_RE = /^[A-Za-z0-9_-]{16,64}$/;
const MAX_LABEL_CHARS = 64;
const CALL_PATH_RE = /^\/v1\/threads\/([^/]+)\/call$/;
const DM_CALL_PATH_RE = /^\/v1\/threads\/([^/]+)\/dm-call$/;
const MESSAGES_PATH_RE = /^\/v1\/threads\/([^/]+)\/messages$/;
const UNPRINTABLE_RE = /[\p{Cc}\p{Cf}]/gu;

/** Each request makes live platform checks and can hold one of the host's few call slots. */
const CALL_LIMITS: Limit[] = [{ max: 6, windowMs: MINUTE_MS }];
/** Each one posts in a channel as the bot, which nothing here can take back. */
const NEW_THREAD_LIMITS: Limit[] = [
  { max: 1, windowMs: MINUTE_MS },
  { max: 20, windowMs: DAY_MS },
];

/**
 * Each one takes a worker thread and holds up archive writes for a statement at a time. The app sends a list per 300 ms
 * pause in typing and one every 15 seconds, so someone typing steadily stays under this. Past it the list answers
 * without message text, which costs them nothing they can't get back on the next poll.
 */
const TEXT_WALK_LIMITS: Limit[] = [{ max: 60, windowMs: MINUTE_MS }];

/**
 * Each read asks the platform afresh, as a call does. The app's own pace while a thread is open leaves room to open a few
 * threads in a minute.
 */
const READ_LIMITS: Limit[] = [{ max: 30, windowMs: MINUTE_MS }];

/** Each one holds a sign-in open, or DMs the person a link, for ten minutes. */
const CONNECT_LIMITS: Limit[] = [
  { max: 3, windowMs: MINUTE_MS },
  { max: 20, windowMs: DAY_MS },
];

const recentCalls = new Map<string, number[]>();
/** Replies about to post and the files they carry, counted together. */
const recentSends = new Map<string, number[]>();
const recentConnects = new Map<string, number[]>();
const recentReads = new Map<string, number[]>();
const recentNewThreads = new Map<string, number[]>();
const recentTextWalks = new Map<string, number[]>();

export const isMobileHost = (host: string | undefined) => host?.toLowerCase() === appHost().toLowerCase();

/**
 * Read fresh on every request: revoking a device or removing its user takes effect on the next one. A send takes the
 * send key and everything else the read key, each found only in its own column.
 */
async function authenticate(req: IncomingMessage, purpose: 'read' | 'send' = 'read'): Promise<MobileDevice | null> {
  const key = /^Bearer (\S+)$/i.exec(req.headers.authorization ?? '')?.[1];
  const device = key ? await (purpose === 'send' ? findDeviceBySendKey : findDeviceByKey)(key) : undefined;
  return device && (await getUser(device.user_id)) ? device : null;
}

/** Answers and returns null for a body it cannot use. The parse error stays here: its message quotes the input. */
async function readJson(
  req: IncomingMessage,
  res: ServerResponse,
  maxBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown> | null> {
  let text: string;
  try {
    text = await readBody(req, maxBytes, true);
  } catch (err) {
    if (!(err instanceof BodyTooLarge)) throw err;
    res.setHeader('connection', 'close');
    json(res, 413, { error: 'That request is too large.' });
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    // Falls through to the same answer as valid JSON of the wrong shape.
  }
  json(res, 400, { error: 'That request could not be read.' });
  return null;
}

async function pair(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readJson(req, res);
  if (!body) return;
  const { code, label } = body;
  if (typeof code !== 'string' || (label !== undefined && typeof label !== 'string')) {
    json(res, 400, { error: 'That request could not be read.' });
    return;
  }
  const paired = await redeemCode(code, label?.replace(UNPRINTABLE_RE, ' ').trim().slice(0, MAX_LABEL_CHARS) || null);
  if (paired) json(res, 200, paired);
  else json(res, 410, { error: 'This pairing link no longer works. Ask your agent for a new one.' });
}

const THREAD_NOT_AVAILABLE = 'That thread is not available.';

const LINK_PAGES = new Map([
  ['/pair', PAIR_PAGE],
  ['/replies', REPLIES_PAGE],
]);

/** `admit` answers null for a thread this person cannot call from, which reads the same as one that does not exist. */
async function answerCall<T>(
  res: ServerResponse,
  device: MobileDevice,
  admit: () => Promise<T | null>,
  start: (admitted: T) => Promise<{ url: string; agentName: string; joined: boolean; expiresAt: string }>,
): Promise<void> {
  if (overLimit(recentCalls, device.id, CALL_LIMITS)) {
    json(res, 429, { error: 'That is a lot of calls at once. Wait a minute and try again.' });
    return;
  }
  const admitted = await admit();
  if (!admitted) {
    json(res, 404, { error: THREAD_NOT_AVAILABLE });
    return;
  }
  try {
    const { url, agentName, joined, expiresAt } = await start(admitted);
    json(res, 200, { url, agentName, joined, expiresAt });
  } catch (err) {
    if (!(err instanceof VoiceCallRefused)) throw err;
    json(res, 409, { error: err.message });
  }
}

async function messages(res: ServerResponse, threadKey: string, device: MobileDevice): Promise<void> {
  if (overLimit(recentReads, device.id, READ_LIMITS)) {
    json(res, 429, { error: 'That is a lot of reading at once. Wait a minute and try again.' });
    return;
  }
  const thread = await threadToRead(threadKey, device.user_id);
  if (!thread) {
    json(res, 404, { error: THREAD_NOT_AVAILABLE });
    return;
  }
  const reply = await replyState(await replyTarget(thread, device, true), device);
  json(res, 200, { ...(await readThreadMessages(thread)), ...reply });
}

/**
 * Where a reply in this thread would go, if anywhere; `shown` may reuse a recent check that the person may post there, a
 * send never does. A send reads Discord through the `reads` its thread was found with.
 */
async function replyTarget(
  thread: ThreadToRead,
  device: MobileDevice,
  shown = false,
  recipient: Recipient = undefined,
  reads: DiscordReads = new Map(),
): Promise<ReplyTarget | null> {
  return (
    (await slackReplyTarget(thread, device, shown, recipient)) ??
    (await (shown ? shownDiscordReplyTarget(thread, device) : discordReplyTarget(thread, device, recipient, reads)))
  );
}

async function upload(req: IncomingMessage, res: ServerResponse, device: MobileDevice): Promise<void> {
  if (overLimit(recentSends, device.id, SEND_LIMITS)) {
    res.setHeader('connection', 'close');
    json(res, 429, { error: 'That is a lot of replies at once. Wait a minute and try again.' });
    return;
  }
  const received = await receiveUpload(req, device.id);
  if ('uploadId' in received) {
    json(res, 200, received);
    return;
  }
  if (received.close) res.setHeader('connection', 'close');
  json(res, received.status, { error: received.error });
}

const isFileIds = (value: unknown): value is string[] =>
  Array.isArray(value) &&
  value.length <= MAX_FILES_PER_REPLY &&
  value.every((id) => typeof id === 'string') &&
  new Set(value).size === value.length;

/** Where a reply posts is the host's to decide from the thread, so a body that names anything more is refused. */
const REPLY_FIELDS = new Set(['text', 'sendId', 'agentId', 'files']);

async function reply(req: IncomingMessage, res: ServerResponse, threadKey: string, device: MobileDevice) {
  const body = await readJson(req, res, MAX_REPLY_BODY_BYTES);
  if (!body) return;
  const { text, sendId, agentId, files: fileIds = [] } = body;
  const readable = agentId === undefined || agentId === null || typeof agentId === 'string';
  const named = Object.keys(body).every((field) => REPLY_FIELDS.has(field));
  if (typeof text !== 'string' || typeof sendId !== 'string' || !SEND_ID_RE.test(sendId) || !readable || !named) {
    json(res, 400, { error: 'That request could not be read.' });
    return;
  }
  if (!isFileIds(fileIds)) {
    json(res, 400, { error: 'A reply carries one file.' });
    return;
  }
  if (!text.trim() && fileIds.length === 0) {
    json(res, 400, { error: 'There is nothing to send.' });
    return;
  }
  if (text.length > MAX_REPLY_CHARS) {
    json(res, 413, { error: `That is over ${MAX_REPLY_CHARS} characters. Split it into shorter replies.` });
    return;
  }
  const files: ReplyFile[] | null = takeUploads(device.id, fileIds);
  if (!files) {
    json(res, 410, { error: 'A file for this reply is no longer on the host. Attach it again.' });
    return;
  }
  const reads: DiscordReads = new Map();
  let answer: Awaited<ReturnType<typeof sendReply>>;
  try {
    answer = await sendReply(
      device,
      sendId,
      text,
      () => threadToRead(threadKey, device.user_id, reads),
      (thread, sender, recipient) => replyTarget(thread, sender, false, recipient, reads),
      () => !overLimit(recentSends, device.id, SEND_LIMITS),
      agentId,
      files,
    );
  } finally {
    discardFiles(files);
  }
  if (answer === 'gone') json(res, 404, { error: THREAD_NOT_AVAILABLE });
  else if (answer === 'not-an-agent') json(res, 400, { error: 'That agent is not in this thread.' });
  else if (answer === 'not-here') json(res, 409, { error: 'You cannot reply to this thread from the app.' });
  else if (answer === 'sending')
    json(res, 200, { outcome: 'unknown', error: 'That reply is still sending. Check the thread in a moment.' });
  else if (answer === 'limited')
    json(res, 429, { error: 'That is a lot of replies at once. Wait a minute and try again.' });
  else json(res, 200, answer);
}

async function connect(res: ServerResponse, device: MobileDevice): Promise<void> {
  if (overLimit(recentConnects, device.id, CONNECT_LIMITS)) {
    json(res, 429, { error: 'Wait a minute before connecting Slack again.' });
    return;
  }
  const started = await startConnect(device);
  if (started) json(res, 200, started);
  else json(res, 409, { error: NOT_AVAILABLE });
}

async function claim(req: IncomingMessage, res: ServerResponse, device: MobileDevice): Promise<void> {
  const body = await readJson(req, res);
  if (!body) return;
  if (typeof body.claim !== 'string') {
    json(res, 400, { error: 'That request could not be read.' });
    return;
  }
  const started = Date.now();
  const redeemed = await redeemClaim(device, body.claim);
  const outcome =
    typeof redeemed === 'string'
      ? redeemed
      : 'failed' in redeemed
        ? 'failed'
        : redeemed.replayed
          ? 'replayed'
          : 'redeemed';
  log.info('Mobile: send key claim', { deviceId: device.id, outcome, waitedMs: Date.now() - started });
  if (redeemed === 'unsettled') json(res, 503, { error: 'Still finishing. Tap Open Anderton again in a moment.' });
  else if (typeof redeemed !== 'string' && 'sendKey' in redeemed) json(res, 200, { sendKey: redeemed.sendKey });
  // 503 because a build that predates `final` ranks only 502 and 503 as the claim's own answer; `final` stops a newer
  // one asking again, since the claim is spent.
  else if (typeof redeemed !== 'string') json(res, 503, { error: redeemed.failed, final: true });
  else json(res, 410, { error: 'That link has expired or belongs to another phone. Start again from the app.' });
}

async function enable(res: ServerResponse, device: MobileDevice): Promise<void> {
  if (overLimit(recentConnects, device.id, CONNECT_LIMITS)) {
    json(res, 429, { error: 'Wait a minute before asking for another link.' });
    return;
  }
  if (userPlatform(device.user_id) !== 'discord' && !(await enablesByLink(device))) {
    json(res, 409, { error: NOT_AVAILABLE });
    return;
  }
  if ((await startEnable(device)) === 'sent') json(res, 200, {});
  else json(res, 503, { error: 'The link could not be sent to your DMs. Try again in a minute.' });
}

async function connected(res: ServerResponse, url: URL): Promise<void> {
  const page = await finishConnect(url.searchParams);
  res.setHeader('content-security-policy', CONNECT_PAGE_CSP);
  send(res, page.status, connectPageHtml(page), 'text/html');
}

/** The limit is counted last, with no await before the post, so only a thread about to exist spends it. */
async function newThread(req: IncomingMessage, res: ServerResponse, device: MobileDevice): Promise<void> {
  if (overLimit(recentCalls, device.id, CALL_LIMITS)) {
    json(res, 429, { error: 'That is a lot of calls at once. Wait a minute and try again.' });
    return;
  }
  const body = await readJson(req, res);
  if (!body) return;
  const { agentGroupId, messagingGroupId } = body;
  if (typeof agentGroupId !== 'string' || typeof messagingGroupId !== 'string') {
    json(res, 400, { error: 'That request could not be read.' });
    return;
  }
  const channel = await channelForNewCall(agentGroupId, messagingGroupId, device.user_id);
  if (!channel) {
    json(res, 404, { error: CHANNEL_NOT_AVAILABLE });
    return;
  }
  try {
    refuseIfCallCannotOpen(agentGroupId);
  } catch (err) {
    if (!(err instanceof VoiceCallRefused)) throw err;
    json(res, 409, { error: err.message });
    return;
  }
  if (overLimit(recentNewThreads, device.id, NEW_THREAD_LIMITS)) {
    json(res, 429, { error: 'You opened a new thread recently. Wait a little and try again.' });
    return;
  }
  const result = await openThreadForCall(channel);
  if ('error' in result) {
    json(res, result.status, { error: result.error });
    return;
  }
  const { url, agentName, joined, expiresAt } = result;
  json(res, 200, { url, agentName, joined, expiresAt });
}

async function route(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  const page = method === 'GET' ? LINK_PAGES.get(path) : undefined;
  if (page) {
    res.setHeader('content-security-policy', page.csp);
    send(res, 200, page.html, 'text/html');
    return;
  }
  if (method === 'POST' && path === '/v1/pair') return pair(req, res);
  if (method === 'GET' && path === CALLBACK_PATH) return connected(res, url);

  const replyPath = method === 'POST' ? MESSAGES_PATH_RE.exec(path) : null;
  if (replyPath || (method === 'POST' && path === '/v1/uploads')) {
    const sender = await authenticate(req, 'send');
    if (!sender) {
      if (!replyPath) res.setHeader('connection', 'close');
      json(res, 401, { error: 'This phone can no longer send. Set up replying again.' });
    } else if (replyPath) await reply(req, res, replyPath[1], sender);
    else await upload(req, res, sender);
    return;
  }
  const callPath = method === 'POST' ? CALL_PATH_RE.exec(path) : null;
  const dmCallPath = method === 'POST' ? DM_CALL_PATH_RE.exec(path) : null;
  const messagesPath = method === 'GET' ? MESSAGES_PATH_RE.exec(path) : null;
  const known =
    (method === 'DELETE' && path === '/v1/device') ||
    (method === 'GET' && (path === '/v1/threads' || path === '/v1/places')) ||
    (method === 'POST' && ['/v1/threads', '/v1/slack/connect', '/v1/slack/claim', '/v1/replies/enable'].includes(path));
  if (!known && !callPath && !dmCallPath && !messagesPath) {
    json(res, 404, { error: 'Not found.' });
    return;
  }
  const device = await authenticate(req);
  if (!device) {
    json(res, 401, { error: 'This device is not paired.' });
    return;
  }
  if (callPath)
    return answerCall(
      res,
      device,
      () => threadForCall(callPath[1], device.user_id),
      (thread) => ('threadId' in thread ? callInTaskThread(thread) : startOrJoinGroupCallAs(thread, thread.userId)),
    );
  if (dmCallPath)
    return answerCall(
      res,
      device,
      () => dmForCall(dmCallPath[1], device.user_id),
      (dm) => startOrJoinDmCallAs(dm, dm.userId),
    );
  if (messagesPath) return messages(res, messagesPath[1], device);
  if (path === '/v1/slack/connect') return connect(res, device);
  if (path === '/v1/slack/claim') return claim(req, res, device);
  if (path === '/v1/replies/enable') return enable(res, device);
  if (method === 'POST') return newThread(req, res, device);
  if (path === '/v1/places') {
    json(res, 200, await listPlaces(device.user_id));
    return;
  }
  if (method === 'GET') {
    const { searchParams } = url;
    json(
      res,
      200,
      await listThreads(
        device.user_id,
        {
          workgroup: searchParams.get('workgroup') || null,
          channel: searchParams.get('channel') || null,
          q: searchParams.get('q'),
        },
        () => !overLimit(recentTextWalks, device.id, TEXT_WALK_LIMITS),
      ),
    );
    return;
  }
  await deleteDevice(device.id);
  json(res, 200, { ok: true });
}

/** Serves `https://app.<suffix>/…` on the preview listener. No cookies and no CORS headers: only the app reads this. */
export function handleMobileRequest(req: IncomingMessage, res: ServerResponse): void {
  let url: URL;
  try {
    url = new URL(req.url ?? '/', `https://${appHost()}`);
  } catch {
    json(res, 400, { error: 'Bad request.' });
    return;
  }
  void route(req, res, url).catch((err: unknown) => {
    // A client that hung up mid-body is not waiting for an answer, and needs no key to do it, so it costs no log line.
    if (!req.complete) return;
    log.warn('Mobile: request failed', { path: url.pathname, err });
    if (!res.headersSent) json(res, 500, { error: 'Something went wrong. Try again.' });
  });
}
