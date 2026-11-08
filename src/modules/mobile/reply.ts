/**
 * Replying from the app, whatever carries the words: the dedupe, the outcomes and the one-time claims that turn a
 * paired device into one that can send. Each platform supplies only where a reply can go and how it is posted.
 */
import { randomBytes } from 'crypto';

import { neutralizeMentions } from '../../channels/neutralize-mentions.js';
import { log } from '../../log.js';
import { findDeviceBySendKey, hasSendKey, issueSendKey, sha256, type MobileDevice } from './devices.js';
import { sendReplyLink } from './pairing.js';
import type { ReplyFile } from './uploads.js';
import type { ThreadToRead } from './threads.js';

export const MAX_REPLY_CHARS = 4000;
const CLAIM_TTL_MS = 10 * 60_000;
/**
 * Well inside the app's 30-second request timeout, so a claim still waiting on its token answers before the phone gives
 * up even when the host is slow to get back to the request.
 */
const READY_WAIT_MS = 20_000;
/**
 * A redeemed claim answers its device with the same key for this long, so a phone whose answer was lost (the request
 * cut off, the app reopened by the link a second time) still gets the key the host recorded.
 */
const REDEEMED_REPLAY_MS = 2 * 60_000;
const FINISHED_TTL_MS = 60 * 60_000;

export type SendOutcome =
  /** `postedAt` is when the thread's archive will date the post, so the app can tell its copy when it lands. */
  | { outcome: 'sent'; warning?: string; postedAt?: string }
  /**
   * `offerConnect`: connecting Slack again would let it through, and this phone's send key still works. `reconnect`
   * is the same for a build that predates `offerConnect`, which takes it to mean the key is gone and forgets it, so it
   * is sent only where that does no harm.
   */
  | { outcome: 'failed'; error: string; reconnect?: true; offerConnect?: true }
  | { outcome: 'unknown'; error: string };

type SendAnswer = SendOutcome | 'sending' | 'gone' | 'not-here' | 'limited' | 'not-an-agent';

/**
 * The agent a reply is for, by agent group id: one of the thread's agents, or `null` to post waking none. An app from
 * before the choice names no one (`undefined`), which leaves it to the host.
 */
export type Recipient = string | null | undefined;

/** A thread this device's own person can reply in, and how. */
export interface ReplyTarget {
  /** The agent a bot carries the reply to; absent where it posts as the person. */
  to?: string;
  /** What a device with no send key does first. */
  unlock: 'connect' | 'enable';
  /** Whether a reply here may carry files. */
  files?: boolean;
  /** Why these words, or these files, can't go here as they are, asked before anything is spent. */
  refuse?(words: string, files: ReplyFile[]): string | null;
  post(words: string, files: ReplyFile[]): Promise<SendOutcome>;
}

type FindTarget = (thread: ThreadToRead, device: MobileDevice, recipient: Recipient) => Promise<ReplyTarget | null>;

/** Settles to null once the claim may yield a key, or to the sentence saying why it never will. Never rejects. */
export type ClaimReady = Promise<string | null>;

const claims = new Map<
  string,
  {
    deviceId: string;
    expiresAt: number;
    ready?: ClaimReady;
    redeemed?: { sendKey: Promise<string | null>; until: number };
  }
>();

/**
 * A one-time claim, kept by hash, that only this device can redeem for its send key. Whoever hands it over (a Slack
 * sign-in, a DM) is how the person proves the device is theirs; a read key alone never yields a send key. With
 * `ready`, no key is issued until it settles to null.
 */
export function issueClaim(deviceId: string, ready?: ClaimReady): { claim: string; expiresAt: number } {
  const now = Date.now();
  for (const [key, entry] of claims) if ((entry.redeemed?.until ?? entry.expiresAt) < now) claims.delete(key);
  const claim = randomBytes(32).toString('base64url');
  const expiresAt = now + CLAIM_TTL_MS;
  claims.set(sha256(claim), { deviceId, expiresAt, ...(ready ? { ready } : {}) });
  return { claim, expiresAt };
}

function forgetClaim(claim: string): void {
  claims.delete(sha256(claim));
}

/** DMs this device's own person a link that turns this device into one that can send; only this device can redeem it. */
export async function startEnable(device: MobileDevice): Promise<'sent' | 'not-sent'> {
  const { claim, expiresAt } = issueClaim(device.id);
  if (await sendReplyLink(device.user_id, claim, expiresAt)) return 'sent';
  forgetClaim(claim);
  return 'not-sent';
}

export type Redeemed =
  | { sendKey: string; replayed?: true }
  | { failed: string }
  | 'unsettled'
  | 'expired'
  /** No claim by that value for this device: never issued, already gone, or another device's. */
  | 'unknown';

let readyWaitMs = READY_WAIT_MS;

export function _setClaimWaitForTest(ms: number | null): void {
  readyWaitMs = ms ?? READY_WAIT_MS;
}

const UNSETTLED = Symbol('unsettled');

function settledWithin<T>(work: Promise<T>, ms: number): Promise<T | typeof UNSETTLED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<typeof UNSETTLED>((resolve) => (timer = setTimeout(() => resolve(UNSETTLED), ms)));
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * Redeemable only by the device it was issued for, checked before anything awaits, so another device presenting it
 * cannot burn it. A claim still waiting on its `ready` is left unspent, so the same device can ask again; one whose
 * `ready` failed is spent and says why. Requests for one claim that overlap, and any for two minutes after it yields a
 * key, all get that one key.
 */
export async function redeemClaim(device: MobileDevice, claim: string): Promise<Redeemed> {
  const key = sha256(claim);
  const entry = claims.get(key);
  if (!entry || entry.deviceId !== device.id) return 'unknown';
  const problem =
    entry.ready && !entry.redeemed && Date.now() <= entry.expiresAt
      ? await settledWithin(entry.ready, readyWaitMs)
      : null;
  if (claims.get(key) !== entry) return 'unknown';
  const replayed = entry.redeemed !== undefined;
  if (!entry.redeemed) {
    const live = Date.now() <= entry.expiresAt;
    if (problem === UNSETTLED && live) return 'unsettled';
    if (!live || problem) {
      claims.delete(key);
      return live && problem !== UNSETTLED && problem ? { failed: problem } : 'expired';
    }
    entry.redeemed = { sendKey: issueSendKey(device.id), until: Date.now() + REDEEMED_REPLAY_MS };
    // The key leaves memory when its replay ends, whether or not anyone asks again.
    setTimeout(() => {
      if (claims.get(key) === entry) claims.delete(key);
    }, REDEEMED_REPLAY_MS).unref();
  } else if (Date.now() > entry.redeemed.until) {
    claims.delete(key);
    return 'expired';
  }
  const sendKey = await entry.redeemed.sendKey.catch((err: unknown) => {
    if (claims.get(key) === entry) claims.delete(key);
    throw err;
  });
  if (!sendKey) {
    if (claims.get(key) === entry) claims.delete(key);
    return 'unknown';
  }
  if (!replayed) return { sendKey };
  // A later connection may have issued this device another key since; this one no longer opens anything.
  if ((await findDeviceBySendKey(sendKey))?.id !== device.id) {
    if (claims.get(key) === entry) claims.delete(key);
    return 'expired';
  }
  return { sendKey, replayed: true };
}

type ReplyUnlock = ReplyTarget['unlock'];

type ReplyState = { reply: 'ready' | ReplyUnlock; unlock: ReplyUnlock; replyTo?: string; files?: true };

/** What the thread screen offers: a reply box, the step that unlocks one, or nothing. */
export async function replyState(target: ReplyTarget | null, device: MobileDevice): Promise<ReplyState | null> {
  if (!target) return null;
  const { unlock, to, files } = target;
  return {
    reply: (await hasSendKey(device.id)) ? 'ready' : unlock,
    unlock,
    ...(to ? { replyTo: to } : {}),
    ...(files ? { files: true as const } : {}),
  };
}

const ALREADY_TRIED =
  'This reply was already tried once, and it is not known whether it posted. Check the thread; to post it anyway, change the words.';

const LOST_TRACK = 'The host lost track of this reply, so it may have posted. Check the thread before sending again.';

const finished = new Map<string, { at: number; result: SendOutcome }>();
const sending = new Set<string>();

/**
 * Posts once, under what the host picks from the device's own person. A request repeated with the `sendId` of one that
 * posted, or may have, gets that answer back and never posts again; one that arrives while the first is still sending
 * answers that it is. Both checks come before anything awaits. A failure posted nothing, so it is not kept, and the
 * same `sendId` may try again.
 */
export async function sendReply(
  device: MobileDevice,
  sendId: string,
  text: string,
  findThread: () => Promise<ThreadToRead | null>,
  findTarget: FindTarget,
  mayPost: () => boolean,
  recipient: Recipient = undefined,
  files: ReplyFile[] = [],
): Promise<SendAnswer> {
  const key = JSON.stringify([device.id, sendId]);
  const done = finished.get(key);
  if (done?.result.outcome === 'unknown') return { outcome: 'unknown', error: ALREADY_TRIED };
  if (done) return done.result;
  if (sending.has(key)) return 'sending';
  sending.add(key);
  try {
    const thread = await findThread();
    if (!thread) return 'gone';
    if (typeof recipient === 'string' && !thread.agents.some(({ agentGroupId }) => agentGroupId === recipient))
      return 'not-an-agent';
    const target = await findTarget(thread, device, recipient);
    if (!target) return 'not-here';
    const refused = target.refuse?.(text, files);
    if (refused) return { outcome: 'failed', error: refused };
    if (!mayPost()) return 'limited';
    let result: SendOutcome;
    try {
      result = await target.post(text, files);
      // eslint-disable-next-line no-catch-all/no-catch-all -- a post that threw may already have reached the platform, so it is never sent again
    } catch (err) {
      log.error('Mobile: a reply’s post threw', { deviceId: device.id, err });
      result = { outcome: 'unknown', error: LOST_TRACK };
    }
    const now = Date.now();
    for (const [old, entry] of finished) if (entry.at < now - FINISHED_TTL_MS) finished.delete(old);
    if (result.outcome !== 'failed') finished.set(key, { at: now, result });
    log.info('Mobile: reply sent', { deviceId: device.id, outcome: result.outcome });
    return result;
  } finally {
    sending.delete(key);
  }
}

const NAME_LINE_MARK = 'from the Anderton app';
const MARKDOWN_RE = /[\\*_~`|>#[\]()-]/g;
const FORMAT_CHARS_RE = /\p{Cf}/gu;

/**
 * The name line's own words, even split up by markup or format characters. The quote `relayBody` puts the words in is
 * what keeps a line of theirs from standing where the name line does; this refuses the plain imitation in it.
 */
export const imitatesNameLine = (words: string) =>
  words
    .replace(MARKDOWN_RE, '')
    .replace(FORMAT_CHARS_RE, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .includes(NAME_LINE_MARK.toLowerCase());

/**
 * What a bot posts for someone: a line naming them, then their words, quoted, so no line of theirs, however written,
 * can stand where the name line does. Neither can address anyone: every mention is broken, so it renders as text and
 * pings no one even where the platform would parse it.
 */
export function relayBody(name: string, words: string): string {
  const shownName = neutralizeMentions(name.replace(/\s+/g, ' ').trim()).replace(MARKDOWN_RE, (c) => `\\${c}`);
  const said = neutralizeMentions(words.replace(/\r\n?/g, '\n').trim());
  return said ? `**${shownName}** · ${NAME_LINE_MARK}\n>>> ${said}` : `**${shownName}** · ${NAME_LINE_MARK}`;
}

export function _resetReplyForTest(): void {
  claims.clear();
  readyWaitMs = READY_WAIT_MS;
  finished.clear();
  sending.clear();
}
