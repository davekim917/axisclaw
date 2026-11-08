/** Carries the title sweep's names to the platform. A thread with no `thread_titles` row is never touched. */
import { ChannelRateLimitedError, MAX_THREAD_NAME_CHARS, type ChannelAdapter } from './channels/adapter.js';
import { getChannelAdapter } from './channels/channel-registry.js';
import { neutralizeMentions } from './channels/neutralize-mentions.js';
import { getMessagingGroup } from './db/messaging-groups.js';
import { getSession } from './db/sessions.js';
import {
  getThreadTitleOwner,
  holdThreadTitleUntil,
  insertAutoThreadTitle,
  recordThreadNamedByPerson,
  recordThreadNameSent,
  recordThreadPinned,
  recordThreadRename,
  storeThreadPlatformName,
  type UnsettledThread,
} from './db/thread-titles.js';
import { log } from './log.js';

/** `seq` rises by 2 per message on each side of a session, so this is one new exchange. */
const REFRESH_MIN_NEW_SEQ = 2;

async function storePlatformName(adapter: ChannelAdapter, threadId: string): Promise<void> {
  try {
    const name = await adapter.threadName?.(threadId);
    if (name) await storeThreadPlatformName(threadId, name);
  } catch (err) {
    log.warn('Thread title: could not read the name of a new thread', { threadId, err });
  }
}

/** A thread opened by a message shares its snowflake; any other thread already has a chosen name. */
export async function trackOpenedThread(
  channelType: string,
  threadId: string | null,
  firstMessage: string,
  inboundMessageId: string,
): Promise<void> {
  if (!threadId || threadId.split(':').pop() !== inboundMessageId) return;
  const adapter = getChannelAdapter(channelType);
  if (!adapter?.renameThread) return;
  try {
    await insertAutoThreadTitle(threadId, channelType, firstMessage, null);
  } catch (err) {
    log.warn('Thread title: could not record a new thread', { threadId, err });
    return;
  }
  void storePlatformName(adapter, threadId);
}

export function threadTitleDue(thread: UnsettledThread, sliceMaxSeq: number): boolean {
  if (!getChannelAdapter(thread.channel_type)) return false;
  if (thread.title_basis_seq == null) return true;
  return sliceMaxSeq - thread.title_basis_seq >= REFRESH_MIN_NEW_SEQ;
}

export function threadTitleLabel(thread: UnsettledThread): string | null {
  return thread.attempts === 0 ? null : thread.title;
}

async function recordRename(thread: UnsettledThread, name: string): Promise<void> {
  await recordThreadRename(thread.thread_id, name);
  log.info('Thread title: renamed', {
    threadId: thread.thread_id,
    channelType: thread.channel_type,
    renames: thread.attempts + 1,
  });
}

async function renameOnPlatform(thread: UnsettledThread, title: string, adapter: ChannelAdapter): Promise<void> {
  const { thread_id: threadId } = thread;
  // A rename someone asked for can land while this title was being generated.
  if ((await getThreadTitleOwner(threadId))?.title_source !== 'auto') return;
  const live = await adapter.threadName?.(threadId);
  const ours = thread.title ?? thread.platform_name;
  if (live !== undefined && live !== ours) {
    // A rename that landed but lost its response leaves the name it sent.
    if (live === thread.sent_name) return recordRename(thread, live);
    if (ours !== null) {
      log.info('Thread title: a person renamed this thread, leaving it to them', { threadId, name: live });
      return recordThreadNamedByPerson(threadId, live);
    }
  }
  if (title === thread.title) return;
  let stored = title;
  if (adapter.renameThread) {
    await recordThreadNameSent(threadId, title);
    stored = await adapter.renameThread(threadId, title);
  }
  await recordRename(thread, stored);
}

export async function applyThreadTitle(thread: UnsettledThread, title: string): Promise<boolean> {
  const adapter = getChannelAdapter(thread.channel_type);
  if (!adapter) return false;
  try {
    await renameOnPlatform(thread, title, adapter);
    return true;
  } catch (err) {
    log.warn('Thread title: rename failed, the thread keeps its name', { threadId: thread.thread_id, err });
    if (err instanceof ChannelRateLimitedError) {
      await holdThreadTitleUntil(thread.thread_id, Date.now() + err.retryAfterMs);
    }
    return false;
  }
}

const NOT_IN_A_THREAD = 'This conversation is not in a thread, so there is no thread to rename.';

function askedForTitle(raw: string): string {
  const title = neutralizeMentions(raw.replace(/\s+/g, ' ').trim());
  if (!title) throw new Error('--title must not be empty.');
  const chars = [...title].length;
  if (chars > MAX_THREAD_NAME_CHARS) {
    throw new Error(`--title is ${chars} characters; the limit is ${MAX_THREAD_NAME_CHARS}.`);
  }
  return title;
}

const spokenWait = (ms: number): string => {
  const seconds = Math.ceil(ms / 1000);
  return seconds < 90 ? `${seconds} seconds` : `${Math.ceil(seconds / 60)} minutes`;
};

async function renameForSomeone(adapter: ChannelAdapter, threadId: string, title: string): Promise<string> {
  try {
    return await adapter.renameThread!(threadId, title);
  } catch (err) {
    const why =
      err instanceof ChannelRateLimitedError
        ? `The platform is limiting renames here. Try again in about ${spokenWait(err.retryAfterMs)}.`
        : err instanceof Error
          ? err.message
          : String(err);
    throw new Error(`The thread keeps its name. ${why}`, { cause: err });
  }
}

/** The bot is the one on the thread's row, else the session's: a sibling's token may not be able to rename it. */
export async function renameSessionThread(
  sessionId: string,
  rawTitle: string,
): Promise<{ title: string; appOnly: boolean }> {
  const session = await getSession(sessionId);
  const threadId = session?.thread_id;
  if (!threadId) throw new Error(NOT_IN_A_THREAD);
  const asked = askedForTitle(rawTitle);
  const channelType =
    (await getThreadTitleOwner(threadId))?.channel_type ??
    (session.messaging_group_id ? (await getMessagingGroup(session.messaging_group_id))?.channel_type : undefined);
  if (!channelType) throw new Error(NOT_IN_A_THREAD);
  const adapter = getChannelAdapter(channelType);
  if (!adapter) throw new Error('The thread keeps its name. This channel is offline right now; try again shortly.');
  const title = adapter.renameThread ? await renameForSomeone(adapter, threadId, asked) : asked;
  await recordThreadPinned(threadId, channelType, title);
  return { title, appOnly: !adapter.renameThread };
}
