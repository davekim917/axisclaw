import { botTokenKeyForChannelType, SlackApiError, slackRead } from '../../channels/slack-lib.js';
import {
  getKnownSlackBots,
  getKnownSlackHumans,
  ownSlackPicture,
  type SlackProfile,
} from '../../channels/slack-mentions.js';
import { isDiscordChannelType } from '../../discord-bot.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { discordReader, rawUserId } from '../voice-call/group/place.js';
import { VoiceCallRefused } from '../voice-call/service.js';

const DAY_MS = 24 * 60 * 60_000;
const AVATAR_REFRESH_MS = 7 * DAY_MS;
export const AVATAR_FETCHES_AT_ONCE = 2;
export const AVATAR_FETCHES_PER_READ = 10;
const QUEUE_MAX = 200;
const ENTRIES_MAX = 5_000;
const RETRY_FIRST_MS = 60_000;
const RETRY_MAX_MS = DAY_MS;
const DISCORD_AVATAR_SIZE = 128;
/** Answers that say this person has no picture we can read, as opposed to a failure worth trying again. */
const SLACK_NO_PICTURE = new Set(['user_not_found', 'missing_scope', 'not_allowed_token_type']);

export interface Person {
  /** One person per platform account: a Slack id within its workspace, a Discord id everywhere. */
  key: string;
  channelType: string;
  userId: string;
  /** Slack only: the workspace whose member roster may already hold this person's picture. */
  teamId?: string;
}

/**
 * The person behind an archived sender id such as `slack-acme:U0EXAMPLE`. Null when the bot that archived it has not
 * registered its workspace, since a Slack id names someone only within one.
 */
export function personOf(senderId: string): Person | null {
  const colon = senderId.indexOf(':');
  if (colon <= 0) return null;
  const channelType = senderId.slice(0, colon);
  const userId = rawUserId(senderId);
  if (!userId) return null;
  if (isDiscordChannelType(channelType)) return { key: `discord:${userId}`, channelType, userId };
  const teamId = getKnownSlackBots().get(channelType)?.teamId;
  return teamId ? { key: `slack:${teamId}:${userId}`, channelType, userId, teamId } : null;
}

/**
 * A Slack member's picture comes from the roster the adapter lists at start and hourly, so it is there from the first
 * read. Only someone the roster cannot answer for, a Discord person or a Slack Connect guest, goes to `cache`.
 */
export function peoplePictures(people: Person[], cache: AvatarCache): Map<string, string> {
  const rosters = new Map<string, Map<string, string | undefined>>();
  const roster = (teamId: string) => {
    let members = rosters.get(teamId);
    if (!members) {
      members = new Map((getKnownSlackHumans().get(teamId) ?? []).map((human) => [human.userId, human.imageUrl]));
      rosters.set(teamId, members);
    }
    return members;
  };
  const urls = new Map<string, string>();
  const unlisted: Person[] = [];
  for (const person of people) {
    const members = person.teamId ? roster(person.teamId) : null;
    if (!members?.has(person.userId)) unlisted.push(person);
    else if (members.get(person.userId)) urls.set(person.key, members.get(person.userId)!);
  }
  for (const [key, url] of cache.lookup(unlisted)) urls.set(key, url);
  return urls;
}

export type FetchAvatar = (person: Person) => Promise<string | null>;

export interface AvatarCache {
  /**
   * Never waits on a platform: answers the pictures already held, stale ones included, and queues up to
   * `AVATAR_FETCHES_PER_READ` of the missing or stale ones for a later read.
   */
  lookup(people: Person[]): Map<string, string>;
  settled(): Promise<void>;
}

/** `pump` runs on a later turn, so a fetch's token read and request setup never run inside the read that queued it. */
export function avatarCache(fetchAvatar: FetchAvatar, now: () => number = Date.now): AvatarCache {
  const held = new Map<string, { url: string | null; at: number }>();
  const failures = new Map<string, { count: number; until: number }>();
  const queued = new Map<string, Person>();
  const fetching = new Set<string>();
  let waiters: Array<() => void> = [];
  let pumpScheduled = false;

  const remember = (key: string, url: string | null) => {
    held.delete(key);
    held.set(key, { url, at: now() });
    if (held.size > ENTRIES_MAX) held.delete(held.keys().next().value!);
    failures.delete(key);
  };

  const backOff = (key: string) => {
    const count = (failures.get(key)?.count ?? 0) + 1;
    failures.set(key, { count, until: now() + Math.min(RETRY_FIRST_MS * 2 ** (count - 1), RETRY_MAX_MS) });
    if (failures.size > ENTRIES_MAX) failures.delete(failures.keys().next().value!);
  };

  const pump = () => {
    for (const [key, person] of queued) {
      if (fetching.size >= AVATAR_FETCHES_AT_ONCE) break;
      queued.delete(key);
      fetching.add(key);
      void fetchAvatar(person)
        .then(
          (url) => remember(key, url),
          () => backOff(key),
        )
        .finally(() => {
          fetching.delete(key);
          pump();
        });
    }
    if (queued.size === 0 && fetching.size === 0) {
      const done = waiters;
      waiters = [];
      for (const resolve of done) resolve();
    }
  };

  return {
    lookup(people) {
      const urls = new Map<string, string>();
      let asked = 0;
      for (const person of people) {
        const { key } = person;
        const entry = held.get(key);
        if (entry?.url) urls.set(key, entry.url);
        if (entry && now() - entry.at < AVATAR_REFRESH_MS) continue;
        if (queued.has(key) || fetching.has(key) || (failures.get(key)?.until ?? 0) > now()) continue;
        if (asked >= AVATAR_FETCHES_PER_READ || queued.size >= QUEUE_MAX) continue;
        queued.set(key, person);
        asked += 1;
      }
      if (asked > 0 && !pumpScheduled) {
        pumpScheduled = true;
        setImmediate(() => {
          pumpScheduled = false;
          pump();
        });
      }
      return urls;
    },
    settled() {
      if (queued.size === 0 && fetching.size === 0) return Promise.resolve();
      return new Promise((resolve) => waiters.push(resolve));
    },
  };
}

const slackNoPictureLogged = new Set<string>();

async function platformAvatar({ channelType, userId }: Person): Promise<string | null> {
  if (isDiscordChannelType(channelType)) {
    let read: (path: string) => Promise<unknown>;
    try {
      read = discordReader(channelType);
    } catch (err) {
      if (err instanceof VoiceCallRefused) return null;
      throw err;
    }
    const user = (await read(`/users/${userId}`)) as { avatar?: string | null } | null;
    return user?.avatar
      ? `https://cdn.discordapp.com/avatars/${userId}/${user.avatar}.png?size=${DISCORD_AVATAR_SIZE}`
      : null;
  }
  const key = botTokenKeyForChannelType(channelType);
  const token = readEnvFile([key])[key];
  if (!token) return null;
  try {
    const res = await slackRead(token, 'users.info', { user: userId }, 'mobile-avatar');
    const profile = (res.user as { profile?: SlackProfile } | undefined)?.profile;
    return profile ? ownSlackPicture(profile) : null;
  } catch (err) {
    const code = err instanceof SlackApiError ? err.message.split(': ').at(-1) : undefined;
    if (!code || !SLACK_NO_PICTURE.has(code)) throw err;
    if (code !== 'user_not_found' && !slackNoPictureLogged.has(`${channelType} ${code}`)) {
      slackNoPictureLogged.add(`${channelType} ${code}`);
      log.warn('Mobile: a Slack bot cannot read people’s pictures, so its thread shows initials', {
        channelType,
        code,
      });
    }
    return null;
  }
}

export const personAvatars = avatarCache(platformAvatar);

export async function botPictures(): Promise<Map<string, string>> {
  const { getKnownDiscordBots } = await import('../../channels/discord.js');
  const pictures = new Map<string, string>();
  for (const bot of getKnownSlackBots().values()) if (bot.imageUrl) pictures.set(bot.userId, bot.imageUrl);
  for (const bot of getKnownDiscordBots().values()) if (bot.avatarUrl) pictures.set(bot.userId, bot.avatarUrl);
  return pictures;
}
