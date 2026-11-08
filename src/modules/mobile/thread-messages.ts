import { getKnownSlackBots } from '../../channels/slack-mentions.js';
import { getDb } from '../../db/connection.js';
import {
  archiveMessageKey,
  recentThreadMessages,
  threadMessageById,
  type ThreadMessage,
} from '../../message-archive.js';
import { scrubSecrets } from '../../secret-scrubber.js';
import { transformOutsideProtectedRegions } from '../../text-styles.js';
import { withoutReplayedThread } from '../../thread-context.js';
import { rawUserId, userPlatform } from '../voice-call/group/place.js';
import { mirroredSpeech, relayedWords } from '../voice-call/prompts.js';
import { opaqueId, type ThreadToRead } from './threads.js';

export const MESSAGES_SHOWN = 100;
/** A row that shows nothing, such as a copy whose post shows from its own record, still takes a slot in the limit. */
const ROWS_PER_AGENT = MESSAGES_SHOWN * 2;
/**
 * How long after a sibling's copy the posting agent's own record of it lands: delivery archives once the platform has
 * answered. Over 30 days on this install, among copies whose text matched their record exactly, the longest was 12.7 s.
 */
const OWN_RECORD_LAG_MS = 20_000;
/**
 * A user mention as the archive holds it: `<@id>`, with Discord's `!` or Slack's `|label`, or a bare `@id`, which is how
 * Discord's adapter archives what people post. A bare one stands apart from the text around it, unlike an address.
 */
const MENTION_RE = /<@!?([A-Z0-9]+)(?:\|[^>]*)?>|(?<![\w.@])@(\d{15,21}|[UW][A-Z0-9]{6,})(?![\w@]|\.\w)/g;

export interface ShownMessage {
  id: string;
  speaker: string;
  /** An agent's post, as opposed to a person's or another app's. */
  fromAgent: boolean;
  /** Said on a call and posted by the agent's bot, so the words are what a speech model heard. */
  spoken: boolean;
  text: string;
  sentAt: string;
}

export interface AgentRead {
  name: string;
  /** The platform id its bot posts as, when its adapter has registered one. */
  botId: string | null;
  rows: ThreadMessage[];
  /** Its posts not shown here, by archive id: at a channel's top level, a task's posts that open listed threads. */
  shownElsewhere?: ReadonlySet<string>;
}

/** Mentions of an id with a known name read as that name; any other mention, and code, stays as written. */
const withNames = (text: string, names: ReadonlyMap<string, string>) =>
  names.size === 0
    ? text
    : transformOutsideProtectedRegions(text, (segment) =>
        segment.replace(MENTION_RE, (mention, angled?: string, bare?: string) => {
          const name = names.get(angled ?? bare ?? '');
          return name ? `@${name}` : mention;
        }),
      );

/** A relay or a replayed thread history is how an agent was told; the person said only what is inside it. */
const saidText = (row: ThreadMessage) =>
  row.role === 'user' ? (relayedWords(row.text) ?? withoutReplayedThread(row.text)) : row.text;

interface OwnRecord {
  atMs: number;
  mirrorShaped: boolean;
}

/**
 * One entry per message, oldest first. A post its read shows elsewhere is left out, and still counts below as its
 * agent's record. Every bot archives its own copy of what people post, and those collapse. An
 * agent's post is archived by that agent and also, as a message from its bot, by each sibling that receives it, a
 * moment earlier and often in other words, so a bot's copy is dropped when an agent posting as that bot recorded a
 * post in the window after it. A copy with no such record is the only one of a post delivery did not archive, such as
 * a card or a call's mirror, and shows. A mirror is believed only from our own bot, and is dropped only for a
 * mirror-shaped record in that window, which is how an agent's post that merely looks like one reads.
 */
export function shownMessages(
  platformId: string,
  threadId: string | null,
  reads: AgentRead[],
  ourBots: ReadonlySet<string>,
  names: ReadonlyMap<string, string>,
): ShownMessage[] {
  const ownRecords = new Map<string, OwnRecord[]>();
  for (const { botId, rows } of reads) {
    if (!botId) continue;
    const records = ownRecords.get(botId) ?? [];
    ownRecords.set(botId, records);
    for (const row of rows)
      if (row.role === 'assistant')
        records.push({ atMs: Date.parse(row.sentAt), mirrorShaped: mirroredSpeech(row.text) !== null });
  }
  const recordedRightAfter = (sender: string, copy: ThreadMessage, mirrorShaped: boolean) => {
    const atMs = Date.parse(copy.sentAt);
    return (ownRecords.get(sender) ?? []).some(
      (record) =>
        record.atMs >= atMs && record.atMs - atMs <= OWN_RECORD_LAG_MS && (!mirrorShaped || record.mirrorShaped),
    );
  };
  const shown = new Map<string, ShownMessage>();
  const rows = reads
    .flatMap((read) => read.rows.map((row) => ({ read, row })))
    .sort((a, b) => a.row.sentAt.localeCompare(b.row.sentAt) || a.row.id.localeCompare(b.row.id));
  for (const { read, row } of rows) {
    if (read.shownElsewhere?.has(row.id)) continue;
    const sender = row.role === 'user' && row.senderId !== null ? rawUserId(row.senderId) : null;
    const fromOurBot = sender !== null && ourBots.has(sender);
    const mirror = fromOurBot ? mirroredSpeech(row.text) : null;
    if (sender !== null && recordedRightAfter(sender, row, mirror !== null)) continue;
    const key =
      row.role === 'assistant'
        ? JSON.stringify(['agent', row.id])
        : archiveMessageKey({ platformId, threadId, sentAt: row.sentAt, senderId: row.senderId, text: row.text });
    if (shown.has(key)) continue;
    const text = scrubSecrets(withNames(mirror ? mirror.words : saidText(row), names)).trim();
    if (!text) continue;
    shown.set(key, {
      id: opaqueId(key),
      speaker: mirror?.speaker ?? (row.role === 'assistant' ? read.name : row.senderName || 'Someone'),
      fromAgent: row.role === 'assistant' || (fromOurBot && !mirror),
      spoken: mirror !== null,
      text,
      sentAt: row.sentAt,
    });
  }
  return [...shown.values()].slice(-MESSAGES_SHOWN);
}

/** The platform id each channel type's bot posts as, from the registries the adapters fill as they connect. */
async function ourBotIds(): Promise<Map<string, string>> {
  const { getKnownDiscordBots } = await import('../../channels/discord.js');
  return new Map([...getKnownSlackBots(), ...getKnownDiscordBots()].map(([type, bot]) => [type, bot.userId]));
}

/**
 * The name each mentioned id shows as, from what the host already holds: an agent's bot by the name its adapter
 * registered, else a person by their user row. No platform call, so an id neither knows stays as written. A Slack id is
 * named only from the thread's own workspace: the same raw id can name someone else in another.
 */
async function mentionNames(thread: ThreadToRead, rows: ThreadMessage[]): Promise<Map<string, string>> {
  const ids = new Set(rows.flatMap((row) => [...row.text.matchAll(MENTION_RE)].map((m) => m[1] ?? m[2])));
  const names = new Map<string, string>();
  if (ids.size === 0) return names;
  const { getKnownDiscordBots } = await import('../../channels/discord.js');
  const platform = thread.platformId.split(':')[0];
  const bots: Array<[string, { userId: string; name: string }]> = [];
  if (platform === 'slack') {
    const slackBots = getKnownSlackBots();
    const teams = new Set(thread.agents.map(({ channelType }) => slackBots.get(channelType)?.teamId));
    for (const [type, bot] of slackBots)
      if (teams.has(bot.teamId))
        bots.push([type, { userId: bot.userId, name: bot.displayName || bot.realName || bot.username }]);
  } else if (platform === 'discord') {
    for (const [type, bot] of getKnownDiscordBots()) bots.push([type, { userId: bot.userId, name: bot.username }]);
  }
  for (const [, bot] of bots) if (ids.has(bot.userId)) names.set(bot.userId, bot.name);
  const people = [...ids].filter((id) => !names.has(id));
  if (people.length === 0) return names;
  const slackTypes = new Set(bots.map(([type]) => type));
  // A Discord id is global, so a Discord person is known before, or without, any bot of theirs registering.
  const ownsUser = (id: string) =>
    platform === 'discord' ? userPlatform(id) === 'discord' : slackTypes.has(id.slice(0, id.indexOf(':')));
  const users = await getDb().all<{ id: string; display_name: string | null }>(
    `SELECT id, display_name FROM users WHERE substr(id, instr(id, ':') + 1) IN (${people.map(() => '?').join(', ')})`,
    ...people,
  );
  for (const { id, display_name } of users) if (display_name && ownsUser(id)) names.set(rawUserId(id), display_name);
  return names;
}

export async function readThreadMessages(thread: ThreadToRead): Promise<{ messages: ShownMessage[] }> {
  const { platformId, threadId } = thread;
  // A thread id that is the platform id names the top level, where delivery archives an agent's posts with no thread.
  const shapes = threadId === platformId ? [threadId, null] : [threadId];
  const bots = await ourBotIds();
  const starter = thread.starter && threadMessageById(thread.starter.id);
  const shownElsewhere = !thread.dm && shapes.includes(null) ? new Set(thread.taskThreadStarters) : undefined;
  const reads = thread.agents.map(({ agentGroupId, channelType, name }) => ({
    name,
    botId: bots.get(channelType) ?? null,
    shownElsewhere,
    rows: [
      ...(starter && thread.starter?.agentGroupId === agentGroupId ? [starter] : []),
      ...shapes.flatMap((shape) =>
        recentThreadMessages({ agentGroupId, channelType, platformId, threadId: shape, limit: ROWS_PER_AGENT }),
      ),
    ],
  }));
  const names = await mentionNames(
    thread,
    reads.flatMap((read) => read.rows),
  );
  return { messages: shownMessages(platformId, threadId, reads, new Set(bots.values()), names) };
}
