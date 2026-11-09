import { openAsBlob } from 'fs';

import { botTokenKeyForChannelType, slackRead } from '../../../channels/slack-lib.js';
import { extractSlackChannelId } from '../../../channels/slack.js';
import { discordApiBase, discordBotTokenKey, isDiscordChannelType } from '../../../discord-bot.js';
import { readEnvFile } from '../../../env.js';
import { log } from '../../../log.js';
import { isChannelVariant } from '../../../types.js';
import { VoiceCallRefused } from '../service.js';

const MAX_MEMBER_PAGES = 200;
const DISCORD_TIMEOUT_MS = 5_000;
/** 20 a second, under half of Discord's 50 per bot, because the adapter posts on the same token. */
const DISCORD_READ_GAP_MS = 50;
const DEFAULT_RETRY_AFTER_S = 1;
/** A read that never answers fails the check here instead of holding its caller; inside the app's 30 s request limit. */
const CHECK_DEADLINE_MS = 20_000;
const VIEW_CHANNEL = 1n << 10n;
const ADMINISTRATOR = 1n << 3n;
const MANAGE_THREADS = 1n << 34n;
const SEND_MESSAGES_IN_THREADS = 1n << 38n;
const ATTACH_FILES = 1n << 15n;
const POST_TIMEOUT_MS = 15_000;
/** Ten files of up to 20 MiB go up with the post. */
const POST_WITH_FILES_TIMEOUT_MS = 120_000;
const PRIVATE_THREAD = 12;

export type CallPlace =
  | { platform: 'slack'; channelId: string }
  | { platform: 'discord'; guildId: string; channelId: string; threadId: string | null };

const isSlackChannelType = (channelType: string) => channelType === 'slack' || isChannelVariant(channelType, 'slack');

/** Which platform a channel type, or the namespace of a user id, belongs to. */
export const platformOf = (channelType: string): CallPlace['platform'] | null =>
  isSlackChannelType(channelType) ? 'slack' : isDiscordChannelType(channelType) ? 'discord' : null;

/** A channel or thread a call can come from, 'dm' for a direct message, null on a platform calls don't support. */
export function placeOf(
  mg: { channel_type: string; platform_id: string },
  threadId: string | null,
): CallPlace | 'dm' | null {
  if (isSlackChannelType(mg.channel_type)) {
    const channelId = extractSlackChannelId(mg.platform_id);
    return channelId.startsWith('D') ? 'dm' : { platform: 'slack', channelId };
  }
  if (isDiscordChannelType(mg.channel_type)) {
    const [, guildId, channelId] = mg.platform_id.split(':');
    if (!guildId || !channelId) return null;
    if (guildId === '@me') return 'dm';
    const thread = threadId?.split(':');
    const inThread = thread?.length === 4 && thread[1] === guildId && thread[2] === channelId ? thread[3] : null;
    return { platform: 'discord', guildId, channelId, threadId: inThread };
  }
  return null;
}

export const rawUserId = (userId: string) => userId.slice(userId.indexOf(':') + 1);

export const userPlatform = (userId: string) => platformOf(userId.split(':')[0]);

/** Shared across one batch of checks, or one request, so a guild, channel or member is fetched once. */
export type DiscordReads = Map<string, Promise<unknown>>;

/** Which of these users can see the conversation the call hears, by the bot that serves it (`channelType`). */
export async function whoCanSee(
  place: CallPlace,
  channelType: string,
  userIds: string[],
  reads?: DiscordReads,
): Promise<Set<string>> {
  const wanted = [...new Set(userIds.map(rawUserId))];
  if (wanted.length === 0) return new Set();
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`No answer in ${CHECK_DEADLINE_MS} ms`)), CHECK_DEADLINE_MS);
  });
  const check =
    place.platform === 'slack'
      ? slackMembers(place.channelId, channelType, wanted)
      : discordViewers(place, channelType, wanted, reads);
  return Promise.race([check, late]).finally(() => clearTimeout(timer));
}

async function slackMembers(channelId: string, channelType: string, wanted: string[]): Promise<Set<string>> {
  const key = botTokenKeyForChannelType(channelType);
  const token = readEnvFile([key])[key];
  if (!token) throw new VoiceCallRefused('Group calls cannot check who is in this channel.');
  const want = new Set(wanted);
  const found = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (++pages > MAX_MEMBER_PAGES) throw new VoiceCallRefused('Group calls could not check who is in this channel.');
    const page = await slackRead(
      token,
      'conversations.members',
      { channel: channelId, limit: 1000, ...(cursor ? { cursor } : {}) },
      'group-call',
    );
    for (const member of (page.members as unknown[] | undefined) ?? [])
      if (typeof member === 'string' && want.has(member)) found.add(member);
    cursor = (page.response_metadata as { next_cursor?: string } | undefined)?.next_cursor || undefined;
  } while (cursor && found.size < want.size);
  return found;
}

interface Overwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}

/**
 * Discord's channel permission rules: the everyone role and the member's roles, then the channel's everyone, role and
 * member overwrites in that order. The guild owner and administrators see everything.
 */
export function discordPermissions(input: {
  guild: { id: string; owner_id: string; roles: Array<{ id: string; permissions: string }> };
  member: { roles: string[] };
  userId: string;
  overwrites: Overwrite[];
}): bigint {
  const { guild, member, userId, overwrites } = input;
  if (guild.owner_id === userId) return ~0n;
  const roleBits = new Map(guild.roles.map((role) => [role.id, BigInt(role.permissions)]));
  let perms = roleBits.get(guild.id) ?? 0n;
  for (const role of member.roles) perms |= roleBits.get(role) ?? 0n;
  if (perms & ADMINISTRATOR) return ~0n;
  const apply = (allow: bigint, deny: bigint) => (perms = (perms & ~deny) | allow);
  const everyone = overwrites.find((o) => o.id === guild.id);
  if (everyone) apply(BigInt(everyone.allow), BigInt(everyone.deny));
  let allow = 0n;
  let deny = 0n;
  for (const o of overwrites)
    if (o.type === 0 && o.id !== guild.id && member.roles.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  apply(allow, deny);
  const own = overwrites.find((o) => o.type === 1 && o.id === userId);
  if (own) apply(BigInt(own.allow), BigInt(own.deny));
  return perms;
}

/** Discord asked this bot to slow down, which says nothing about who can see what. */
export class DiscordBusy extends Error {}

const nextDiscordRead = new Map<string, number>();
const discordCooldownUntil = new Map<string, number>();

/**
 * Refuses rather than queue past the read timeout, so callers fail closed instead of piling up behind a rate limit. A
 * read already waiting when a 429 lands queues again behind it. A post on the bot's token waits its turn here too.
 */
async function discordTurn(bot: string): Promise<void> {
  const now = Date.now();
  const at = Math.max(now, nextDiscordRead.get(bot) ?? 0, discordCooldownUntil.get(bot) ?? 0);
  if (at - now > DISCORD_TIMEOUT_MS) throw new DiscordBusy('Discord check skipped: too many waiting');
  nextDiscordRead.set(bot, at + DISCORD_READ_GAP_MS);
  if (at > now) await new Promise((resolve) => setTimeout(resolve, at - now));
  if (Date.now() < (discordCooldownUntil.get(bot) ?? 0)) return discordTurn(bot);
}

/** The bot's token, by the key `discordTurn` paces it under; null on a host that has none for this bot. */
function discordBotToken(channelType: string): { key: string; token: string } | null {
  const key = discordBotTokenKey(channelType);
  const token = readEnvFile([key])[key];
  return token ? { key, token } : null;
}

type DiscordPlace = Extract<CallPlace, { platform: 'discord' }>;

interface DiscordMember {
  roles: string[];
  communication_disabled_until?: string | null;
  nick?: string | null;
  user?: { username?: string; global_name?: string | null };
}

/** Reads through this bot's limiter, each path once across `reads`. A 404 reads as null. */
export function discordReader(
  channelType: string,
  reads: DiscordReads = new Map(),
): (path: string) => Promise<unknown> {
  const bot = discordBotToken(channelType);
  if (!bot) throw new VoiceCallRefused('Group calls cannot check who is in this channel.');
  const { key, token } = bot;
  const read = async (path: string): Promise<unknown> => {
    await discordTurn(key);
    const res = await fetch(`${discordApiBase()}${path}`, {
      headers: { Authorization: `Bot ${token}` },
      signal: AbortSignal.timeout(DISCORD_TIMEOUT_MS),
    });
    if (res.status === 429) {
      const retryAfterS = Number(res.headers.get('retry-after')) || DEFAULT_RETRY_AFTER_S;
      const until = Date.now() + retryAfterS * 1000;
      discordCooldownUntil.set(key, Math.max(until, discordCooldownUntil.get(key) ?? 0));
      throw new DiscordBusy(`Discord ${path.split('/')[1]} check failed: 429`);
    }
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`Discord ${path.split('/')[1]} check failed: ${res.status}`);
    return res.json();
  };
  return (path: string): Promise<unknown> => {
    const shared = reads.get(`${key} ${path}`) ?? read(path);
    reads.set(`${key} ${path}`, shared);
    return shared;
  };
}

/**
 * A Discord thread's kind, which never changes: only a private thread hides from people who can see its channel. Null
 * when this bot cannot read the thread, which a sibling bot may still do.
 */
export async function discordThreadKind(
  threadId: string,
  channelType: string,
  reads?: DiscordReads,
): Promise<'public' | 'private' | null> {
  const thread = (await discordReader(channelType, reads)(`/channels/${threadId}`)) as { type: number } | null;
  if (!thread) return null;
  return thread.type === PRIVATE_THREAD ? 'private' : 'public';
}

const memberPath = (place: DiscordPlace, userId: string) => `/guilds/${place.guildId}/members/${userId}`;

/** What every check of one place reads once: the guild, its channel and, in a thread, the thread. */
async function discordScene(place: DiscordPlace, get: (path: string) => Promise<unknown>) {
  const guild = (await get(`/guilds/${place.guildId}`)) as Parameters<typeof discordPermissions>[0]['guild'] | null;
  const channel = (await get(`/channels/${place.channelId}`)) as { permission_overwrites?: Overwrite[] } | null;
  if (!guild || !channel) throw new VoiceCallRefused('Group calls cannot see this channel.');
  const thread = place.threadId
    ? ((await get(`/channels/${place.threadId}`)) as { type: number; thread_metadata?: { locked?: boolean } } | null)
    : null;
  if (place.threadId && !thread) throw new VoiceCallRefused('Group calls cannot see this thread.');
  return { guild, channel, thread };
}

/** The member and their permissions there, or null when they can't see it: a private thread also needs them in it. */
async function memberView(
  place: DiscordPlace,
  { guild, channel, thread }: Awaited<ReturnType<typeof discordScene>>,
  get: (path: string) => Promise<unknown>,
  userId: string,
): Promise<{ member: DiscordMember; perms: bigint } | null> {
  const member = (await get(memberPath(place, userId))) as DiscordMember | null;
  if (!member) return null;
  const perms = discordPermissions({ guild, member, userId, overwrites: channel.permission_overwrites ?? [] });
  if (!(perms & VIEW_CHANNEL)) return null;
  if (thread?.type === PRIVATE_THREAD && !(perms & MANAGE_THREADS)) {
    if (!(await get(`/channels/${place.threadId}/thread-members/${userId}`))) return null;
  }
  return { member, perms };
}

async function discordViewers(
  place: DiscordPlace,
  channelType: string,
  wanted: string[],
  reads?: DiscordReads,
): Promise<Set<string>> {
  const get = discordReader(channelType, reads);
  const scene = await discordScene(place, get);
  const found = new Set<string>();
  for (const userId of wanted) if (await memberView(place, scene, get, userId)) found.add(userId);
  return found;
}

/**
 * Whether this person could post in the thread themselves, read live, the name the server shows for them, and whether
 * they could attach files there. A bot posting for someone must never reach further than they could, so a locked thread
 * needs what it would need of them.
 */
export async function discordPoster(
  place: DiscordPlace & { threadId: string },
  channelType: string,
  userId: string,
  reads?: DiscordReads,
): Promise<{ name: string | null; files: boolean } | null> {
  const get = discordReader(channelType, reads);
  // All four at once: a send checks one person, where a batch of checks reads in turn so one that fails stops reading.
  await Promise.all(
    [
      `/guilds/${place.guildId}`,
      `/channels/${place.channelId}`,
      `/channels/${place.threadId}`,
      memberPath(place, userId),
    ].map(get),
  );
  const scene = await discordScene(place, get);
  const view = await memberView(place, scene, get, userId);
  if (!view || !(view.perms & SEND_MESSAGES_IN_THREADS)) return null;
  if (scene.thread?.thread_metadata?.locked && !(view.perms & MANAGE_THREADS)) return null;
  const { member } = view;
  // A timeout keeps the member's roles, and with them the bits above, while Discord refuses their posts.
  if (Date.parse(member.communication_disabled_until ?? '') > Date.now()) return null;
  const name = member.nick || member.user?.global_name || member.user?.username || null;
  return { name, files: (view.perms & ATTACH_FILES) !== 0n };
}

/** What Discord said to a post: its message id, `unknown` when it may have posted, or why it did not. */
export interface DiscordPosted {
  messageId?: string;
  unknown?: true;
  error?: string;
}

/**
 * Posts once as the bot and never retries: a request with no answer, or a server error, may have posted. Only an
 * answer Discord gave before posting is a refusal.
 */
export async function discordPostMessage(
  channelType: string,
  channelId: string,
  body: Record<string, unknown>,
  files: Array<{ path: string; name: string; type: string }> = [],
): Promise<DiscordPosted> {
  const bot = discordBotToken(channelType);
  if (!bot) return { error: 'no bot token' };
  try {
    await discordTurn(bot.key);
  } catch (err) {
    if (!(err instanceof DiscordBusy)) throw err;
    return { error: err.message };
  }
  let request: { headers: Record<string, string>; body: string | FormData };
  if (files.length === 0) {
    request = { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  } else {
    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({ ...body, attachments: files.map((f, id) => ({ id, filename: f.name })) }),
    );
    try {
      for (const [n, file] of files.entries()) {
        form.append(`files[${n}]`, await openAsBlob(file.path, { type: file.type }), file.name);
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- nothing has been sent, so any failure to read a file is a refusal
    } catch (err) {
      log.warn('Discord post files could not be read', { error: err instanceof Error ? err.name : String(err) });
      return { error: 'a file could not be read' };
    }
    request = { headers: {}, body: form };
  }
  let res: Response;
  try {
    res = await fetch(`${discordApiBase()}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${bot.token}`, ...request.headers },
      body: request.body,
      signal: AbortSignal.timeout(files.length === 0 ? POST_TIMEOUT_MS : POST_WITH_FILES_TIMEOUT_MS),
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- a request that failed in flight may already have reached Discord
  } catch (err) {
    log.warn('Discord post failed in flight', { error: err instanceof Error ? err.name : String(err) });
    return { unknown: true };
  }
  if (res.status >= 500) return { unknown: true };
  if (res.status === 429) {
    const retryAfterS = Number(res.headers.get('retry-after')) || DEFAULT_RETRY_AFTER_S;
    discordCooldownUntil.set(
      bot.key,
      Math.max(Date.now() + retryAfterS * 1000, discordCooldownUntil.get(bot.key) ?? 0),
    );
  }
  const answer = (await res.json().catch(() => null)) as { id?: unknown; message?: unknown } | null;
  if (res.ok) return typeof answer?.id === 'string' ? { messageId: answer.id } : { unknown: true };
  return { error: typeof answer?.message === 'string' ? answer.message : `HTTP ${res.status}` };
}
