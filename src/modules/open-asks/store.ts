import { getDb } from '../../db/connection.js';
import { latestHumanMessage } from '../../message-archive.js';
import { parseUtcTimestampMs, replyThreads } from '../../thread-context.js';
import { isOwnBotSender } from '../permissions/index.js';
import { leadingAddressees, outcomeAskText, sessionAskCause, type Ask, type AskMark } from './asks.js';

/** Scan bound for outcome receipts; an ask older than this is no longer anyone's live work. */
const OUTCOME_LOOKBACK_MS = 30 * 24 * 60 * 60_000;
const TASK_NEEDS_INPUT_TEXT = 'A running task needs input to continue.';
const ASK_QUESTION_TEXT = 'The agent asked a question and is waiting for a reply.';
const OPEN_ASK_MARKS_MIGRATION = 'open-ask-marks';

function isoOf(value: string | null): string | null {
  const ms = parseUtcTimestampMs(value);
  return ms === null ? null : new Date(ms).toISOString();
}

interface Directory {
  /** Platform user ids of owners and global admins. A role row's user_id is `<channel type>:<platform user id>`. */
  operatorIds: Set<string>;
  /** First names of every known person, and of the operators among them. */
  people: Set<string>;
  operatorNames: Set<string>;
}

const firstName = (displayName: string | null) => displayName?.trim().split(/\s+/)[0] ?? '';

async function directory(): Promise<Directory> {
  const rows = await getDb().all<{ id: string; display_name: string | null; operator: number }>(
    `SELECT u.id, u.display_name,
            EXISTS (SELECT 1 FROM user_roles r
                     WHERE r.user_id = u.id AND (r.role = 'owner' OR (r.role = 'admin' AND r.agent_group_id IS NULL)))
              AS operator
       FROM users u`,
  );
  const operators = rows.filter((r) => r.operator === 1);
  return {
    operatorIds: new Set(operators.map((r) => r.id.slice(r.id.indexOf(':') + 1)).filter(Boolean)),
    people: new Set(rows.map((r) => firstName(r.display_name)).filter(Boolean)),
    operatorNames: new Set(operators.map((r) => firstName(r.display_name)).filter(Boolean)),
  };
}

interface Conversation {
  channelTypes: string[];
  platformId: string;
  threads: Array<string | null>;
}

/** Every agent wired to the room archives what is said in it, each under its own channel type. */
async function conversation(platformId: string | null, threads: Array<string | null>): Promise<Conversation | null> {
  if (!platformId) return null;
  const rows = await getDb().all<{ channel_type: string }>(
    `SELECT DISTINCT channel_type FROM messaging_groups WHERE platform_id = ?`,
    platformId,
  );
  return { channelTypes: rows.map((r) => r.channel_type), platformId, threads };
}

function humanMessage(conv: Conversation | null, window: { after?: string; atOrBefore?: string }) {
  return conv ? latestHumanMessage({ ...conv, isBot: isOwnBotSender, ...window }) : null;
}

/**
 * Names the ask opens with decide; otherwise it is for the newest person who wrote before it, since that is who an
 * agent's next message answers.
 */
function forOperator(text: string, conv: Conversation | null, askedAt: string, dir: Directory): boolean {
  const named = leadingAddressees(text, dir.people);
  if (named.length > 0) return named.some((name) => dir.operatorNames.has(name));
  const latest = humanMessage(conv, { atOrBefore: askedAt });
  return latest !== null && dir.operatorIds.has(latest.senderId.slice(latest.senderId.indexOf(':') + 1));
}

interface ReceiptRow {
  message_id: string;
  workgroup_id: string;
  session_id: string;
  agent_group_id: string;
  thread_id: string | null;
  platform_id: string;
  platform_message_id: string | null;
  /** Receipts written before `delivered_at` existed fall back to their first send attempt. */
  delivered_at: string;
  needs_you: string | null;
}

async function outcomeAsks(opts: { workgroupId?: string; nowMs: number }, dir: Directory): Promise<Ask[]> {
  const since = new Date(opts.nowMs - OUTCOME_LOOKBACK_MS).toISOString();
  const receipts = await getDb().all<ReceiptRow>(
    `SELECT r.message_id, r.workgroup_id, r.session_id, s.agent_group_id, r.thread_id, r.platform_id,
            r.platform_message_id, COALESCE(r.delivered_at, r.created_at) AS delivered_at,
            json_extract(r.content, '$.reporting.outcome.needsYou') AS needs_you
       FROM work_outcome_receipts r
       JOIN sessions s ON s.id = r.session_id
      WHERE r.state = 'delivered'
        AND json_extract(r.content, '$.reporting.outcome.needsYou') IS NOT NULL
        AND datetime(COALESCE(r.delivered_at, r.created_at)) > datetime(?)
        ${opts.workgroupId ? 'AND r.workgroup_id = ?' : ''}`,
    ...(opts.workgroupId ? [since, opts.workgroupId] : [since]),
  );

  const asks: Ask[] = [];
  for (const r of receipts) {
    const text = outcomeAskText(r.needs_you);
    const askedAt = isoOf(r.delivered_at);
    if (!text || !askedAt) continue;
    const threads = replyThreads(r.platform_id, r.thread_id || null, r.platform_message_id);
    const conv = await conversation(r.platform_id, threads);
    if (humanMessage(conv, { after: askedAt })) continue;
    asks.push({
      id: `outcome:${r.message_id}`,
      cause: 'outcome',
      workgroupId: r.workgroup_id.startsWith('agent-group:') ? null : r.workgroup_id,
      agentGroupId: r.agent_group_id,
      sessionId: r.session_id,
      threadId: threads.find((t) => t !== null) ?? null,
      askedAt,
      text,
      forOperator: forOperator(text, conv, askedAt, dir),
    });
  }
  return asks;
}

interface SessionAskJoinRow {
  id: string;
  agent_group_id: string;
  workgroup_id: string | null;
  thread_id: string | null;
  last_active: string | null;
  last_outbound_at: string | null;
  last_outbound_kind: string | null;
  task_id: string | null;
  needs_input: number | null;
  steer_question: string | null;
  task_asked_at: string | null;
  platform_id: string | null;
  parent_session_id: string | null;
  parent_thread_id: string | null;
  parent_platform_id: string | null;
}

async function sessionAsks(opts: { workgroupId?: string }, dir: Directory): Promise<Ask[]> {
  const rows = await getDb().all<SessionAskJoinRow>(
    `SELECT s.id, s.agent_group_id, ag.workgroup_id, s.thread_id, s.last_active, s.last_outbound_at,
            s.last_outbound_kind, t.task_id, t.needs_input, t.steer_question,
            COALESCE(t.needs_input_at, t.last_progress_at, t.started_at, t.admitted_at) AS task_asked_at,
            mg.platform_id, t.parent_session_id, ps.thread_id AS parent_thread_id,
            pmg.platform_id AS parent_platform_id
       FROM sessions s
       JOIN agent_groups ag ON ag.id = s.agent_group_id
  LEFT JOIN messaging_groups mg ON mg.id = s.messaging_group_id
  LEFT JOIN tasks t ON t.child_session_id = s.id AND t.needs_input = 1 AND t.status IN ('pending', 'running')
  LEFT JOIN sessions ps ON ps.id = t.parent_session_id
  LEFT JOIN messaging_groups pmg ON pmg.id = ps.messaging_group_id
      WHERE s.archived_at IS NULL
        AND (s.last_outbound_kind = 'chat-sdk:ask_question' OR t.task_id IS NOT NULL)
        ${opts.workgroupId ? 'AND ag.workgroup_id = ?' : ''}`,
    ...(opts.workgroupId ? [opts.workgroupId] : []),
  );

  const asks: Ask[] = [];
  for (const row of rows) {
    const cause = sessionAskCause({
      attached_task_needs_input: row.needs_input,
      last_outbound_kind: row.last_outbound_kind,
      last_active: row.last_active,
      last_outbound_at: row.last_outbound_at,
    });
    if (!cause) continue;
    const isTask = cause === 'task_needs_input';
    const askedAt = isoOf(isTask ? row.task_asked_at : row.last_outbound_at);
    if (!askedAt) continue;
    // A task's child session holds only the host-written brief; whoever asked for the task wrote in the parent.
    const conv =
      isTask && row.parent_session_id
        ? await conversation(row.parent_platform_id, [row.parent_thread_id || null])
        : await conversation(row.platform_id, [row.thread_id || null]);
    const text = isTask ? row.steer_question?.trim() || TASK_NEEDS_INPUT_TEXT : ASK_QUESTION_TEXT;
    asks.push({
      id: `${isTask ? `task:${row.task_id}` : `question:${row.id}`}:${Date.parse(askedAt)}`,
      cause,
      workgroupId: row.workgroup_id,
      agentGroupId: row.agent_group_id,
      sessionId: row.id,
      threadId: row.thread_id || null,
      askedAt,
      text,
      forOperator: forOperator(text, conv, askedAt, dir),
    });
  }
  return asks;
}

export async function listAsks(opts: { workgroupId?: string; nowMs: number }): Promise<Ask[]> {
  const dir = await directory();
  const asks = [...(await outcomeAsks(opts, dir)), ...(await sessionAsks(opts, dir))];
  return asks.sort((a, b) => a.askedAt.localeCompare(b.askedAt));
}

export async function getMarks(ids: string[]): Promise<Map<string, AskMark>> {
  if (ids.length === 0) return new Map();
  const rows = await getDb().all<AskMark>(
    `SELECT * FROM open_ask_marks WHERE ask_id IN (${ids.map(() => '?').join(',')})`,
    ...ids,
  );
  return new Map(rows.map((r) => [r.ask_id, r]));
}

export async function claimAsk(askId: string, by: string, nowIso: string): Promise<void> {
  await getDb().run(
    `INSERT INTO open_ask_marks (ask_id, claimed_by, claimed_at) VALUES (?, ?, ?)
     ON CONFLICT(ask_id) DO UPDATE SET claimed_by = excluded.claimed_by, claimed_at = excluded.claimed_at`,
    askId,
    by,
    nowIso,
  );
}

export async function resolveAsk(askId: string, reason: string, by: string, nowIso: string): Promise<void> {
  await getDb().run(
    `INSERT INTO open_ask_marks (ask_id, resolved_by, resolved_at, resolution) VALUES (?, ?, ?, ?)
     ON CONFLICT(ask_id) DO UPDATE SET resolved_by = excluded.resolved_by, resolved_at = excluded.resolved_at,
       resolution = excluded.resolution`,
    askId,
    by,
    nowIso,
    reason,
  );
}

export async function stampAlerts(
  askIds: string[],
  column: 'alerted_at' | 'reminded_at',
  nowIso: string,
): Promise<void> {
  for (const askId of askIds) {
    await getDb().run(
      `INSERT INTO open_ask_marks (ask_id, ${column}) VALUES (?, ?)
       ON CONFLICT(ask_id) DO UPDATE SET ${column} = excluded.${column}`,
      askId,
      nowIso,
    );
  }
}

export async function backstopSinceMs(): Promise<number | null> {
  const row = await getDb().get<{ applied: string }>(
    `SELECT applied FROM schema_version WHERE name = ?`,
    OPEN_ASK_MARKS_MIGRATION,
  );
  return parseUtcTimestampMs(row?.applied ?? null);
}
