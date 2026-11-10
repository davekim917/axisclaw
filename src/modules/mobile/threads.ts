import { createHash } from 'crypto';

import { archiveTenantKey } from '../../archive-search-index.js';
import { resolveThreadPolicy } from '../../channels/channel-defaults.js';
import { getChannelAdapter, getChannelDefaults } from '../../channels/channel-registry.js';
import { neutralizeMentions } from '../../channels/neutralize-mentions.js';
import { getKnownSlackBots } from '../../channels/slack-mentions.js';
import { withCentralSync } from '../../db/central-lease.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroup, getMessagingGroupAgentByPair } from '../../db/messaging-groups.js';
import { findSessionForAgent, getSession, isTaskThread, markSessionEngaged, updateSession } from '../../db/sessions.js';
import { insertAutoThreadTitle } from '../../db/thread-titles.js';
import { isDiscordChannelType } from '../../discord-bot.js';
import { shownThreadTitle } from '../../generated-title.js';
import { log } from '../../log.js';
import {
  ARCHIVE_PATH,
  archiveSearchAvailable,
  archiveTextMatch,
  rowsInTenant,
  threadMessageById,
} from '../../message-archive.js';
import { openThreadFor, type OpenThreadError } from '../../open-thread.js';
import { resolveSession, withExistingMailboxSession } from '../../session-manager.js';
import { isHumanChatSdkContent } from '../../task-list-host.js';
import { parseUtcTimestampMs } from '../../thread-context.js';
import type { MessagingGroup, MessagingGroupAgent, Session } from '../../types.js';
import { getUser } from '../permissions/db/users.js';
import {
  type CallPlace,
  discordThreadKind,
  type DiscordReads,
  placeOf,
  platformOf,
  rawUserId,
  userPlatform,
  whoCanSee,
} from '../voice-call/group/place.js';
import { groupCallsConfigured } from '../voice-call/group/livekit.js';
import {
  groupCallPeople,
  occupiedCallSessions,
  refuseIfCallCannotOpen,
  startOrJoinGroupCallAs,
} from '../voice-call/group/service.js';
import { mayCall, spokenName, voiceCallsEnabledFor, VoiceCallRefused } from '../voice-call/service.js';
import { type ChannelNamer, channelNamer } from './channel-names.js';
import { identitiesOf, inOwnWorkspace } from './identity.js';
import {
  anchorsTable,
  anchorThreadId,
  SEARCH_WINDOW_MS,
  type TaskAnchor,
  taskAnchorsIn,
  taskAnchorsOf,
} from './task-anchors.js';
import { findInMessages, NO_TEXT_MATCHES, type TextMatches } from './text-search.js';
import type { ThreadHit } from './text-walk.js';

const DAY_MS = 24 * 60 * 60_000;
const BROWSE = { windowMs: 7 * DAY_MS, limit: 100 };
const SEARCH = { windowMs: SEARCH_WINDOW_MS, limit: 30 };
const PLACES_LIMIT = 50;
const QUERY_MAX_CHARS = 100;
const LIKE_SPECIAL_RE = /[\\%_]/g;
const THREAD_KEY_CHARS = 22;
/** How long a passed check lists its thread, so someone removed from a channel drops off within this. */
const VISIBILITY_TTL_MS = 10 * 60_000;
/** Longer than a check, because it keeps only a name this person has already been shown, and no thread comes with it. */
const SEEN_CHANNEL_TTL_MS = DAY_MS;
/** Which platforms offer the channel filter. The app shows it whenever a workgroup has more than one channel listed. */
const CHANNEL_FILTER_PLATFORMS: ReadonlySet<CallPlace['platform']> = new Set(['slack', 'discord']);
/** Short, so a platform outage hides a thread only briefly, and non-zero, so it is not paged on every poll. */
const FAILED_CHECK_TTL_MS = 60_000;
const VISIBILITY_BATCH = 8;
/** Every Discord thread is its own place, so a cold list stops here and later polls fill in the older rows. */
const NEW_CHECKS_PER_LIST = 40;
/** Checks keep starting this long into a list, past its answer, so later polls find them done. */
const VISIBILITY_BUDGET_MS = 8_000;
/** The list answers by now with the rows whose checks have passed; the rest of the checks keep running. */
const LIST_WAIT_MS = 1_000;
/** A passed check is asked again this long before it runs out, so a listed row stays listed while the app polls. */
const RENEW_WITHIN_MS = 2 * 60_000;
const SLOW_LIST_MS = 5_000;
/** Text matches are checked after title matches, so this leaves room for threads a person turns out not to see. */
const TEXT_MATCHED_THREADS = SEARCH.limit * 4;
const TITLE_MAX_CHARS = 120;
const TITLE_SCAN_ROWS = 50;
/** A third of recent sessions are bots only, and each read opens a session DB on the host's event loop. */
const NO_WORDS_TTL_MS = 5 * 60_000;
const MENTION_RE = /<[@#!][^>]*>|(?<![\w.])@[\w.-]+/g;
/** A first wake replays the thread into one message, which opens with this header: the history, not a question. */
const THREAD_CONTEXT_PREFIX = '[Thread context]';

interface Thread {
  threadKey: string;
  workgroupId: string;
  workgroupName: string;
  platform: 'slack' | 'discord';
  channelKey: string;
  channelName: string | null;
  title: string;
  lastActiveAt: string;
  /** Empty in the person's own DM, which takes no group call. */
  agents: ThreadAgent[];
  /** Set only on the person's own DM, to the name of the agent it is with. */
  dmWith?: string;
  /** Set only on the person's own DM: its agents they may call there, in a room only they may join. */
  dmCalls?: ThreadAgent[];
  call: { sessionId: string; agentName: string; avatarUrl: string | null; people: string[] } | null;
}

interface ThreadAgent {
  sessionId: string;
  agentGroupId: string;
  name: string;
  avatarUrl: string | null;
}

interface Channel {
  id: string;
  workgroupId: string;
  platform: CallPlace['platform'];
  name: string | null;
}

interface ThreadList {
  threads: Thread[];
  workgroups: { id: string; name: string }[];
  channels: Channel[];
  /** Only ever `true`: message text was not searched to the end, so a match may be missing. */
  textCutShort?: true;
  /** Only when non-zero: threads whose checks have yet to answer, any of which a later poll may list. */
  pending?: number;
}

interface ThreadFilters {
  workgroup: string | null;
  channel: string | null;
  q: string | null;
}

interface Place {
  /** Opaque, and shared by sibling bots, which each hold their own messaging group for one channel. */
  channelKey: string;
  agentGroupId: string;
  agentName: string;
  avatarUrl: string | null;
  messagingGroupId: string;
  platform: CallPlace['platform'];
  channelName: string | null;
  workgroupName: string;
  lastActiveAt: string | null;
}

type SessionFacts = Pick<Session, 'status' | 'archived_at' | 'thread_id'>;
type ChannelFacts = Pick<MessagingGroup, 'channel_type' | 'platform_id'>;

interface AgentInChannel {
  agent_group_id: string;
  messaging_group_id: string;
}

type ThreadPolicyFacts = Pick<MessagingGroupAgent, 'threads' | 'session_mode'> &
  Pick<MessagingGroup, 'channel_type' | 'instance' | 'is_group'>;

interface Wiring extends AgentInChannel, ChannelFacts, ThreadPolicyFacts {
  channel_name: string | null;
  workgroup_id: string;
  workgroup_name: string | null;
  /** The agent group's own workgroup column, which names its archive tenant (`archiveTenantKey`). */
  tenant_workgroup_id: string | null;
}

interface ThreadRow extends AgentInChannel, SessionFacts, ChannelFacts {
  id: string;
  last_active: string | null;
  title: string | null;
  title_generated_at: string | null;
  channel_name: string | null;
  workgroup_id: string;
  workgroup_name: string | null;
  thread_ref: string;
  thread_title: string | null;
  thread_active: string;
  /** On a task session's row, the post its thread grew from, which places the row in that thread of the channel. */
  anchor: string | null;
  starter_id: string | null;
}

/** Who is in a one-to-one DM never changes, so the person's own DM takes no platform check. */
interface OwnDm {
  platform: CallPlace['platform'];
  dm: true;
  /** The person's own id in it, from `user_dms`. */
  userId: string;
}

type ListedPlace = CallPlace | OwnDm;

type OwnDms = ReadonlyMap<string, OwnDm>;

const NO_DMS: OwnDms = new Map();

interface Checkable<R extends ChannelFacts> {
  row: R;
  place: ListedPlace;
}

type ListableSession = Checkable<ThreadRow>;

interface PooledThread {
  rows: ThreadRow[];
  sessions: ListableSession[];
}

/**
 * The workgroup the list files an agent group's threads under; an agent group in none is one of its own, named by its
 * folder. A workgroup id starts with a lowercase letter (the `workgroups` CHECK), so this id, which starts with `_`,
 * never names one, as a folder could.
 */
const SCOPE_ID_SQL = `COALESCE(ag.workgroup_id, '_agent-group:' || ag.id)`;
const SCOPE_NAME_SQL = `CASE WHEN ag.workgroup_id IS NULL THEN ag.folder END`;

const WIRINGS_SQL = `
  SELECT mga.agent_group_id, mga.messaging_group_id, mga.threads, mga.session_mode, mg.channel_type, mg.platform_id,
         mg.name AS channel_name, mg.instance, mg.is_group,
         ${SCOPE_ID_SQL} AS workgroup_id, COALESCE(w.display_name, ${SCOPE_NAME_SQL}) AS workgroup_name,
         ag.workgroup_id AS tenant_workgroup_id
    FROM messaging_group_agents mga
    JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
    JOIN agent_groups ag ON ag.id = mga.agent_group_id
    LEFT JOIN workgroups w ON w.id = ag.workgroup_id`;

const ANCHORED_TASKS_SQL = `
    FROM anchors a
    JOIN sessions s ON s.id = a.session_id AND s.messaging_group_id IS NULL
    JOIN messaging_groups mg ON mg.channel_type = a.channel_type AND mg.platform_id = a.platform_id
    JOIN agent_groups ag ON ag.id = s.agent_group_id`;
const ANCHOR_THREAD_SQL = `a.platform_id || ':' || a.thread_platform_id`;
/** Joins a task session's id to its thread's in the id a list row offers for a call: neither side ever holds it. */
const TASK_CALL_SEPARATOR = '~';
const taskCallId = (sessionId: string, threadId: string) =>
  `${sessionId}${TASK_CALL_SEPARATOR}${Buffer.from(threadId).toString('base64url')}`;

/** A channel or thread on this person's own platform and workspace: their id means nothing to any other. */
function ownPlace(mg: ChannelFacts, threadId: string | null, userId: string): CallPlace | null {
  const place = placeOf(mg, threadId);
  if (!place || place === 'dm' || place.platform !== userPlatform(userId)) return null;
  return inOwnWorkspace(userId, mg.channel_type) ? place : null;
}

const usableSession = (session: SessionFacts) =>
  session.status === 'active' && !session.archived_at && !session.thread_id?.startsWith('system:');

function usablePlace(session: SessionFacts, mg: ChannelFacts, userId: string): CallPlace | null {
  return usableSession(session) ? ownPlace(mg, session.thread_id, userId) : null;
}

/**
 * The person's own DMs, and the only test of whether a DM is theirs. `user_dms` holds the platform's own answer for
 * each: the channel `openDM` returned for them, or the one the platform marked as a DM when they posted in it. Their
 * workgroups, roles and agents prove nothing about a DM.
 */
async function ownDms(pairedId: string): Promise<OwnDms> {
  const identities = await identitiesOf(pairedId);
  const rows = await getDb().all<ChannelFacts & { id: string; user_id: string }>(
    `SELECT mg.id, mg.channel_type, mg.platform_id, ud.user_id
       FROM user_dms ud
       JOIN messaging_groups mg ON mg.id = ud.messaging_group_id
      WHERE ud.user_id IN (${identities.map(() => '?').join(', ')})`,
    ...identities,
  );
  const dms = new Map<string, OwnDm>();
  for (const mg of rows) {
    const platform = platformOf(mg.channel_type);
    if (platform && placeOf(mg, null) === 'dm') dms.set(mg.id, { platform, dm: true, userId: mg.user_id });
  }
  return dms;
}

async function dmWirings(dms: OwnDms): Promise<Wiring[]> {
  const ids = [...dms.keys()];
  if (ids.length === 0) return [];
  return getDb().all<Wiring>(
    `${WIRINGS_SQL} WHERE mga.messaging_group_id IN (${ids.map(() => '?').join(', ')})`,
    ...ids,
  );
}

function listedPlace(
  row: SessionFacts & ChannelFacts & AgentInChannel & { anchor: string | null },
  userId: string,
  dms: OwnDms,
): ListedPlace | null {
  const dm = dms.get(row.messaging_group_id);
  if (!dm) return usablePlace(row, row, userId);
  return usableSession(row) && row.anchor === null ? dm : null;
}

interface Visibility {
  until: number;
  seen: Promise<boolean>;
  /** Undefined until the platform has answered. */
  answer: boolean | undefined;
  /** The last check of this place failed, and this one, if still out, retries it. */
  failed: boolean;
  /** The check that replaces this one once it answers. */
  renewal?: Visibility;
}

const visibility = new Map<string, Visibility>();

const visibilityKey = (place: CallPlace, channelType: string, userId: string) =>
  JSON.stringify([place, channelType, userId]);

interface ListChecks {
  reads: DiscordReads;
  newChecksLeft: number;
  /** Off for the first pass, so a place never checked is reached before one that failed is asked again. */
  retryFailed: boolean;
}

function startCheck(
  place: CallPlace,
  channelType: string,
  userId: string,
  checks: ListChecks,
  retrying: boolean,
): Visibility {
  checks.newChecksLeft -= 1;
  const entry: Visibility = {
    until: Date.now() + VISIBILITY_TTL_MS,
    answer: undefined,
    failed: retrying,
    seen: whoCanSee(place, channelType, [userId], checks.reads).then(
      (seen) => {
        entry.failed = false;
        return (entry.answer = seen.has(rawUserId(userId)));
      },
      (err: unknown) => {
        log.warn('Mobile: visibility check failed', { channelType, err });
        entry.until = Date.now() + FAILED_CHECK_TTL_MS;
        entry.failed = true;
        return (entry.answer = false);
      },
    ),
  };
  return entry;
}

/** The cached check for this key, moved on to its renewal once it has run out; the renewal starts when one is due. */
function currentCheck(
  place: CallPlace,
  channelType: string,
  userId: string,
  checks: ListChecks,
): Visibility | undefined {
  const key = visibilityKey(place, channelType, userId);
  let cached = visibility.get(key);
  if (cached?.renewal && Date.now() >= cached.until) visibility.set(key, (cached = cached.renewal));
  if (!cached || Date.now() >= cached.until) return cached;
  const settled = cached.answer !== undefined && !cached.failed;
  if (settled && !cached.renewal && cached.until - Date.now() < RENEW_WITHIN_MS && checks.newChecksLeft > 0) {
    const renewing = cached;
    const renewal = startCheck(place, channelType, userId, checks, false);
    renewing.renewal = renewal;
    void renewal.seen.then(() => {
      const current = visibility.get(key);
      if (current === renewing || current === renewal) visibility.set(key, renewal);
    });
  }
  return cached;
}

/** False for a check the list has no budget left to start: the row stays out until a later poll reaches it. */
function seenThroughCache(place: CallPlace, channelType: string, userId: string, checks: ListChecks): Promise<boolean> {
  const key = visibilityKey(place, channelType, userId);
  const cached = currentCheck(place, channelType, userId, checks);
  if (cached && Date.now() < cached.until) return cached.seen;
  if (checks.newChecksLeft <= 0 || (cached?.failed && !checks.retryFailed)) return Promise.resolve(false);
  const entry = startCheck(place, channelType, userId, checks, cached?.failed ?? false);
  visibility.set(key, entry);
  return entry.seen;
}

type Seen = (place: CallPlace, channelType: string, userId: string) => Promise<boolean>;

/** Asked of the platform now, as a call is: it joins as whoever passes. */
const seenNow: Seen = (place, channelType, userId) =>
  whoCanSee(place, channelType, [userId]).then(
    (seen) => seen.has(rawUserId(userId)),
    (err: unknown) => {
      log.warn('Mobile: visibility check failed', { channelType, err });
      return false;
    },
  );

/**
 * For reading a thread or replying in it: the list's own answer while it says this person can see the place, renewed
 * as the list renews it, or a check already under way. Any other answer, one that failed or said no included, is asked
 * of the platform now, through `reads`, and a check that fails refuses.
 */
const seenRecently =
  (reads: DiscordReads): Seen =>
  async (place, channelType, userId) => {
    const checks: ListChecks = { reads, newChecksLeft: 1, retryFailed: true };
    const cached = currentCheck(place, channelType, userId, checks);
    if (cached && Date.now() < cached.until) {
      if (cached.answer === undefined) return cached.seen;
      if (cached.answer && !cached.failed) return true;
    }
    const entry = startCheck(place, channelType, userId, checks, cached?.failed ?? false);
    visibility.set(visibilityKey(place, channelType, userId), entry);
    return entry.seen;
  };

const seenChannels = new Map<string, number>();

const seenChannelKey = (userId: string, platformId: string) => JSON.stringify([userId, platformId]);

const hasSeenChannel = (userId: string, platformId: string) =>
  Date.now() < (seenChannels.get(seenChannelKey(userId, platformId)) ?? 0);

/** Newest first and stopping at the limit, so a person's list never pages the platform for threads it won't show. */
async function checkInOrder<T extends { sessions: Checkable<ChannelFacts>[] }>(
  all: T[],
  userId: string,
  limit: number,
): Promise<void> {
  const checks: ListChecks = { reads: new Map(), newChecksLeft: NEW_CHECKS_PER_LIST, retryFailed: false };
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => {
      checks.newChecksLeft = 0;
      resolve(false);
    }, VISIBILITY_BUDGET_MS);
  });
  try {
    for (const retryFailed of [false, true]) {
      checks.retryFailed = retryFailed;
      let kept = 0;
      for (let at = 0; at < all.length && kept < limit && checks.newChecksLeft > 0; at += VISIBILITY_BATCH) {
        const batch = await Promise.all(
          all.slice(at, at + VISIBILITY_BATCH).map(async (thread) => {
            const seen = await Promise.all(
              thread.sessions.map(({ row, place }) =>
                'dm' in place
                  ? Promise.resolve(true)
                  : Promise.race([seenThroughCache(place, row.channel_type, userId, checks), expired]),
              ),
            );
            return seen.some(Boolean);
          }),
        );
        kept += batch.filter(Boolean).length;
      }
    }
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Answers with the rows whose checks have passed by the time the checks finish or the wait runs out, whichever comes
 * first. A check still out keeps its row hidden and goes on in the background, so a later poll lists it.
 */
async function keepVisible<T extends { sessions: Checkable<ChannelFacts>[] }>(
  all: T[],
  userId: string,
  limit: number,
): Promise<{ kept: T[]; pending: number }> {
  let timer: NodeJS.Timeout | undefined;
  const waited = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, LIST_WAIT_MS);
  });
  try {
    await Promise.race([checkInOrder(all, userId, limit), waited]);
  } finally {
    clearTimeout(timer);
  }
  const answer = (place: CallPlace, channelType: string) => {
    const entry = visibility.get(visibilityKey(place, channelType, userId));
    if (entry?.failed) return false;
    return entry && Date.now() < entry.until ? entry.answer : undefined;
  };
  const kept: T[] = [];
  let pending = 0;
  for (const thread of all) {
    if (kept.length === limit) break;
    const answers = thread.sessions.map(({ row, place }) => ('dm' in place ? true : answer(place, row.channel_type)));
    const sessions = thread.sessions.filter((_, index) => answers[index] === true);
    if (sessions.length > 0) kept.push({ ...thread, sessions });
    else if (answers.includes(undefined)) pending += 1;
  }
  for (const { row } of kept.flatMap((thread) => thread.sessions))
    seenChannels.set(seenChannelKey(userId, row.platform_id), Date.now() + SEEN_CHANNEL_TTL_MS);
  return { kept, pending };
}

/**
 * Which of their wired channels each paired person may search: every wired channel, quiet ones too, checked on this
 * schedule and never because a search hit something, so a hit in a channel they cannot see starts nothing a miss
 * would not. A channel they join becomes searchable, and one they leave stops being, within one refresh.
 */
const CHANNEL_REFRESH_MS = 15 * 60_000;
/** A refresh that failed or fell behind must not keep a channel searchable after the person may have left it. */
const GRANT_TTL_MS = 2 * CHANNEL_REFRESH_MS;

interface SearchGrant {
  checkedAt: number;
  /** Each channel that passed, with the Discord threads in it this person may search. */
  channels: ReadonlyMap<string, readonly string[]>;
}

const searchable = new Map<string, SearchGrant>();
let refreshing: Promise<void> | null = null;

export function startChannelVisibilityRefresh(): Promise<void> {
  if (refreshing) return refreshing;
  refreshing = refreshDueChannels()
    .catch((err: unknown) => log.warn('Mobile: channel visibility refresh failed', { err }))
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

async function refreshDueChannels(): Promise<void> {
  const paired = new Set(
    (await getDb().all<{ user_id: string }>('SELECT DISTINCT user_id FROM mobile_devices')).map((row) => row.user_id),
  );
  for (const userId of searchable.keys()) if (!paired.has(userId)) searchable.delete(userId);
  const due = [...paired].filter((userId) => {
    const last = searchable.get(userId);
    return !last || Date.now() - last.checkedAt >= CHANNEL_REFRESH_MS;
  });
  if (due.length === 0) return;
  const checkedAt = Date.now();
  const reads: DiscordReads = new Map();
  const people = new Map<string, PersonCheck>();
  for (const userId of due) {
    try {
      people.set(userId, await checkWiredChannels(userId, reads));
    } catch (err) {
      log.warn('Mobile: channel visibility refresh failed for one person', { err });
    }
  }
  const threads = await searchableDiscordThreads(people, reads);
  for (const [userId, { visible }] of people)
    searchable.set(userId, {
      checkedAt,
      channels: new Map([...visible].map((platformId) => [platformId, threads.get(userId)?.get(platformId) ?? []])),
    });
}

type Reader = { place: CallPlace; channelType: string };

/** A channel and each sibling bot wired to it, any of which may check it. */
type PlaceCheck = { key: string; readers: Reader[] };

/**
 * In batches, sharing reads, through each sibling bot in turn until one passes the person. A place no bot passes stays
 * out of search until the next refresh. A check that fails is not an answer: it leaves the list's cache and the
 * channel picker as they were, and a place only failed checks reached is `unknown`.
 */
async function placesSeen(
  checks: PlaceCheck[],
  userId: string,
  reads: DiscordReads,
): Promise<{ seen: Set<string>; unknown: Set<string> }> {
  const seen = new Set<string>();
  const unknown = new Set<string>();
  for (let at = 0; at < checks.length; at += VISIBILITY_BATCH) {
    await Promise.all(
      checks.slice(at, at + VISIBILITY_BATCH).map(async ({ key, readers }) => {
        let answered = false;
        for (const { place, channelType } of readers) {
          let passed: boolean;
          try {
            passed = (await whoCanSee(place, channelType, [userId], reads)).has(rawUserId(userId));
          } catch (err) {
            log.warn('Mobile: visibility check failed', { channelType, err });
            continue;
          }
          answered = true;
          visibility.set(visibilityKey(place, channelType, userId), {
            until: Date.now() + VISIBILITY_TTL_MS,
            seen: Promise.resolve(passed),
            answer: passed,
            failed: false,
          });
          if (!passed) continue;
          seen.add(key);
          return;
        }
        if (!answered) unknown.add(key);
      }),
    );
  }
  return { seen, unknown };
}

interface DiscordThread {
  platformId: string;
  /** Each sibling bot with a usable session there, any of which may read the thread. */
  readers: Reader[];
}

interface PersonCheck {
  visible: Set<string>;
  discordThreads: Map<string, DiscordThread>;
}

/** One check per channel, through its sibling bots in a fixed order; an answer is shared with the list's cache. */
async function checkWiredChannels(userId: string, reads: DiscordReads): Promise<PersonCheck> {
  const wirings = await callableWirings(userId);
  const channelChecks = new Map<string, PlaceCheck>();
  for (const wiring of wirings) {
    const place = ownPlace(wiring, null, userId);
    if (!place) continue;
    const check = channelChecks.get(wiring.platform_id) ?? { key: wiring.platform_id, readers: [] };
    channelChecks.set(wiring.platform_id, check);
    if (!check.readers.some((reader) => reader.channelType === wiring.channel_type))
      check.readers.push({ place, channelType: wiring.channel_type });
  }
  for (const check of channelChecks.values()) check.readers.sort((a, b) => a.channelType.localeCompare(b.channelType));
  const { seen: visible, unknown } = await placesSeen([...channelChecks.values()], userId, reads);
  for (const platformId of channelChecks.keys()) {
    if (visible.has(platformId)) seenChannels.set(seenChannelKey(userId, platformId), Date.now() + SEEN_CHANNEL_TTL_MS);
    else if (!unknown.has(platformId)) seenChannels.delete(seenChannelKey(userId, platformId));
  }
  const inVisibleChannels = wirings.filter(
    (wiring) =>
      visible.has(wiring.platform_id) &&
      channelChecks.get(wiring.platform_id)?.readers[0]?.place.platform === 'discord',
  );
  return { visible, discordThreads: await discordThreadsListable(inVisibleChannels, userId) };
}

/** The Discord threads this person's list could show from these wirings, by the list's own rule for a search. */
async function discordThreadsListable(wirings: Wiring[], userId: string): Promise<Map<string, DiscordThread>> {
  const threads = new Map<string, DiscordThread>();
  if (wirings.length === 0) return threads;
  const since = new Date(Date.now() - SEARCH.windowMs).toISOString();
  const anchors = await taskAnchorsIn([...new Set(wirings.map((wiring) => wiring.platform_id))], since);
  const rows = await threadRows(wirings, since, null, new Set(occupiedCallSessions()), NO_DMS, anchors);
  for (const { sessions } of poolByThread(rows, wirings, userId, NO_DMS))
    for (const { row, place } of sessions) {
      if ('dm' in place || place.platform !== 'discord' || !place.threadId) continue;
      const thread = threads.get(row.thread_ref) ?? { platformId: row.platform_id, readers: [] };
      threads.set(row.thread_ref, thread);
      if (!thread.readers.some((reader) => reader.channelType === row.channel_type))
        thread.readers.push({ place, channelType: row.channel_type });
    }
  for (const thread of threads.values()) thread.readers.sort((a, b) => a.channelType.localeCompare(b.channelType));
  return threads;
}

/**
 * Kept for the life of the process once a bot has read it, because a Discord thread's kind never changes. A thread no
 * bot can read is asked about again at the next refresh.
 */
const threadKinds = new Map<string, 'public' | 'private'>();

async function threadKind(threadRef: string, thread: DiscordThread, reads: DiscordReads) {
  const known = threadKinds.get(threadRef);
  if (known) return known;
  for (const { place, channelType } of thread.readers) {
    if (place.platform !== 'discord' || !place.threadId) continue;
    try {
      const kind = await discordThreadKind(place.threadId, channelType, reads);
      if (!kind) continue;
      threadKinds.set(threadRef, kind);
      return kind;
    } catch (err) {
      log.warn('Mobile: thread kind check failed', { channelType, err });
    }
  }
  return undefined;
}

/**
 * Which Discord threads each person may search, per channel that passed. A public thread shows to everyone who can
 * see its channel; a private thread hides from them, so each person due in this refresh needs a membership check,
 * through each sibling bot in turn until one passes them. A thread whose kind no bot can read is left out.
 */
async function searchableDiscordThreads(
  people: Map<string, PersonCheck>,
  reads: DiscordReads,
): Promise<Map<string, Map<string, string[]>>> {
  const threads = new Map<string, DiscordThread & { people: Set<string> }>();
  for (const [userId, { discordThreads }] of people)
    for (const [threadRef, thread] of discordThreads) {
      const entry = threads.get(threadRef) ?? { ...thread, readers: [...thread.readers], people: new Set<string>() };
      threads.set(threadRef, entry);
      entry.people.add(userId);
      for (const reader of thread.readers)
        if (!entry.readers.some((known) => known.channelType === reader.channelType)) entry.readers.push(reader);
    }
  const granted = new Map<string, Map<string, string[]>>();
  const grant = (userId: string, platformId: string, threadRef: string) => {
    const channels = granted.get(userId) ?? new Map<string, string[]>();
    granted.set(userId, channels);
    channels.set(platformId, [...(channels.get(platformId) ?? []), threadRef]);
  };
  const entries = [...threads];
  for (let at = 0; at < entries.length; at += VISIBILITY_BATCH) {
    await Promise.all(
      entries.slice(at, at + VISIBILITY_BATCH).map(async ([threadRef, thread]) => {
        const kind = await threadKind(threadRef, thread, reads);
        if (kind === 'public') for (const userId of thread.people) grant(userId, thread.platformId, threadRef);
        if (kind !== 'private') return;
        // One person at a time, so a check that fails for one person leaves the others: `reads` still shares the
        // guild, channel and thread reads, so a bot that cannot read those moves everyone on to the next sibling.
        for (const userId of thread.people)
          for (const { place, channelType } of thread.readers) {
            try {
              if (!(await whoCanSee(place, channelType, [userId], reads)).has(rawUserId(userId))) continue;
              grant(userId, thread.platformId, threadRef);
              break;
            } catch (err) {
              log.warn('Mobile: visibility check failed', { channelType, err });
            }
          }
      }),
    );
  }
  return granted;
}

const firstAsked = new Map<string, string>();
const noWordsUntil = new Map<string, number>();

function humanText(content: string): string {
  const { text } = JSON.parse(content) as { text?: unknown };
  return typeof text === 'string' ? text.replace(MENTION_RE, ' ').replace(/\s+/g, ' ').trim() : '';
}

/** A session with no words from a person yet is read again later, so it picks up its first one. */
async function earliestHumanText(row: ThreadRow): Promise<string | null> {
  const cached = firstAsked.get(row.id);
  if (cached !== undefined) return cached;
  if (Date.now() < (noWordsUntil.get(row.id) ?? 0)) return null;
  const chats = await withExistingMailboxSession(row.agent_group_id, row.id, (mailbox) =>
    mailbox.getEarliestInboundChats(TITLE_SCAN_ROWS),
  ).catch((err: unknown) => {
    log.warn('Mobile: could not read a thread title', { sessionId: row.id, err });
    return undefined;
  });
  for (const chat of chats ?? []) {
    const text = chat.content && isHumanChatSdkContent(chat.kind, chat.content) ? humanText(chat.content) : '';
    if (text && !text.startsWith(THREAD_CONTEXT_PREFIX)) {
      firstAsked.set(row.id, text);
      return text;
    }
  }
  if (chats) noWordsUntil.set(row.id, Date.now() + NO_WORDS_TTL_MS);
  return null;
}

async function firstHumanWords(sessions: ListableSession[]): Promise<string | null> {
  for (const { row } of sessions) {
    const text = await earliestHumanText(row);
    if (text) return text;
  }
  return null;
}

function starterLines(starterId: string | null): string[] {
  const text = starterId ? threadMessageById(starterId)?.text : undefined;
  return (text ?? '')
    .split('\n')
    .map((line) =>
      line
        .replace(/\*\*|__/g, '')
        .replace(/^[#>\s]+/, '')
        .trim(),
    )
    .filter(Boolean);
}

const starterLine = (row: ThreadRow) => (row.anchor ? (starterLines(row.starter_id)[0] ?? null) : null);

type AgentNames = (agent: AgentInChannel) => Promise<string>;

/** Shared across one list: a name is a file read and a query, and sibling threads repeat the same few agents. */
function agentNames(): AgentNames {
  const names = new Map<string, Promise<string>>();
  return (agent) => {
    const key = agentKey(agent);
    const name =
      names.get(key) ??
      getAgentGroup(agent.agent_group_id).then((group) =>
        group ? spokenName(group, agent.messaging_group_id) : 'your agent',
      );
    names.set(key, name);
    return name;
  };
}

/** Null until the bot's adapter has connected and read its profile, or when the bot has no picture of its own. */
async function botAvatar(channelType: string): Promise<string | null> {
  if (!isDiscordChannelType(channelType)) return getKnownSlackBots().get(channelType)?.imageUrl ?? null;
  const { getKnownDiscordBots } = await import('../../channels/discord.js');
  return getKnownDiscordBots().get(channelType)?.avatarUrl ?? null;
}

const agentKey = (agent: AgentInChannel) => JSON.stringify([agent.agent_group_id, agent.messaging_group_id]);

const capped = (text: string, chars: number) => [...text].slice(0, chars).join('').trimEnd();

const dmWithOf = (agentNames: string[]) => [...agentNames].sort((a, b) => a.localeCompare(b)).join(', ');

export const opaqueId = (value: string) =>
  createHash('sha256').update(value).digest('base64url').slice(0, THREAD_KEY_CHARS);

const opaqueKey = (workgroupId: string, ref: string) => opaqueId(JSON.stringify([workgroupId, ref]));

async function summarize(
  { rows, sessions }: PooledThread,
  nameOf: AgentNames,
  channelNameOf: ChannelNamer,
): Promise<Thread> {
  const [{ workgroup_id, workgroup_name, platform_id, thread_ref, thread_title, thread_active }] = rows;
  const [{ place }] = sessions;
  const newestPerAgent = new Map<string, ThreadRow>();
  for (const { row } of sessions)
    if (!newestPerAgent.has(row.agent_group_id)) newestPerAgent.set(row.agent_group_id, row);
  const agents = await Promise.all(
    [...newestPerAgent.values()].map(async (row) => ({
      sessionId: row.anchor ? taskCallId(row.id, row.thread_ref) : row.id,
      agentGroupId: row.agent_group_id,
      name: await nameOf(row),
      avatarUrl: await botAvatar(row.channel_type),
    })),
  );
  agents.sort((a, b) => a.name.localeCompare(b.name));
  // A DM's messaging group is named for the person in it, which is no channel.
  const dmWith = 'dm' in place ? dmWithOf(agents.map((agent) => agent.name)) : null;
  const named = rows.find((row) => row.channel_name);
  const channelName = dmWith === null && named ? channelNameOf(named) : null;
  const started = sessions.find(({ row }) => row.anchor !== null)?.row;
  const title =
    (started && (thread_title?.trim() || starterLine(started))) ||
    shownThreadTitle(thread_title, rows, (row) => parseUtcTimestampMs(row.last_active) ?? 0) ||
    (await firstHumanWords(sessions.filter(({ row }) => row.anchor === null))) ||
    channelName ||
    (dmWith === null ? 'Thread' : `DM with ${dmWith}`);
  const inRoom = sessions.flatMap(({ row }) => {
    const people = groupCallPeople(row.id);
    return people?.length ? [{ row, people }] : [];
  })[0];
  const dmCalls = 'dm' in place ? await callableInDm(agents, place.userId) : [];
  return {
    threadKey: opaqueKey(workgroup_id, thread_ref),
    workgroupId: workgroup_id,
    workgroupName: workgroup_name || workgroup_id,
    platform: place.platform,
    channelKey: opaqueKey(workgroup_id, platform_id),
    channelName,
    title: capped(title, TITLE_MAX_CHARS),
    lastActiveAt: thread_active,
    agents: dmWith === null ? agents : [],
    ...(dmWith === null ? {} : { dmWith, dmCalls }),
    // An app build without `dmCalls` would offer Join on the group route, which refuses a DM.
    call:
      inRoom && dmWith === null
        ? {
            sessionId: inRoom.row.id,
            agentName: await nameOf(inRoom.row),
            avatarUrl: await botAvatar(inRoom.row.channel_type),
            people: inRoom.people,
          }
        : null,
  };
}

async function callableInDm<A extends { agentGroupId: string }>(agents: A[], userId: string): Promise<A[]> {
  const enabled = groupCallsConfigured() ? agents.filter((agent) => voiceCallsEnabledFor(agent.agentGroupId)) : [];
  if (enabled.length === 0) return [];
  return withCentralSync(() => enabled.filter((agent) => mayCall(userId, agent.agentGroupId)), 'mobile DM calls');
}

/** The wirings this person could call through right now, as far as anything short of the platform can tell. */
async function callableWirings(userId: string): Promise<Wiring[]> {
  if (!groupCallsConfigured()) return [];
  const wirings = (await getDb().all<Wiring>(WIRINGS_SQL)).filter(
    (wiring) => voiceCallsEnabledFor(wiring.agent_group_id) && ownPlace(wiring, null, userId),
  );
  const groups = [...new Set(wirings.map((wiring) => wiring.agent_group_id))];
  const identities = await identitiesOf(userId);
  const allowed = await withCentralSync(
    () => new Set(groups.filter((group) => identities.some((id) => mayCall(id, group)))),
    'mobile thread list access',
  );
  return wirings.filter((wiring) => allowed.has(wiring.agent_group_id));
}

function workgroupsOf(wirings: Wiring[]): ThreadList['workgroups'] {
  const names = new Map(wirings.map((w) => [w.workgroup_id, w.workgroup_name || w.workgroup_id]));
  return [...names]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/**
 * Only channels a visibility check has passed for this person, so a filter never names a private channel they are not
 * in: a member of an agent group need not be in every channel it is wired to. It reads memory alone, so a channel with
 * nothing on the list appears once the New call picker or a search has checked it. Their own DMs need no check.
 */
async function channelsOf(callable: Wiring[], dms: Wiring[], userId: string, nameOf: AgentNames): Promise<Channel[]> {
  const platform = userPlatform(userId);
  if (!platform || !CHANNEL_FILTER_PLATFORMS.has(platform)) return [];
  const channels = new Map<string, Channel>();
  const channelNameOf = channelNamer(userId);
  for (const wiring of callable) {
    const { workgroup_id, platform_id } = wiring;
    const id = opaqueKey(workgroup_id, platform_id);
    if (hasSeenChannel(userId, platform_id) && !channels.get(id)?.name)
      channels.set(id, { id, workgroupId: workgroup_id, platform, name: channelNameOf(wiring) });
  }
  const dmAgents = new Map<string, { workgroupId: string; names: string[] }>();
  for (const wiring of dms) {
    const id = opaqueKey(wiring.workgroup_id, wiring.platform_id);
    const dm = dmAgents.get(id) ?? { workgroupId: wiring.workgroup_id, names: [] };
    dmAgents.set(id, dm);
    dm.names.push(await nameOf(wiring));
  }
  for (const [id, { workgroupId, names }] of dmAgents)
    channels.set(id, { id, workgroupId, platform, name: `DM with ${dmWithOf(names)}` });
  return [...channels.values()].sort((a, b) => (a.name ?? '').localeCompare(b.name ?? '') || a.id.localeCompare(b.id));
}

/** Goes by the name the app shows, which lives in container config and bot profiles, not in a column a query can read. */
async function agentsNamed(wirings: Wiring[], text: string, nameOf: AgentNames): Promise<Wiring[]> {
  const wanted = text.toLowerCase();
  const names = await Promise.all(wirings.map(nameOf));
  return wirings.filter((_, index) => names[index].toLowerCase().includes(wanted));
}

/**
 * Every session of each thread with a live session in the window, closed ones included because any of them can hold
 * its title, and idle ones because a quiet sibling stays on a thread the other one keeps busy. Finding the threads
 * first means a poll only ever groups recent sessions: `sessions` has no index on `thread_id` alone, so the fixed join
 * order reaches each thread's rows through `idx_sessions_lookup`, one messaging group per sibling bot. Opening a call
 * writes nothing to `last_active`, so a room with people in it counts as recent by itself.
 */
function threadRows(
  wirings: Wiring[],
  since: string,
  search: { text: string; agents: Wiring[]; inMessages: ThreadHit[] } | null,
  onCall: Set<string>,
  dms: OwnDms,
  anchors: TaskAnchor[],
): Promise<ThreadRow[]> {
  const anchored = anchorsTable(anchors);
  const platformIds = [...new Set(wirings.map((wiring) => wiring.platform_id))];
  const dmIds = [...dms.keys()];
  const dmPlatformIds = [...new Set(wirings.filter((w) => dms.has(w.messaging_group_id)).map((w) => w.platform_id))];
  // Another group can carry a DM's channel id, as a cloned one does, so a DM's thread is built from its own group only.
  const ownDmGroupsOnly = dmPlatformIds.length
    ? `AND (mg.id IN (${dmIds.map(() => '?').join(', ')})
            OR mg.platform_id NOT IN (${dmPlatformIds.map(() => '?').join(', ')}))`
    : '';
  const ownDmGroupsOnlyArgs = dmPlatformIds.length ? [...dmIds, ...dmPlatformIds] : [];
  const occupied = onCall.size > 0 ? `OR s.id IN (${[...onCall].map(() => '?').join(', ')})` : '';
  const like = search && `%${search.text.replace(LIKE_SPECIAL_RE, '\\$&')}%`;
  const namedAgents = search?.agents.length
    ? `OR (status = 'active' AND archived_at IS NULL
           AND (agent_group_id, messaging_group_id) IN (VALUES ${search.agents.map(() => '(?, ?)').join(', ')}))`
    : '';
  const inMessages = search?.inMessages.length
    ? `OR (workgroup_id, thread_ref) IN (VALUES ${search.inMessages.map(() => '(?, ?)').join(', ')})`
    : '';
  const matches = like
    ? `JOIN (
         SELECT workgroup_id, thread_ref,
                COALESCE(MAX(title LIKE ? ESCAPE '\\' OR thread_title LIKE ? ESCAPE '\\'
                    OR '#' || ltrim(channel_name, '#') LIKE ? ESCAPE '\\' ${namedAgents}), 0) AS named
           FROM pool
          GROUP BY workgroup_id, thread_ref
         HAVING named = 1 ${inMessages}
       ) USING (workgroup_id, thread_ref)`
    : '';
  return getDb().all<ThreadRow>(
    `WITH ${anchored.sql}, recent AS (
       SELECT ${SCOPE_ID_SQL} AS workgroup_id, mg.platform_id, s.thread_id,
              MAX(s.last_active) AS thread_active
         FROM sessions s
         JOIN messaging_groups mg ON mg.id = s.messaging_group_id
         JOIN agent_groups ag ON ag.id = s.agent_group_id
        WHERE s.status = 'active' AND s.archived_at IS NULL
          AND (datetime(s.last_active) >= datetime(?) ${occupied})
          AND mg.platform_id IN (${platformIds.map(() => '?').join(', ')})
          ${ownDmGroupsOnly}
        GROUP BY 1, 2, 3
     ), pool AS (
       SELECT s.id, s.agent_group_id, s.messaging_group_id, s.thread_id, s.status, s.archived_at, s.last_active,
              s.title, s.title_generated_at, mg.channel_type, mg.platform_id, mg.name AS channel_name,
              recent.workgroup_id, recent.thread_active,
              COALESCE(s.thread_id, mg.platform_id) AS thread_ref,
              t.title AS thread_title, ${SCOPE_NAME_SQL} AS scope_name, NULL AS anchor, NULL AS starter_id
         FROM recent
        CROSS JOIN messaging_groups mg ON mg.platform_id = recent.platform_id ${ownDmGroupsOnly}
        CROSS JOIN sessions s ON s.messaging_group_id = mg.id AND s.thread_id IS recent.thread_id
         JOIN agent_groups ag
           ON ag.id = s.agent_group_id AND ${SCOPE_ID_SQL} = recent.workgroup_id
         LEFT JOIN thread_titles t ON t.thread_id = s.thread_id
        UNION ALL
       SELECT s.id, s.agent_group_id, mg.id, ${ANCHOR_THREAD_SQL}, s.status, s.archived_at, a.created_at,
              NULL, NULL, mg.channel_type, mg.platform_id, mg.name,
              ${SCOPE_ID_SQL}, a.created_at, ${ANCHOR_THREAD_SQL}, t.title, ${SCOPE_NAME_SQL}, a.thread_platform_id,
              a.starter_id
              ${ANCHORED_TASKS_SQL}
         LEFT JOIN thread_titles t ON t.thread_id = ${ANCHOR_THREAD_SQL}
     )
     SELECT pool.*, COALESCE(w.display_name, pool.scope_name) AS workgroup_name
       FROM pool
       ${matches}
       LEFT JOIN workgroups w ON w.id = pool.workgroup_id
      ORDER BY ${like ? 'named DESC,' : ''} thread_active DESC, pool.last_active DESC`,
    ...anchored.args,
    since,
    ...onCall,
    ...platformIds,
    ...ownDmGroupsOnlyArgs,
    ...ownDmGroupsOnlyArgs,
    ...(like ? [like, like, like] : []),
    ...(search?.agents ?? []).flatMap((agent) => [agent.agent_group_id, agent.messaging_group_id]),
    ...(search?.inMessages ?? []).flatMap((hit) => [hit.workgroupId, hit.threadRef]),
  );
}

function poolByThread(rows: ThreadRow[], wirings: Wiring[], userId: string, dms: OwnDms): PooledThread[] {
  const wired = new Set(wirings.map(agentKey));
  const threads = new Map<string, PooledThread>();
  for (const row of rows) {
    const key = JSON.stringify([row.workgroup_id, row.thread_ref]);
    const thread = threads.get(key) ?? { rows: [], sessions: [] };
    threads.set(key, thread);
    thread.rows.push(row);
    const place = wired.has(agentKey(row)) ? listedPlace(row, userId, dms) : null;
    if (place) thread.sessions.push({ row, place });
  }
  return [...threads.values()].filter((thread) => thread.sessions.length > 0);
}

interface ListProgress {
  stage: string;
  enteredAt: number;
  msByStage: Record<string, number>;
}

function enterStage(progress: ListProgress, stage: string): void {
  const now = Date.now();
  progress.msByStage[progress.stage] = now - progress.enteredAt;
  progress.stage = stage;
  progress.enteredAt = now;
}

/** SQLite reads hold the event loop, so the timer only catches a wait on the network and the timings catch the rest. */
export async function listThreads(userId: string, filters: ThreadFilters, mayWalk: () => boolean): Promise<ThreadList> {
  const startedAt = Date.now();
  const platform = userPlatform(userId);
  const progress: ListProgress = { stage: 'access', enteredAt: startedAt, msByStage: {} };
  const slow = setTimeout(
    () => log.warn('Mobile: thread list is slow', { stage: progress.stage, platform }),
    SLOW_LIST_MS,
  );
  try {
    return await buildList(userId, filters, mayWalk, progress);
  } finally {
    clearTimeout(slow);
    enterStage(progress, 'done');
    const ms = Date.now() - startedAt;
    if (ms >= SLOW_LIST_MS) log.warn('Mobile: thread list took too long', { ms, stages: progress.msByStage, platform });
  }
}

function searchGrant(userId: string): SearchGrant['channels'] | undefined {
  const grant = searchable.get(userId);
  return grant && Date.now() - grant.checkedAt < GRANT_TTL_MS ? grant.channels : undefined;
}

/**
 * Workgroups are tenants. A search reads the workgroup the chips select, or every workgroup this person can call in
 * under All, and inside each only the channels their last scheduled check passed. It never reads another tenant's
 * rows, so neither its cost nor what it starts depends on them, and with nothing to search there is no walk at all.
 */
async function findInMessagesOf(
  userId: string,
  wirings: Wiring[],
  dms: OwnDms,
  text: string,
  since: string,
  mayWalk: () => boolean,
): Promise<TextMatches> {
  if (!archiveSearchAvailable()) return { threads: [], cutShort: true };
  const match = archiveTextMatch(text);
  if (!match) return NO_TEXT_MATCHES;
  const granted = searchGrant(userId);
  // The person's own DM waits for no scheduled check: the record that proves it theirs is read with this list.
  const unchecked = !granted && wirings.some((wiring) => !dms.has(wiring.messaging_group_id));
  const scopes = wirings.flatMap((wiring) => {
    const threadIds = dms.has(wiring.messaging_group_id) ? [] : granted?.get(wiring.platform_id);
    return threadIds
      ? [
          {
            tenantKey: archiveTenantKey(wiring.tenant_workgroup_id, wiring.agent_group_id),
            workgroupId: wiring.workgroup_id,
            platformId: wiring.platform_id,
            threadIds: [...threadIds],
          },
        ]
      : [];
  });
  if (scopes.length === 0) return unchecked ? { threads: [], cutShort: true } : NO_TEXT_MATCHES;
  if (!mayWalk()) return { threads: [], cutShort: true };
  const found = await findInMessages({
    archivePath: ARCHIVE_PATH,
    match,
    since,
    scopes,
    maxThreads: TEXT_MATCHED_THREADS,
  });
  return unchecked ? { ...found, cutShort: true } : found;
}

/**
 * A task's anchor post is archived at its channel's top level, where the archive's search finds it, so the thread it
 * started is matched here by those words. Like that search, only in a channel the person's last scheduled check passed
 * (a hit starts a visibility check a miss would not) and only a post its index files under the wiring's tenant.
 */
function anchorPostsSaying(
  wirings: Wiring[],
  text: string,
  anchors: TaskAnchor[],
  granted: SearchGrant['channels'] | undefined,
): ThreadHit[] {
  const wanted = text.toLowerCase();
  const candidates = anchors
    .filter((anchor) => granted?.has(anchor.platformId))
    .flatMap(({ agentGroupId, channelType, platformId, threadPlatformId, starterId }) => {
      const wiring = wirings.find(
        (w) => w.agent_group_id === agentGroupId && w.channel_type === channelType && w.platform_id === platformId,
      );
      if (!wiring || !starterId) return [];
      const tenantKey = archiveTenantKey(wiring.tenant_workgroup_id, wiring.agent_group_id);
      const threadRef = anchorThreadId({ platformId, threadPlatformId });
      return [{ starterId, tenantKey, hit: { workgroupId: wiring.workgroup_id, threadRef } }];
    })
    .slice(0, TEXT_MATCHED_THREADS);
  const byTenant = new Map<string, string[]>();
  for (const { starterId, tenantKey } of candidates)
    byTenant.set(tenantKey, [...(byTenant.get(tenantKey) ?? []), starterId]);
  const placed = new Set([...byTenant].flatMap(([tenantKey, ids]) => [...rowsInTenant(ids, tenantKey)]));
  return candidates.flatMap(({ starterId, hit }) => {
    if (!placed.has(starterId)) return [];
    const lines = starterLines(starterId);
    const said = [lines.join('\n'), lines.join(' ')].map((words) => words.toLowerCase());
    return said.some((words) => words.includes(wanted)) ? [hit] : [];
  });
}

async function buildList(
  userId: string,
  filters: ThreadFilters,
  mayWalk: () => boolean,
  progress: ListProgress,
): Promise<ThreadList> {
  const callable = await callableWirings(userId);
  const dms = await ownDms(userId);
  const ownDmWirings = await dmWirings(dms);
  const allWirings = [...callable, ...ownDmWirings];
  const nameOf = agentNames();
  const channels = () => channelsOf(callable, ownDmWirings, userId, nameOf);
  const workgroups = workgroupsOf(allWirings);
  const wirings = allWirings.filter(
    ({ workgroup_id, platform_id }) =>
      (!filters.workgroup || workgroup_id === filters.workgroup) &&
      (!filters.channel || opaqueKey(workgroup_id, platform_id) === filters.channel),
  );
  if (wirings.length === 0) return { threads: [], workgroups, channels: await channels() };

  const text = capped(filters.q?.trim() ?? '', QUERY_MAX_CHARS);
  const { windowMs, limit } = text ? SEARCH : BROWSE;
  const since = new Date(Date.now() - windowMs).toISOString();
  if (text) enterStage(progress, 'text');
  const { threads: inArchive, cutShort } = text
    ? await findInMessagesOf(userId, wirings, dms, text, since, mayWalk)
    : NO_TEXT_MATCHES;
  const anchors = await taskAnchorsIn([...new Set(wirings.map((wiring) => wiring.platform_id))], since);
  const inMessages = text
    ? [...inArchive, ...anchorPostsSaying(wirings, text, anchors, searchGrant(userId))]
    : inArchive;
  const search = text ? { text, agents: await agentsNamed(wirings, text, nameOf), inMessages } : null;
  const onCall = new Set(occupiedCallSessions());
  enterStage(progress, 'rows');
  const rows = await threadRows(wirings, since, search, onCall, dms, anchors);
  const live = (thread: PooledThread) => thread.rows.some((row) => onCall.has(row.id));
  const pooled = poolByThread(rows, wirings, userId, dms).sort((a, b) => Number(live(b)) - Number(live(a)));
  enterStage(progress, 'visibility');
  const { kept: visible, pending } = await keepVisible(pooled, userId, limit);
  enterStage(progress, 'summaries');
  const channelNameOf = channelNamer(userId);
  return {
    threads: await Promise.all(visible.map((thread) => summarize(thread, nameOf, channelNameOf))),
    workgroups,
    channels: await channels(),
    ...(cutShort ? { textCutShort: true } : {}),
    ...(pending > 0 ? { pending } : {}),
  };
}

async function lastActivePerWiring(wirings: Wiring[]): Promise<Map<string, string>> {
  const channels = [...new Set(wirings.map((wiring) => wiring.messaging_group_id))];
  const rows = await getDb().all<AgentInChannel & { last_active: string }>(
    `SELECT agent_group_id, messaging_group_id, MAX(last_active) AS last_active
       FROM sessions
      WHERE last_active IS NOT NULL AND messaging_group_id IN (${channels.map(() => '?').join(', ')})
      GROUP BY agent_group_id, messaging_group_id`,
    ...channels,
  );
  return new Map(rows.map((row) => [agentKey(row), row.last_active]));
}

/**
 * Whether a typed reply in a new thread here reaches that thread's session, by the router's rule for this wiring.
 * Otherwise the reply goes to a session the call is not in.
 */
function repliesReachThread(wiring: ThreadPolicyFacts): boolean {
  const threadsEnabled = resolveThreadPolicy(
    wiring.threads ?? null,
    getChannelDefaults(wiring.instance ?? wiring.channel_type, wiring.channel_type),
    wiring.is_group === 1,
    getChannelAdapter(wiring.instance ?? wiring.channel_type)?.supportsThreads === true,
  );
  if (!threadsEnabled || wiring.session_mode === 'agent-shared') return false;
  return wiring.is_group !== 0 || wiring.session_mode === 'per-thread';
}

export async function listPlaces(userId: string): Promise<{ places: Place[] }> {
  const wirings = (await callableWirings(userId)).filter(repliesReachThread);
  if (wirings.length === 0) return { places: [] };
  const lastActive = await lastActivePerWiring(wirings);
  const activityMs = (wiring: Wiring) => parseUtcTimestampMs(lastActive.get(agentKey(wiring))) ?? 0;
  const ranked = [...wirings]
    .sort((a, b) => activityMs(b) - activityMs(a))
    .flatMap((row) => {
      const place = ownPlace(row, null, userId);
      return place ? [{ sessions: [{ row, place }] }] : [];
    });
  const { kept: visible } = await keepVisible(ranked, userId, PLACES_LIMIT);
  const nameOf = agentNames();
  const channelNameOf = channelNamer(userId);
  return {
    places: await Promise.all(
      visible.map(async ({ sessions: [{ row, place }] }) => ({
        channelKey: opaqueKey(row.workgroup_id, row.platform_id),
        agentGroupId: row.agent_group_id,
        agentName: await nameOf(row),
        avatarUrl: await botAvatar(row.channel_type),
        messagingGroupId: row.messaging_group_id,
        platform: place.platform,
        channelName: channelNameOf(row),
        workgroupName: row.workgroup_name || row.workgroup_id,
        lastActiveAt: lastActive.get(agentKey(row)) ?? null,
      })),
    ),
  };
}

/** The id this person may reach this agent as here, once `seen` says it can see the place. */
async function callerIn(
  mg: MessagingGroup,
  agentGroupId: string,
  place: CallPlace,
  pairedId: string,
  seen: Seen,
): Promise<string | null> {
  if (!(await getMessagingGroupAgentByPair(mg.id, agentGroupId))) return null;
  const identities = await identitiesOf(pairedId);
  const here = identities.filter((id) => id.startsWith(`${mg.channel_type}:`));
  const userId = await withCentralSync(
    () => [...here, ...identities].find((id) => mayCall(id, agentGroupId)),
    'mobile thread access',
  );
  if (!userId) return null;
  return (await seen(place, mg.channel_type, userId)) ? userId : null;
}

interface UsableSession {
  sessionId: string;
  agentGroupId: string;
  /** The id a message typed in this channel would carry, if that one has access. */
  userId: string;
}

/** A call in a task's thread, which a task session cannot hold: it goes to the session a reply there would wake. */
export interface TaskThreadCall {
  agentGroupId: string;
  userId: string;
  mg: MessagingGroup;
  threadId: string;
}

async function boundTo(
  session: Session,
  threadId: string | null,
): Promise<{ mg: MessagingGroup; facts: SessionFacts } | null> {
  if (session.messaging_group_id) {
    const mg = await getMessagingGroup(session.messaging_group_id);
    return mg ? { mg, facts: session } : null;
  }
  if (!threadId || !isTaskThread(session.thread_id)) return null;
  const anchor = (await taskAnchorsOf(session.id)).find((a) => anchorThreadId(a) === threadId);
  const mg =
    anchor &&
    (await getDb().get<MessagingGroup>(
      `SELECT mg.* FROM messaging_groups mg
         JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id AND mga.agent_group_id = ?
        WHERE mg.channel_type = ? AND mg.platform_id = ?`,
      session.agent_group_id,
      anchor.channelType,
      anchor.platformId,
    ));
  return mg ? { mg, facts: { ...session, thread_id: threadId } } : null;
}

async function usableBound(
  sessionId: string,
  pairedId: string,
  seen: Seen,
  threadId: string | null,
): Promise<{ usable: UsableSession; mg: MessagingGroup } | null> {
  const session = await getSession(sessionId);
  const bound = session ? await boundTo(session, threadId) : null;
  const place = bound ? usablePlace(bound.facts, bound.mg, pairedId) : null;
  if (!session || !bound || !place) return null;
  const agentGroupId = session.agent_group_id;
  const userId = await callerIn(bound.mg, agentGroupId, place, pairedId, seen);
  return userId ? { usable: { sessionId, agentGroupId, userId }, mg: bound.mg } : null;
}

/**
 * Null unless this person can use the session right now, asked of the platform. `userId` is who they join as. A list
 * row offers a task's thread by its session and anchor, since one task session posts many threads.
 */
export async function threadForCall(id: string, pairedId: string): Promise<UsableSession | TaskThreadCall | null> {
  const [sessionId, encoded, ...rest] = id.split(TASK_CALL_SEPARATOR);
  if (encoded === undefined) return (await usableBound(sessionId, pairedId, seenNow, null))?.usable ?? null;
  const threadId = Buffer.from(encoded, 'base64url').toString();
  const anchored = rest.length === 0 && (await taskAnchorsOf(sessionId)).some((a) => anchorThreadId(a) === threadId);
  if (!anchored) return null;
  const bound = await usableBound(sessionId, pairedId, seenNow, threadId);
  return bound && { agentGroupId: bound.usable.agentGroupId, userId: bound.usable.userId, mg: bound.mg, threadId };
}

export async function dmForCall(
  sessionId: string,
  pairedId: string,
): Promise<{ sessionId: string; agentGroupId: string; userId: string } | null> {
  const session = await getSession(sessionId);
  if (!session?.messaging_group_id || !usableSession(session)) return null;
  const dm = (await ownDms(pairedId)).get(session.messaging_group_id);
  if (!dm || !(await getMessagingGroupAgentByPair(session.messaging_group_id, session.agent_group_id))) return null;
  return { sessionId, agentGroupId: session.agent_group_id, userId: dm.userId };
}

/**
 * As `threadForCall`, for reading or replying, which may go by the list's own fresh answer. A task session is read in
 * the thread its anchor started, which `threadId` names.
 */
export async function threadForReply(
  sessionId: string,
  pairedId: string,
  reads: DiscordReads,
  threadId: string | null = null,
): Promise<UsableSession | null> {
  return (await usableBound(sessionId, pairedId, seenRecently(reads), threadId))?.usable ?? null;
}

export interface ThreadToRead {
  platformId: string;
  threadId: string | null;
  /**
   * Every agent this person can call there, or every one in their own DM, each with its session and the channel type
   * its copies are archived under.
   */
  agents: {
    sessionId: string;
    agentGroupId: string;
    channelType: string;
    name: string;
  }[];
  /** The person's own DM, where a task's post stays in the conversation. */
  dm: boolean;
  /** The post a task's thread grew from, which delivery archived at the channel's top level. */
  starter: { id: string; agentGroupId: string; sentAt: string } | null;
  /** The archive ids of the channel's top-level posts that open listed task threads, which show there instead. */
  taskThreadStarters: string[];
}

interface KeyedSession extends AgentInChannel, SessionFacts, ChannelFacts {
  id: string;
  workgroup_id: string;
  anchor: string | null;
  starter_id: string | null;
}

/**
 * The thread behind a list row's key, or null unless the person can read it now: their own DM, or a thread where a
 * reply would be accepted. Each agent there is tried as `threadForReply` tries it, freshest first, until one passes. One
 * that passes proves the person can see the thread, so the agents it reads from need no check of their own.
 */
export async function threadToRead(
  threadKey: string,
  pairedId: string,
  reads: DiscordReads = new Map(),
): Promise<ThreadToRead | null> {
  const dms = await ownDms(pairedId);
  const wirings = [...(await callableWirings(pairedId)), ...(await dmWirings(dms))];
  if (wirings.length === 0) return null;
  const wired = new Set(wirings.map(agentKey));
  const channels = [...new Set(wirings.map((wiring) => wiring.messaging_group_id))];
  const inChannels = channels.map(() => '?').join(', ');
  const taskAnchors = await taskAnchorsIn(
    [...new Set(wirings.map((wiring) => wiring.platform_id))],
    new Date(Date.now() - SEARCH.windowMs).toISOString(),
  );
  const anchors = anchorsTable(taskAnchors);
  const sessions = await getDb().all<KeyedSession>(
    `WITH ${anchors.sql}
     SELECT s.id AS id, s.agent_group_id, s.messaging_group_id, s.thread_id, s.status, s.archived_at,
            mg.channel_type, mg.platform_id, ${SCOPE_ID_SQL} AS workgroup_id, NULL AS anchor, NULL AS starter_id,
            s.last_active AS last_active
       FROM sessions s
       JOIN messaging_groups mg ON mg.id = s.messaging_group_id
       JOIN agent_groups ag ON ag.id = s.agent_group_id
      WHERE s.messaging_group_id IN (${inChannels})
        AND s.status = 'active' AND s.archived_at IS NULL
      UNION ALL
     SELECT s.id, s.agent_group_id, mg.id, ${ANCHOR_THREAD_SQL}, s.status, s.archived_at,
            mg.channel_type, mg.platform_id, ${SCOPE_ID_SQL}, a.thread_platform_id, a.starter_id, s.last_active
            ${ANCHORED_TASKS_SQL}
      WHERE mg.id IN (${inChannels})
      ORDER BY last_active DESC, id`,
    ...anchors.args,
    ...channels,
    ...channels,
  );
  const freshest = new Map<string, Checkable<KeyedSession>>();
  let anchored: KeyedSession | undefined;
  for (const row of sessions) {
    if (!wired.has(agentKey(row))) continue;
    if (opaqueKey(row.workgroup_id, row.thread_id ?? row.platform_id) !== threadKey) continue;
    anchored ??= row.anchor === null ? undefined : row;
    if (freshest.has(row.agent_group_id)) continue;
    const place = listedPlace(row, pairedId, dms);
    if (place) freshest.set(row.agent_group_id, { row, place });
  }
  const agents = [...freshest.values()].map(({ row }) => row);
  for (const { row, place } of freshest.values()) {
    if (!('dm' in place) && !(await threadForReply(row.id, pairedId, reads, row.thread_id))) continue;
    const nameOf = agentNames();
    const starter = anchored?.starter_id ? threadMessageById(anchored.starter_id) : null;
    return {
      platformId: row.platform_id,
      threadId: row.thread_id,
      dm: 'dm' in place,
      starter:
        anchored && starter ? { id: starter.id, agentGroupId: anchored.agent_group_id, sentAt: starter.sentAt } : null,
      taskThreadStarters: taskAnchors.flatMap(({ platformId, starterId }) =>
        platformId === row.platform_id && starterId ? [starterId] : [],
      ),
      agents: await Promise.all(
        agents.map(async (agent) => ({
          sessionId: agent.id,
          agentGroupId: agent.agent_group_id,
          channelType: agent.channel_type,
          name: await nameOf(agent),
        })),
      ),
    };
  }
  return null;
}

interface NewCallChannel {
  mg: MessagingGroup;
  agentGroupId: string;
  userId: string;
}

export async function channelForNewCall(
  agentGroupId: string,
  messagingGroupId: string,
  pairedId: string,
): Promise<NewCallChannel | null> {
  const mg = await getMessagingGroup(messagingGroupId);
  const place = mg ? ownPlace(mg, null, pairedId) : null;
  const wiring = mg && (await getMessagingGroupAgentByPair(mg.id, agentGroupId));
  if (!mg || !place || !wiring || !repliesReachThread({ ...mg, ...wiring })) return null;
  const userId = await callerIn(mg, agentGroupId, place, pairedId, seenNow);
  return userId ? { mg, agentGroupId, userId } : null;
}

export const CHANNEL_NOT_AVAILABLE = 'That channel is not available.';

type NewCall =
  | { url: string; agentName: string; joined: boolean; expiresAt: string }
  | { status: number; error: string };

const OPEN_THREAD_REFUSAL: Record<OpenThreadError, { status: number; error: string }> = {
  agent_not_wired_to_channel: { status: 404, error: CHANNEL_NOT_AVAILABLE },
  channel_cannot_open_threads: { status: 409, error: 'This channel cannot open threads.' },
  thread_create_failed: { status: 503, error: 'The thread could not be posted. Try again in a minute.' },
};

/** The call is the conversation, so no task or message is written here: the agent wakes when someone speaks to it. */
export async function openThreadForCall({ mg, agentGroupId, userId }: NewCallChannel): Promise<NewCall> {
  const who = neutralizeMentions((await getUser(userId))?.display_name || 'Someone');
  const agent = await agentNames()({ agent_group_id: agentGroupId, messaging_group_id: mg.id });
  const title = `Call with ${agent}`;
  const firstMessage = `${who} opened this thread for a call with ${agent}.`;
  const opened = await openThreadFor(
    agentGroupId,
    mg.id,
    `📞 ${who} opened a call with ${agent}. It continues in this thread.`,
    title,
    firstMessage,
  );
  if ('error' in opened) return OPEN_THREAD_REFUSAL[opened.error];
  try {
    const session = await threadSessionForCall(agentGroupId, mg, opened.threadId);
    await insertAutoThreadTitle(opened.threadId, mg.channel_type, firstMessage, opened.title);
    return await startOrJoinGroupCallAs({ sessionId: session.id, agentGroupId }, userId);
  } catch (err) {
    log.warn('Mobile: a new thread was posted but its call did not start', {
      agentGroupId,
      messagingGroupId: mg.id,
      threadId: opened.threadId,
      err,
    });
    const left = 'The thread stays in the channel, but the call did not start.';
    return err instanceof VoiceCallRefused
      ? { status: 409, error: `${left} ${err.message}` }
      : { status: 503, error: left };
  }
}

async function threadSessionForCall(agentGroupId: string, mg: MessagingGroup, threadId: string): Promise<Session> {
  // A person chose this exact thread, so a shared wiring must not fold it into a channel-wide session.
  const { session } = await resolveSession(agentGroupId, mg.id, threadId, 'per-thread');
  // Without activity the list has no row for it, and teammates could not find the call.
  await updateSession(session.id, { last_active: new Date().toISOString() });
  await markSessionEngaged(session.id);
  return session;
}

export async function callInTaskThread({
  agentGroupId,
  userId,
  mg,
  threadId,
}: TaskThreadCall): Promise<Exclude<NewCall, { error: string }>> {
  const wiring = await getMessagingGroupAgentByPair(mg.id, agentGroupId);
  if (!wiring || !repliesReachThread({ ...mg, ...wiring }))
    throw new VoiceCallRefused('Calls in this channel start from the channel.');
  if (!(await findSessionForAgent(agentGroupId, mg.id, threadId))) refuseIfCallCannotOpen(agentGroupId);
  const session = await threadSessionForCall(agentGroupId, mg, threadId);
  return startOrJoinGroupCallAs({ sessionId: session.id, agentGroupId }, userId);
}
