/**
 * One row per thread whose name the host owns or tracks. Every surface shows `title`; `title_source` says who may
 * change it (migration 094). `channel_type` names the bot that reaches the thread, which a thread id alone cannot:
 * `@chat-adapter/discord` prefixes every thread id `discord:` whatever the bot instance. Single statements only, so
 * none needs `centralTransaction`.
 */
import { getDb } from './connection.js';

const YOUNG_WINDOW_MS = 60 * 60_000;
const FIRST_TITLE_WINDOW_MS = 24 * 60 * 60_000;
/** Our own pacing, not Discord's limit: its docs say limits must be read from responses, never hard coded. */
const RENAME_COOLDOWN_MS = 5 * 60_000;
const MAX_RENAMES = 3;
/** A first title's next try waits as long as the thread is old, so the gap doubles up to this many days. */
const FIRST_TITLE_MAX_GAP_DAYS = 4 / 24;

/** The rows whose name the title sweep may still change. For `thread_titles t`, binding {@link unsettledSince}. */
export const UNSETTLED_ROW_SQL = `t.title_source = 'auto'
  AND ((t.created_at >= ? AND t.attempts < ${MAX_RENAMES}) OR (t.created_at >= ? AND t.attempts = 0))`;

export const unsettledSince = (nowMs: number): [string, string] => [
  new Date(nowMs - YOUNG_WINDOW_MS).toISOString(),
  new Date(nowMs - FIRST_TITLE_WINDOW_MS).toISOString(),
];

export interface UnsettledThread {
  thread_id: string;
  channel_type: string;
  title: string | null;
  platform_name: string | null;
  sent_name: string | null;
  attempts: number;
  session_id: string;
  agent_group_id: string;
  title_basis_seq: number | null;
}

/**
 * `ON CONFLICT DO NOTHING`: siblings racing on one opener must not double-insert, and a redelivered opener must not
 * reset a row. `title` is NULL until the thread has a name worth showing.
 */
export async function insertAutoThreadTitle(
  threadId: string,
  channelType: string,
  firstMessage: string,
  title: string | null,
  createdAt: string = new Date().toISOString(),
): Promise<void> {
  await getDb().run(
    `INSERT INTO thread_titles (thread_id, channel_type, title, first_message, attempts, created_at, title_source)
       VALUES (@thread_id, @channel_type, @title, @first_message, 0, @created_at, 'auto')
       ON CONFLICT(thread_id) DO NOTHING`,
    { thread_id: threadId, channel_type: channelType, title, first_message: firstMessage, created_at: createdAt },
  );
}

export function getThreadTitleOwner(
  threadId: string,
): Promise<{ channel_type: string; title_source: string | null } | undefined> {
  return getDb().get('SELECT channel_type, title_source FROM thread_titles WHERE thread_id = ?', threadId);
}

export async function storeThreadPlatformName(threadId: string, name: string): Promise<void> {
  await getDb().run(
    `UPDATE thread_titles SET platform_name = ? WHERE thread_id = ? AND title_source = 'auto'`,
    name,
    threadId,
  );
}

export function listUnsettledThreadsDue(nowMs: number, limit: number, offset: number): Promise<UnsettledThread[]> {
  return getDb().all<UnsettledThread>(
    `SELECT t.thread_id, t.channel_type, t.title, t.platform_name, t.sent_name, t.attempts,
            s.id AS session_id, s.agent_group_id, s.title_basis_seq
       FROM thread_titles t
       JOIN sessions s ON s.thread_id = t.thread_id AND s.status = 'active'
      WHERE ${UNSETTLED_ROW_SQL}
        AND (t.titled_at IS NULL
             OR (t.titled_at <= ?
                 AND (t.attempts > 0
                      OR julianday(?) - julianday(t.titled_at)
                         >= MIN(julianday(t.titled_at) - julianday(t.created_at), ?))))
      ORDER BY (t.attempts > 0), COALESCE(s.last_active, s.created_at) DESC
      LIMIT ? OFFSET ?`,
    ...unsettledSince(nowMs),
    new Date(nowMs - RENAME_COOLDOWN_MS).toISOString(),
    new Date(nowMs).toISOString(),
    FIRST_TITLE_MAX_GAP_DAYS,
    limit,
    offset,
  );
}

export async function stampThreadTitleTurn(threadId: string, nowMs: number): Promise<void> {
  await getDb().run(
    `UPDATE thread_titles SET titled_at = ? WHERE thread_id = ?`,
    new Date(nowMs).toISOString(),
    threadId,
  );
}

export async function holdThreadTitleUntil(threadId: string, untilMs: number): Promise<void> {
  await getDb().run(
    `UPDATE thread_titles SET titled_at = MAX(titled_at, ?) WHERE thread_id = ?`,
    new Date(untilMs - RENAME_COOLDOWN_MS).toISOString(),
    threadId,
  );
}

export async function recordThreadNameSent(threadId: string, name: string): Promise<void> {
  await getDb().run(
    `UPDATE thread_titles SET sent_name = ? WHERE thread_id = ? AND title_source = 'auto'`,
    name,
    threadId,
  );
}

export async function recordThreadRename(threadId: string, title: string): Promise<void> {
  await getDb().run(
    `UPDATE thread_titles SET title = ?, attempts = attempts + 1 WHERE thread_id = ? AND title_source = 'auto'`,
    title,
    threadId,
  );
}

export async function recordThreadNamedByPerson(threadId: string, name: string): Promise<void> {
  await getDb().run(
    `UPDATE thread_titles SET title = ?, title_source = 'person' WHERE thread_id = ? AND title_source = 'auto'`,
    name,
    threadId,
  );
}

export async function recordThreadPinned(threadId: string, channelType: string, title: string): Promise<void> {
  await getDb().run(
    `INSERT INTO thread_titles (thread_id, channel_type, title, first_message, attempts, created_at, title_source)
       VALUES (?, ?, ?, '', 0, ?, 'pinned')
       ON CONFLICT(thread_id) DO UPDATE SET title = excluded.title, title_source = 'pinned'`,
    threadId,
    channelType,
    title,
    new Date().toISOString(),
  );
}
