/**
 * The one generator of titles, Haiku on a sweep. Each tick picks up to {@link CONCURRENCY_CAP} titles to generate:
 * unsettled threads first (src/thread-title.ts), whose title goes to the thread's row and platform, then a refresh for
 * a session whose title is older than the cooldown AND behind at least REFRESH_MIN_NEW_MESSAGES new messages, then
 * sessions with no title. A sweep rather than on-write keeps LLM cost bounded; a stale title beats a churning one.
 */
import { getDb } from '../db/connection.js';
import { isTaskThread } from '../db/sessions.js';
import {
  listUnsettledThreadsDue,
  stampThreadTitleTurn,
  UNSETTLED_ROW_SQL,
  unsettledSince,
  type UnsettledThread,
} from '../db/thread-titles.js';
import { shownThreadTitle } from '../generated-title.js';
import { log } from '../log.js';
import { readSessionInbound, readSessionOutbound, type MessageTailRow } from '../modules/mailbox/index.js';
import { callHaiku, claudeCliAvailable, listClaudeStructuredCredentialSlots } from '../llm.js';
import { applyThreadTitle, threadTitleDue, threadTitleLabel } from '../thread-title.js';
import {
  inboundTurn,
  keepUnlessChanged,
  outboundTurn,
  TITLE_SYSTEM_PROMPT,
  titleInput,
  titlePrompt,
  type TitleInput,
  type TitleTurn,
} from '../title-input.js';

// Candidates per tick. They run one at a time: concurrent bursts from this sweep tripped the keys' rate limits.
export const CONCURRENCY_CAP = 3;
export const COOLDOWN_HOURS = 1;
export const REFRESH_MIN_NEW_MESSAGES = 10;
const FAILURE_BACKOFF_MINUTES = 15;
const AWAITING_REPLY_BACKOFF_MINUTES = 2;
const REFRESH_SLOTS_PER_TICK = 1;
const REFRESH_ACTIVE_WITHIN_HOURS = 24;
const SCAN_ROWS = CONCURRENCY_CAP * 4;
export const THREAD_SCAN_ROWS = CONCURRENCY_CAP * 16;
const SLICE_HEAD_ROWS = 12;
const SLICE_TAIL_ROWS = 24;
const MAX_THREAD_SESSIONS = 4;
const HAIKU_MAX_TITLE_CHARS = 60;
const HAIKU_TIMEOUT_MS = 6000;

interface CandidateRow {
  id: string;
  agent_group_id: string;
  thread_id: string | null;
  title: string | null;
  title_generated_at: string | null;
  title_basis_seq: number | null;
}

export type TitleBackendFn = (system: string, user: string) => Promise<string>;

let _backendOverride: TitleBackendFn | null = null;

export function setTitleBackendForTest(fn: TitleBackendFn | null): void {
  _backendOverride = fn;
}

export function _resetTitleBackendForTest(): void {
  _backendOverride = null;
}

/**
 * Sweep-level cooldown engaged by the circuit breaker. The per-tick breaker only de-duplicates log lines; this is
 * what actually stops doomed calls during a sustained 429 window.
 */
export const BREAKER_COOLDOWN_BASE_MS = 5 * 60_000;
export const BREAKER_COOLDOWN_CAP_MS = 30 * 60_000;

let _cooldownUntilMs = 0;
/**
 * Duration of the most recent cooldown, 0 when none or after a success. Doubles (capped) when the first batch after a
 * cooldown trips again.
 */
let _lastCooldownMs = 0;

function isCoolingDown(nowMs: number): boolean {
  return nowMs < _cooldownUntilMs;
}

function engageCooldown(nowMs: number): void {
  const cooldownMs =
    _lastCooldownMs > 0 ? Math.min(BREAKER_COOLDOWN_CAP_MS, _lastCooldownMs * 2) : BREAKER_COOLDOWN_BASE_MS;
  _lastCooldownMs = cooldownMs;
  _cooldownUntilMs = nowMs + cooldownMs;
  log.warn('session-title: circuit breaker cooldown engaged — suppressing sweep', {
    cooldownMs,
    untilIso: new Date(_cooldownUntilMs).toISOString(),
  });
}

function resetCooldownEscalation(): void {
  _lastCooldownMs = 0;
}

/** Test-only: clears cooldown state between tests. */
export function _resetCooldownForTest(): void {
  _cooldownUntilMs = 0;
  _lastCooldownMs = 0;
  refreshScanOffset = 0;
  threadScanOffset = 0;
}

export function _getCooldownStateForTest(): { cooldownUntilMs: number; lastCooldownMs: number } {
  return { cooldownUntilMs: _cooldownUntilMs, lastCooldownMs: _lastCooldownMs };
}

/**
 * True when the claude CLI is on PATH and ANY configured credential slot exists, resolved through the same
 * {@link listClaudeStructuredCredentialSlots} the request path rotates across, so "configured" and "what gets tried"
 * cannot drift. The test override always counts as configured.
 */
export function isBackendConfigured(): boolean {
  if (_backendOverride !== null) return true;
  return claudeCliAvailable() && listClaudeStructuredCredentialSlots().length > 0;
}

let _missingBackendLogged = false;

/** The test override is one direct call raced against its own timeout. */
async function callTitleBackend(system: string, user: string): Promise<string> {
  if (_backendOverride !== null) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), HAIKU_TIMEOUT_MS);
    try {
      return await Promise.race([
        _backendOverride(system, user),
        new Promise<never>((_, reject) => {
          if (controller.signal.aborted) reject(new Error('aborted'));
          controller.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return callHaiku(user, {
    system,
    timeoutMs: HAIKU_TIMEOUT_MS,
    model: process.env['NANOCLAW_SESSION_TITLE_MODEL'],
  });
}

/** Strips quotes, "Title: " preambles and trailing periods, and caps at {@link HAIKU_MAX_TITLE_CHARS}. */
export function postProcessTitle(raw: string): string {
  let s = raw.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    s = s.slice(1, -1).trim();
  }
  s = s.replace(/^(title:|topic:|label:)\s*/i, '');
  s = s.replace(/\.+$/, '');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, HAIKU_MAX_TITLE_CHARS);
}

const CANDIDATE_COLUMNS = 's.id, s.agent_group_id, s.thread_id, s.title, s.title_generated_at, s.title_basis_seq';

function pickUntitled(): Promise<CandidateRow[]> {
  const nowMs = Date.now();
  const cooldownIso = new Date(nowMs - COOLDOWN_HOURS * 3600_000).toISOString();
  // Gate on `title_generated_at` so a failure-backoff stamp keeps a NULL-title row out. ORDER is load-bearing: most
  // recently active first. Oldest-first picks empty shells that are skipped every tick, starving every real session
  // forever.
  return getDb().all<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS}
       FROM sessions s
      WHERE s.status = 'active'
        AND s.title IS NULL
        AND (s.title_generated_at IS NULL OR s.title_generated_at < ?)
        AND NOT EXISTS (SELECT 1 FROM thread_titles t WHERE t.thread_id = s.thread_id AND ${UNSETTLED_ROW_SQL})
      ORDER BY COALESCE(s.last_active, s.created_at) DESC
      LIMIT ?`,
    cooldownIso,
    ...unsettledSince(nowMs),
    SCAN_ROWS,
  );
}

/**
 * Where the refresh scan resumes. Most of these rows sit under the new-message floor, which only their session DBs can
 * tell, so a fixed window would stay full of them and hide every row behind it.
 */
let refreshScanOffset = 0;

/**
 * Where the thread scan resumes. Rows with nothing new stay in the query, so a fixed window would hide every thread
 * behind them; a page that fills the slots is read again, because its served rows drop out of it.
 */
let threadScanOffset = 0;

async function pickRefreshes(): Promise<CandidateRow[]> {
  const nowMs = Date.now();
  const rows = await getDb().all<CandidateRow>(
    `SELECT ${CANDIDATE_COLUMNS}
       FROM sessions s
      WHERE s.status = 'active'
        AND s.title IS NOT NULL
        AND COALESCE(s.thread_id, '') NOT LIKE 'system:%'
        AND (s.title_generated_at IS NULL OR s.title_generated_at < ?)
        AND datetime(s.last_active) >= datetime(?)
        AND (s.title_generated_at IS NULL OR datetime(s.last_active) > datetime(s.title_generated_at))
        AND NOT EXISTS (SELECT 1 FROM thread_titles t
                         WHERE t.thread_id = s.thread_id AND (t.title IS NOT NULL OR ${UNSETTLED_ROW_SQL}))
      ORDER BY s.last_active DESC
      LIMIT ? OFFSET ?`,
    new Date(nowMs - COOLDOWN_HOURS * 3600_000).toISOString(),
    new Date(nowMs - REFRESH_ACTIVE_WITHIN_HOURS * 3600_000).toISOString(),
    ...unsettledSince(nowMs),
    SCAN_ROWS,
    refreshScanOffset,
  );
  refreshScanOffset = rows.length < SCAN_ROWS ? 0 : refreshScanOffset + SCAN_ROWS;
  return rows;
}

interface ThreadSession {
  id: string;
  agent_group_id: string;
  thread_id: string;
  title: string | null;
  title_generated_at: string | null;
}

function listThreadSessions(threadId: string): Promise<ThreadSession[]> {
  return getDb().all<ThreadSession>(
    `SELECT id, agent_group_id, thread_id, title, title_generated_at
       FROM sessions
      WHERE thread_id = ? AND status = 'active'
      ORDER BY COALESCE(last_active, created_at) DESC
      LIMIT ?`,
    threadId,
    MAX_THREAD_SESSIONS,
  );
}

interface SliceResult {
  turns: TitleTurn[];
  maxSeq: number;
  /**
   * True when no inbound row has `trigger = 1`: the session never woke the agent (e.g. bot notifications into a
   * `mention`-mode channel), so there is nothing to summarize. A later real wake flips it back.
   */
  neverWoken: boolean;
}

function turnsFrom(
  sessionId: string,
  rows: MessageTailRow[],
  toTurn: (row: MessageTailRow) => TitleTurn | null,
): TitleTurn[] {
  return rows.flatMap((row) => {
    try {
      return toTurn(row) ?? [];
    } catch (err) {
      log.warn('session-title: skipped an unreadable row', { sessionId, seq: row.seq, err });
      return [];
    }
  });
}

/**
 * A session's opening rows and its latest ones as title turns. `maxSeq` is -1 for a session with no rows ("skip for
 * now"). Best-effort: IO failures return an empty slice.
 */
function readSessionSlice(agentGroupId: string, sessionId: string, threadId: string | null): SliceResult {
  const location = { agentGroupId, sessionId };

  let inboundRows: MessageTailRow[] = [];
  let outboundRows: MessageTailRow[] = [];
  let outboundTail: MessageTailRow[] = [];
  let neverWoken = false;

  try {
    readSessionInbound(location, (mailbox) => {
      inboundRows = [...mailbox.listInboundHead(SLICE_HEAD_ROWS), ...mailbox.listInboundTail(SLICE_TAIL_ROWS)];
      // A missing `trigger` column on an old DB fails closed to "has woken": it must never suppress a real title or
      // trip the read-failed warning.
      try {
        neverWoken = !mailbox.hasTriggeredInboundRow();
      } catch {
        neverWoken = false;
      }
    });
  } catch (err) {
    log.warn('session-title: inbound.db read failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    readSessionOutbound(location, (mailbox) => {
      outboundRows = mailbox.listOutboundChatHead(SLICE_HEAD_ROWS, isTaskThread(threadId) ? null : threadId);
      outboundTail = mailbox.listOutboundTail(1);
    });
  } catch (err) {
    log.warn('session-title: outbound.db read failed', {
      sessionId,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  return {
    turns: [...turnsFrom(sessionId, inboundRows, inboundTurn), ...turnsFrom(sessionId, outboundRows, outboundTurn)],
    maxSeq: Math.max(-1, ...[...inboundRows, ...outboundTail].map((row) => row.seq)),
    neverWoken,
  };
}

function threadInput(slice: SliceResult, sessions: ThreadSession[], sessionId: string): TitleInput {
  const others = sessions.filter((session) => session.id !== sessionId);
  const turns = others.flatMap(
    (session) => readSessionSlice(session.agent_group_id, session.id, session.thread_id).turns,
  );
  return titleInput([...slice.turns, ...turns], Date.now());
}

async function persistTitle(sessionId: string, title: string, basisSeq: number, generatedAt: string): Promise<void> {
  await getDb().run(
    `UPDATE sessions
        SET title = ?,
            title_generated_at = ?,
            title_basis_seq = ?
      WHERE id = ?`,
    title,
    generatedAt,
    basisSeq,
    sessionId,
  );
}

async function forgetTitleBasis(sessionId: string): Promise<void> {
  await getDb().run(`UPDATE sessions SET title_basis_seq = NULL WHERE id = ?`, sessionId);
}

function carryTitleToThread(thread: UnsettledThread, title: string): void {
  void applyThreadTitle(thread, title)
    .then((applied) => (applied ? undefined : forgetTitleBasis(thread.session_id)))
    .catch((err: unknown) => log.warn('session-title: thread title update failed', { err }));
}

/**
 * Stamps `title_generated_at` so the cooldown predicate hides the row for FAILURE_BACKOFF_MINUTES; otherwise a
 * session that keeps failing is re-picked every tick and starves fresher ones. Never writes a fake `title`: NULL is
 * the truth.
 */
async function stampFailureBackoff(sessionId: string, minutes = FAILURE_BACKOFF_MINUTES): Promise<void> {
  const stamp = new Date(Date.now() - (COOLDOWN_HOURS * 60 - minutes) * 60_000).toISOString();
  await getDb().run(`UPDATE sessions SET title_generated_at = ? WHERE id = ?`, stamp, sessionId);
}

/** True if the title should be (re)generated. */
function shouldGenerate(row: CandidateRow, sliceMaxSeq: number): boolean {
  if (sliceMaxSeq < 0) return false;
  if (!row.title) return true;
  if (row.title_basis_seq == null) return true;
  if (sliceMaxSeq - row.title_basis_seq < REFRESH_MIN_NEW_MESSAGES) return false;
  return true;
}

/** One sweep tick. Each candidate is independently try/caught so one backend failure does not poison the batch. */
// Re-entrancy guard: a slow response must not overlap a second batch on the next tick.
let sweepInProgress = false;

export async function runSessionTitleSweep(): Promise<{ generated: number; skipped: number }> {
  if (sweepInProgress) return { generated: 0, skipped: 0 };
  sweepInProgress = true;
  try {
    return await _runSessionTitleSweepLocked();
  } finally {
    sweepInProgress = false;
  }
}

async function _runSessionTitleSweepLocked(): Promise<{ generated: number; skipped: number }> {
  // Fail closed with no backend: otherwise every tick burns doomed calls and failure stamps. Logged once per process.
  if (!isBackendConfigured()) {
    if (!_missingBackendLogged) {
      _missingBackendLogged = true;
      log.info(
        'session-title: no title backend — sweep is a no-op. It needs CLAUDE_CODE_OAUTH_TOKEN (or ANTHROPIC_API_KEY) in .env and the claude CLI on PATH (setup/install-claude.sh).',
      );
    }
    return { generated: 0, skipped: 0 };
  }

  // Fail closed during the breaker cooldown: a rate-limited but configured credential produces the same waste.
  if (isCoolingDown(Date.now())) {
    return { generated: 0, skipped: 0 };
  }

  let generated = 0;
  let skipped = 0;
  const tasks: Array<() => Promise<TaskOutcome>> = [];

  const titleTask = (
    sessionId: string,
    input: string,
    currentLabel: string | null,
    basisSeq: number,
    onTitle?: (title: string) => void,
  ): (() => Promise<TaskOutcome>) => {
    return async () => {
      try {
        const raw = await callTitleBackend(TITLE_SYSTEM_PROMPT, titlePrompt(currentLabel, input));
        const title = keepUnlessChanged(currentLabel, postProcessTitle(raw));
        if (!title) {
          await stampFailureBackoff(sessionId);
          skipped++;
          return { sessionId, ok: true };
        }
        await persistTitle(sessionId, title, basisSeq, new Date().toISOString());
        generated++;
        onTitle?.(title);
        return { sessionId, ok: true };
      } catch (err) {
        try {
          await stampFailureBackoff(sessionId);
        } catch {
          /* stamp failure is non-fatal — next tick will retry */
        }
        skipped++;
        return {
          sessionId,
          ok: false,
          transient: isTransientBackendFailure(err),
          errMessage: err instanceof Error ? err.message : String(err),
        };
      }
    };
  };

  const seenThreads = new Set<string>();
  const threadRows = await listUnsettledThreadsDue(Date.now(), THREAD_SCAN_ROWS, threadScanOffset);
  for (const thread of threadRows) {
    if (tasks.length >= CONCURRENCY_CAP) break;
    if (seenThreads.has(thread.thread_id)) continue;
    const slice = readSessionSlice(thread.agent_group_id, thread.session_id, thread.thread_id);
    if (slice.maxSeq < 0 || slice.turns.length === 0 || slice.neverWoken) continue;
    seenThreads.add(thread.thread_id);
    if (!threadTitleDue(thread, slice.maxSeq)) continue;
    const sessions = await listThreadSessions(thread.thread_id);
    const input = threadInput(slice, sessions, thread.session_id);
    if (input.awaitingReply) continue;
    await stampThreadTitleTurn(thread.thread_id, Date.now());
    tasks.push(
      titleTask(thread.session_id, input.text, threadTitleLabel(thread), slice.maxSeq, (title) =>
        carryTitleToThread(thread, title),
      ),
    );
  }

  threadScanOffset =
    threadRows.length < THREAD_SCAN_ROWS
      ? 0
      : tasks.length < CONCURRENCY_CAP
        ? threadScanOffset + THREAD_SCAN_ROWS
        : threadScanOffset;

  const stepAside = async (sessionId: string, minutes?: number): Promise<void> => {
    try {
      await stampFailureBackoff(sessionId, minutes);
    } catch {
      /* stamp failure is non-fatal — next tick will retry */
    }
    skipped++;
  };

  const takeSession = async (row: CandidateRow): Promise<boolean> => {
    const slice = readSessionSlice(row.agent_group_id, row.id, row.thread_id);
    // Empty, contentless, or never-woken session: stamp a backoff so it leaves the candidate pool, or a backlog of
    // such shells occupies the LIMIT and starves real sessions forever. A stamped shell that later gains content
    // re-enters after the cooldown.
    if (slice.maxSeq < 0 || slice.turns.length === 0 || slice.neverWoken) {
      await stepAside(row.id);
      return false;
    }
    // Not enough new messages: leave it on its natural cooldown; re-stamping would churn its refresh clock.
    if (!shouldGenerate(row, slice.maxSeq)) {
      skipped++;
      return false;
    }
    const sessions = row.thread_id ? await listThreadSessions(row.thread_id) : [];
    const input = threadInput(slice, sessions, row.id);
    if (input.awaitingReply) {
      await stepAside(row.id, AWAITING_REPLY_BACKOFF_MINUTES);
      return false;
    }
    const label = shownThreadTitle(null, [row, ...sessions], () => 0);
    tasks.push(titleTask(row.id, input.text, label, slice.maxSeq));
    return true;
  };

  let refreshSlots = REFRESH_SLOTS_PER_TICK;
  for (const row of await pickRefreshes()) {
    if (refreshSlots === 0 || tasks.length >= CONCURRENCY_CAP) break;
    if (await takeSession(row)) refreshSlots--;
  }

  for (const row of await pickUntitled()) {
    if (tasks.length >= CONCURRENCY_CAP) break;
    await takeSession(row);
  }

  const outcomes: TaskOutcome[] = [];
  for (const task of tasks) outcomes.push(await task());
  const breakerTripped = logFailuresWithBreaker(outcomes);

  // A success proves the backend is not fully rate-limited, so the escalation resets; a trip (only possible when the
  // whole batch failed) engages the cooldown.
  if (generated > 0) {
    resetCooldownEscalation();
  } else if (breakerTripped) {
    engageCooldown(Date.now());
  }

  return { generated, skipped };
}

interface TaskOutcome {
  sessionId: string;
  ok: boolean;
  transient?: boolean;
  errMessage?: string;
}

/**
 * A run of this many consecutive transient failures, in candidate order, collapses into one warn instead of one per
 * candidate. Non-transient failures are always logged individually.
 */
const BREAKER_CONSECUTIVE_FAILURES = 3;

function logFailuresWithBreaker(outcomes: TaskOutcome[]): boolean {
  // Each run is buffered and logged once it ends; runs shorter than the threshold log individually.
  let run: TaskOutcome[] = [];
  let tripped = false;

  const flushRun = (): void => {
    if (run.length === 0) return;
    if (run.length >= BREAKER_CONSECUTIVE_FAILURES) {
      tripped = true;
      log.warn(
        'session-title: circuit breaker tripped — consecutive transient failures this tick, abandoning rest of batch',
        { consecutiveTransientFailures: run.length, sessionIds: run.map((o) => o.sessionId) },
      );
    } else {
      for (const o of run) {
        log.warn('session-title: backend call failed', { sessionId: o.sessionId, err: o.errMessage });
      }
    }
    run = [];
  };

  for (const outcome of outcomes) {
    if (outcome.ok) {
      flushRun();
      continue;
    }
    if (!outcome.transient) {
      flushRun();
      log.warn('session-title: backend call failed', { sessionId: outcome.sessionId, err: outcome.errMessage });
      continue;
    }
    run.push(outcome);
  }
  flushRun();
  return tripped;
}

function isTransientBackendFailure(err: unknown): boolean {
  const status = (err as { status?: number }).status;
  return status === 429 || status === 529 || (err as Error).name === 'AbortError' || !status;
}
