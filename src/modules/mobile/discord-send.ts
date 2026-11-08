/**
 * Replying in a Discord thread from the app. The bot of the agent the thread has been talking to posts the words under
 * a line naming the person, and the host hands the same words to that agent as the person's own message. The post
 * never routes: its author is a bot, and the agent's identity for it comes only from the paired device.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';

import type { InboundEvent } from '../../channels/adapter.js';
import { INBOUND_ATTACHMENT_MAX_BYTES, INBOUND_ATTACHMENTS_PER_MESSAGE_MAX_BYTES } from '../../config.js';
import { confirmRelayPost, forgetRelayPost, recordRelayPost } from '../../discord-relay-posts.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { lastOwnPostAt } from '../../message-archive.js';
import { getUser } from '../permissions/db/users.js';
import {
  discordPostMessage,
  discordPoster,
  placeOf,
  rawUserId,
  userPlatform,
  type DiscordReads,
} from '../voice-call/group/place.js';
import type { MobileDevice } from './devices.js';
import { imitatesNameLine, relayBody, type Recipient, type ReplyTarget, type SendOutcome } from './reply.js';
import { threadForReply, type ThreadToRead } from './threads.js';
import type { ReplyFile } from './uploads.js';

/** Discord's own limit on one message. */
const MAX_POST_CHARS = 2000;
/** Discord's default limit on each file a message carries; a boosted server allows more, but no less. */
const MAX_DISCORD_FILE_BYTES = 20 * 1024 * 1024;
/** A thread screen asks for its reply box on every poll; a send always asks Discord whether the person may post. */
const SHOWN_TTL_MS = 60_000;

type Poster = typeof discordPoster;

async function routeToAgent(event: InboundEvent): Promise<void> {
  const { routeInbound } = await import('../../router.js');
  await routeInbound(event);
}

/** The bot's own user id, once its adapter has registered it. */
async function botUserId(channelType: string): Promise<string | undefined> {
  const { getKnownDiscordBots } = await import('../../channels/discord.js');
  return getKnownDiscordBots().get(channelType)?.userId;
}

const realDeps = { poster: discordPoster as Poster, post: discordPostMessage, route: routeToAgent, botUserId };
let deps = realDeps;

export function _setDiscordSendDepsForTest(fakes: Partial<typeof deps> | null): void {
  deps = fakes ? { ...deps, ...fakes } : realDeps;
}

type ToRead = ThreadToRead & { threadId: string };

interface Addressed {
  agent: ThreadToRead['agents'][number];
  /** The id a message this person typed there would carry. */
  userId: string;
}

async function callable(
  agent: Addressed['agent'],
  thread: ToRead,
  pairedId: string,
  reads: DiscordReads,
): Promise<Addressed | null> {
  const usable = await threadForReply(agent.sessionId, pairedId, reads, thread.threadId);
  return usable ? { agent, userId: usable.userId } : null;
}

/**
 * The agent the thread has been talking to: whose bot posted there last, else the one engaged last. Only an agent this
 * person can call there now counts; a thread no agent has posted in or engaged yet has no one to address.
 */
async function addressedAgent(thread: ToRead, pairedId: string, reads: DiscordReads): Promise<Addressed | null> {
  const ranked = await Promise.all(
    thread.agents.map(async (agent) => {
      const posted =
        lastOwnPostAt({ ...agent, platformId: thread.platformId, threadId: thread.threadId }) ??
        (thread.starter?.agentGroupId === agent.agentGroupId ? thread.starter.sentAt : null);
      return { agent, posted, engaged: (await getSession(agent.sessionId))?.engaged_at ?? null };
    }),
  );
  const order = (at: string | null) => (at ? Date.parse(at) : -Infinity);
  ranked.sort((a, b) => order(b.posted) - order(a.posted) || order(b.engaged) - order(a.engaged));
  for (const { agent, posted, engaged } of ranked) {
    if (!posted && !engaged) break;
    const addressed = await callable(agent, thread, pairedId, reads);
    if (addressed) return addressed;
  }
  return null;
}

/**
 * Whose bot posts, and whether the words reach its agent as a mention. A chosen agent's bot posts, mentioning it. With
 * none chosen the bot is the addressed agent's, or for `null` any this person can call; only an app that named no one
 * mentions it, and for `null` the words reach it unmentioned, so the thread's own rules decide, as for a message typed
 * there without a mention.
 */
async function posting(
  thread: ToRead,
  pairedId: string,
  recipient: Recipient,
  reads: DiscordReads,
): Promise<(Addressed & { mention: boolean }) | null> {
  if (typeof recipient === 'string') {
    const agent = thread.agents.find(({ agentGroupId }) => agentGroupId === recipient);
    const chosen = agent && (await callable(agent, thread, pairedId, reads));
    return chosen ? { ...chosen, mention: true } : null;
  }
  const addressed = await addressedAgent(thread, pairedId, reads);
  if (addressed) return { ...addressed, mention: recipient === undefined };
  if (recipient === undefined) return null;
  for (const agent of thread.agents) {
    const any = await callable(agent, thread, pairedId, reads);
    if (any) return { ...any, mention: false };
  }
  return null;
}

const shown = new Map<string, { until: number; target: Promise<ReplyTarget | null> }>();

/** The same answer as `discordReplyTarget`, reused for a minute, for a screen deciding what to show. */
export function shownDiscordReplyTarget(thread: ThreadToRead, device: MobileDevice): Promise<ReplyTarget | null> {
  const key = JSON.stringify([device.id, thread.platformId, thread.threadId]);
  const now = Date.now();
  for (const [old, entry] of shown) if (entry.until < now) shown.delete(old);
  const cached = shown.get(key);
  if (cached) return cached.target;
  const target = discordReplyTarget(thread, device, undefined, new Map());
  shown.set(key, { until: now + SHOWN_TTL_MS, target });
  return target;
}

/**
 * A Discord thread, not a DM or a channel's root, in which this person could post themselves, which Discord is asked
 * through `reads` each time.
 */
export async function discordReplyTarget(
  thread: ThreadToRead,
  device: MobileDevice,
  recipient: Recipient,
  reads: DiscordReads,
): Promise<ReplyTarget | null> {
  if (userPlatform(device.user_id) !== 'discord' || !thread.threadId) return null;
  const toRead: ToRead = { ...thread, threadId: thread.threadId };
  const first = thread.agents[0];
  const place = first && placeOf({ channel_type: first.channelType, platform_id: thread.platformId }, thread.threadId);
  if (!place || place === 'dm' || place.platform !== 'discord' || !place.threadId) return null;
  const { threadId: discordThreadId } = place;
  const addressed = await posting(toRead, device.user_id, recipient, reads);
  if (!addressed) return null;
  const { agent, userId, mention } = addressed;
  const poster = await deps
    .poster({ ...place, threadId: discordThreadId }, agent.channelType, rawUserId(userId), reads)
    .catch((err: unknown) => {
      log.warn('Mobile: Discord posting check failed', { channelType: agent.channelType, err });
      return null;
    });
  if (!poster) return null;
  const name = poster.name || (await getUser(userId))?.display_name || 'Someone';
  const { files: mayAttach } = poster;
  const frame = relayBody(name, 'x').length - 1;
  return {
    to: agent.name,
    unlock: 'enable',
    files: mayAttach,
    refuse(words, files) {
      if (imitatesNameLine(words)) return 'A reply cannot contain the line that names its sender. Nothing was posted.';
      const room = MAX_POST_CHARS - frame;
      if (relayBody(name, words).length > MAX_POST_CHARS)
        return `That is over ${room} characters for one Discord message. Split it into shorter replies.`;
      if (files.length > 0 && !mayAttach) return 'You cannot attach files in this thread. Nothing was posted.';
      if (files.some(({ size }) => size > MAX_DISCORD_FILE_BYTES))
        return `Discord takes files up to ${MAX_DISCORD_FILE_BYTES / 1024 / 1024} MB. Nothing was posted.`;
      return null;
    },
    post: (words, files) => relay({ thread: toRead, discordThreadId, agent, userId, name, mention }, words, files),
  };
}

interface Relay {
  thread: ToRead;
  discordThreadId: string;
  agent: Addressed['agent'];
  userId: string;
  name: string;
  mention: boolean;
}

async function relay(
  { thread, discordThreadId, agent, userId, name, mention }: Relay,
  words: string,
  files: ReplyFile[],
): Promise<SendOutcome> {
  const bot = await deps.botUserId(agent.channelType);
  if (!bot) return { outcome: 'failed', error: 'The host does not know this bot yet. Nothing was posted.' };
  let attachments: Array<Record<string, unknown>> | undefined;
  try {
    attachments = files.length > 0 ? inboundAttachments(files) : undefined;
    // eslint-disable-next-line no-catch-all/no-catch-all -- nothing is posted without what the agent is handed, and the person is told so
  } catch (err) {
    log.error('Mobile: a reply’s files could not be read', { channelType: agent.channelType, err });
    return { outcome: 'failed', error: 'The host could not read a file for this reply. Nothing was posted.' };
  }
  const content = relayBody(name, words);
  const nonce = randomBytes(12).toString('base64url');
  let relayId: string;
  try {
    relayId = await recordRelayPost({ botUserId: bot, channelId: discordThreadId, text: content, nonce });
    // eslint-disable-next-line no-catch-all/no-catch-all -- nothing is posted without its record, and the person is told so
  } catch (err) {
    log.error('Mobile: Discord relay could not be recorded', { channelType: agent.channelType, err });
    return { outcome: 'failed', error: 'The host could not get ready to post. Nothing was posted.' };
  }
  const answer = await deps.post(
    agent.channelType,
    discordThreadId,
    { content, allowed_mentions: { parse: [] }, nonce, enforce_nonce: true },
    files,
  );
  if (answer.unknown) {
    return {
      outcome: 'unknown',
      error: 'Discord did not answer, so it may have posted. Check the thread before sending again.',
    };
  }
  if (!answer.messageId) {
    await forgetRelayPost(relayId).catch((err: unknown) => log.warn('Mobile: Discord relay record kept', { err }));
    log.warn('Mobile: Discord refused a reply', { channelType: agent.channelType, error: answer.error });
    return { outcome: 'failed', error: 'Discord refused it. Nothing was posted.' };
  }
  await confirmRelayPost(relayId, answer.messageId).catch((err: unknown) =>
    log.warn('Mobile: Discord relay message id not kept', { err }),
  );
  const event = agentEvent({ thread, agent, userId, name, mention, messageId: answer.messageId }, words, attachments);
  const postedAt = event.message.timestamp;
  try {
    await deps.route(event);
    // eslint-disable-next-line no-catch-all/no-catch-all -- the words are already posted, so this reports rather than fails
  } catch (err) {
    log.error('Mobile: a posted reply did not reach the agent', { channelType: agent.channelType, err });
    return { outcome: 'sent', warning: `Posted, but ${agent.name} was not told. Mention it in the thread.`, postedAt };
  }
  return { outcome: 'sent', postedAt };
}

/** As the person's own message, by the id a message they typed there would carry. */
function agentEvent(
  { thread, agent, userId, name, mention, messageId }: Omit<Relay, 'discordThreadId'> & { messageId: string },
  words: string,
  attachments: Array<Record<string, unknown>> | undefined,
): InboundEvent {
  const senderId = rawUserId(userId);
  const content = {
    text: words.replace(/\r\n?/g, '\n').trim(),
    sender: name,
    senderId,
    senderName: name,
    author: { userId: senderId, userName: name, fullName: name, isBot: false, isMe: false },
    isMention: mention,
    ...(attachments ? { attachments } : {}),
  };
  return {
    channelType: agent.channelType,
    platformId: thread.platformId,
    threadId: thread.threadId,
    isDM: false,
    message: {
      id: messageId,
      kind: 'chat-sdk',
      content: JSON.stringify(content),
      timestamp: new Date().toISOString(),
      isMention: mention,
      isGroup: true,
    },
  };
}

/**
 * The files as a typed message's attachments reach the agent, bytes inline within the same budget the bridge keeps for
 * them (`chat-sdk-bridge.ts`), so the agent sees the screenshot it was sent.
 */
function inboundAttachments(files: ReplyFile[]): Array<Record<string, unknown>> {
  let budget = INBOUND_ATTACHMENTS_PER_MESSAGE_MAX_BYTES;
  return files.map(({ path: filePath, name, type, size }) => {
    const entry = { type: type.startsWith('image/') ? 'image' : 'file', name, mimeType: type, size };
    if (size > Math.min(budget, INBOUND_ATTACHMENT_MAX_BYTES)) return entry;
    budget -= size;
    return { ...entry, data: fs.readFileSync(filePath).toString('base64') };
  });
}

export function _resetDiscordSendForTest(): void {
  shown.clear();
}
