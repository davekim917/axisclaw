import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { rootPostsAmong, threadsHoldingMessages } from '../../message-archive.js';
import { readSessionInbound } from '../mailbox/index.js';

const DAY_MS = 24 * 60 * 60_000;
export const SEARCH_WINDOW_MS = 90 * DAY_MS;
const DELIVERED_SCAN_ROWS = 2_000;
const RECORD_TTL_MS = 5 * 60_000;

/**
 * A thread a scheduled task's post started: delivery posts a task at a channel's top level and threads its later posts
 * under that post, whose platform id is the thread's.
 */
export interface TaskAnchor {
  sessionId: string;
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadPlatformId: string;
  createdAt: string;
  /** The anchor post's archive id, null when only `task_thread_anchors` names it. */
  starterId: string | null;
}

interface AnchorRow {
  session_id: string;
  agent_group_id: string;
  channel_type: string;
  platform_id: string;
  thread_platform_id: string;
  created_at: string;
}

const records = new Map<string, { readAt: number; anchors: TaskAnchor[] }>();

const holds = (anchors: TaskAnchor[], current: AnchorRow[]) =>
  current.every((row) =>
    anchors.some(
      (anchor) =>
        anchor.channelType === row.channel_type &&
        anchor.platformId === row.platform_id &&
        anchor.threadPlatformId === row.thread_platform_id,
    ),
  );

/**
 * Every post the session put at a channel's top level in the window. `task_thread_anchors` keeps only the newest per
 * channel, so the earlier ones come from the session's delivery record, which names each post's platform id, and the
 * archive, which says where it landed.
 */
function topLevelPosts(sessionId: string, agentGroupId: string, current: AnchorRow[]): TaskAnchor[] {
  const now = Date.now();
  const known = records.get(sessionId);
  if (known && now - known.readAt < RECORD_TTL_MS && holds(known.anchors, current)) return known.anchors;
  let delivered: Map<string, string>;
  try {
    const since = new Date(now - SEARCH_WINDOW_MS).toISOString();
    const rows = readSessionInbound({ agentGroupId, sessionId }, (inbound) =>
      inbound.listDeliveredSince(since, DELIVERED_SCAN_ROWS),
    );
    delivered = new Map((rows ?? []).map((row) => [row.message_out_id, row.platform_message_id]));
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable record costs the list only the earlier threads
  } catch (err) {
    log.warn('Mobile: could not read where a task’s threads started', { sessionId, err });
    return [];
  }
  const anchors = rootPostsAmong(agentGroupId, [...delivered.keys()]).map((post) => ({
    sessionId,
    agentGroupId,
    channelType: post.channelType,
    platformId: post.platformId,
    threadPlatformId: delivered.get(post.id)!,
    createdAt: post.sentAt,
    starterId: post.id,
  }));
  for (const [id, record] of records) if (now - record.readAt >= RECORD_TTL_MS) records.delete(id);
  // Delivery records an anchor a moment before it archives the post, so a read between the two is not kept.
  if (holds(anchors, current)) records.set(sessionId, { readAt: now, anchors });
  return anchors;
}

/**
 * Each thread once, newest first, in the channels where `task_thread_anchors` shows the session posts. A post nothing
 * was posted under is no thread yet: Discord opens one on it only when the first post under it lands, and until then
 * the platform answers that it does not exist. What lands under it is archived by whichever bots see it, even when
 * the task's own agent did not archive it, as for the rest of a long post the adapter split.
 */
async function anchorsOf(rows: AnchorRow[], windowStart: number): Promise<TaskAnchor[]> {
  const found = new Map<string, TaskAnchor>();
  const add = (anchor: TaskAnchor) => {
    const key = JSON.stringify([anchor.sessionId, anchor.channelType, anchor.platformId, anchor.threadPlatformId]);
    if (!found.has(key)) found.set(key, anchor);
  };
  const postsIn = new Set(rows.map((row) => JSON.stringify([row.session_id, row.channel_type, row.platform_id])));
  for (const [sessionId, agentGroupId] of new Map(rows.map((row) => [row.session_id, row.agent_group_id]))) {
    const current = rows.filter((row) => row.session_id === sessionId && Date.parse(row.created_at) >= windowStart);
    for (const post of topLevelPosts(sessionId, agentGroupId, current))
      if (postsIn.has(JSON.stringify([post.sessionId, post.channelType, post.platformId]))) add(post);
  }
  for (const row of rows)
    add({
      sessionId: row.session_id,
      agentGroupId: row.agent_group_id,
      channelType: row.channel_type,
      platformId: row.platform_id,
      threadPlatformId: row.thread_platform_id,
      createdAt: row.created_at,
      starterId: null,
    });
  const inWindow = [...found.values()].filter((anchor) => Date.parse(anchor.createdAt) >= windowStart);
  const byPlatform = new Map<string, TaskAnchor[]>();
  for (const anchor of inWindow)
    byPlatform.set(anchor.platformId, [...(byPlatform.get(anchor.platformId) ?? []), anchor]);
  const opened = new Set<string>();
  for (const [platformId, anchors] of byPlatform) {
    const bots = await getDb().all<{ channel_type: string }>(
      'SELECT DISTINCT channel_type FROM messaging_groups WHERE platform_id = ?',
      platformId,
    );
    const channelTypes = bots.map((bot) => bot.channel_type);
    for (const threadId of threadsHoldingMessages(channelTypes, platformId, anchors.map(anchorThreadId)))
      opened.add(threadId);
  }
  return inWindow
    .filter((anchor) => opened.has(anchorThreadId(anchor)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const ANCHOR_ROWS_SQL = `
  SELECT a.session_id, s.agent_group_id, a.channel_type, a.platform_id, a.thread_platform_id, a.created_at
    FROM task_thread_anchors a
    JOIN sessions s ON s.id = a.session_id AND s.messaging_group_id IS NULL
   WHERE s.status = 'active' AND s.archived_at IS NULL`;

export async function taskAnchorsIn(platformIds: string[], since: string): Promise<TaskAnchor[]> {
  if (platformIds.length === 0) return [];
  const rows = await getDb().all<AnchorRow>(
    `${ANCHOR_ROWS_SQL} AND a.platform_id IN (${platformIds.map(() => '?').join(', ')})`,
    ...platformIds,
  );
  return anchorsOf(rows, Date.parse(since));
}

export async function taskAnchorsOf(sessionId: string): Promise<TaskAnchor[]> {
  const rows = await getDb().all<AnchorRow>(`${ANCHOR_ROWS_SQL} AND a.session_id = ?`, sessionId);
  return anchorsOf(rows, Date.now() - SEARCH_WINDOW_MS);
}

export const anchorThreadId = (anchor: Pick<TaskAnchor, 'platformId' | 'threadPlatformId'>) =>
  `${anchor.platformId}:${anchor.threadPlatformId}`;

export function anchorsTable(anchors: TaskAnchor[]): { sql: string; args: string[] } {
  // One bound JSON array, however many anchors: SQLite caps the parameters one statement binds.
  return {
    sql: `anchors AS (
      SELECT json_extract(value, '$.sessionId') AS session_id, json_extract(value, '$.channelType') AS channel_type,
             json_extract(value, '$.platformId') AS platform_id,
             json_extract(value, '$.threadPlatformId') AS thread_platform_id,
             json_extract(value, '$.createdAt') AS created_at, json_extract(value, '$.starterId') AS starter_id
        FROM json_each(?))`,
    args: [JSON.stringify(anchors)],
  };
}
