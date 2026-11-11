/**
 * Steer write path for `POST /dashboard/api/sessions/:id/message`: validation, scope filter, role gate, per-(user,
 * child) rate limit, reserve-before-write idempotency, partial-write recovery, SSE emit, wake, and a fire-and-forget
 * echo to the originating chat thread.
 */
import { randomUUID } from 'crypto';
import { createHash } from 'crypto';

import { withCentralSync } from '../db/central-lease.js';
import { getSession, taskSeriesId } from '../db/sessions.js';
import { getMessagingGroup } from '../db/messaging-groups.js';
import { getAgentGroup } from '../db/agent-groups.js';
import {
  parseSessionMessageFlags,
  postFlagNotice,
  withMessageFlags,
  type FlagNoticeAddress,
  type ParsedMessageFlags,
} from '../message-flags.js';
import type { Session } from '../types.js';
import { log } from '../log.js';
import { SessionWriteRefusedError, withExistingMailboxSession, writeSessionMessage } from '../session-manager.js';
import { readSessionInbound } from '../modules/mailbox/index.js';
import { requestWake } from '../request-wake.js';
import { sessionStillActive, unwakeableReason } from '../container-runner.js';
import { getChannelAdapter } from '../channels/channel-registry.js';
import { isOwner, isGlobalAdmin, isAdminOfAgentGroup } from '../modules/permissions/db/user-roles.js';
import { isMember } from '../modules/permissions/db/agent-group-members.js';
import {
  reserveIdempotency,
  applyIdempotency,
  claimEchoAttempted,
  hasSteerReservation,
  IdempotencyConflict,
  type SteerResponse,
  type SteerTarget,
} from './db/steer-idempotency.js';
import { emitDashboardEvent } from './api/events.js';
import type { AuthHandler, AuthedRequestContext } from './router.js';

interface RateWindow {
  count: number;
  windowStart: number;
}

const rateLimitMap = new Map<string, RateWindow>();
const RATE_LIMIT_MAX = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Soft cap that triggers a sweep of expired windows, so the per-(user, session) map cannot grow unbounded over the
// host's lifetime.
const RATE_LIMIT_MAP_SOFT_CAP = 1024;

function _sweepExpiredRateWindows(now: number): void {
  for (const [key, entry] of rateLimitMap) {
    if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
      rateLimitMap.delete(key);
    }
  }
}

function checkRateLimit(key: string): { allowed: boolean; retryAfter?: number } {
  const now = Date.now();
  if (rateLimitMap.size > RATE_LIMIT_MAP_SOFT_CAP) {
    _sweepExpiredRateWindows(now);
  }
  const entry = rateLimitMap.get(key);
  if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    rateLimitMap.set(key, { count: 1, windowStart: now });
    return { allowed: true };
  }
  if (entry.count >= RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil((RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { allowed: false, retryAfter: Math.max(1, retryAfter) };
  }
  entry.count++;
  return { allowed: true };
}

function refundRateLimit(key: string): void {
  const entry = rateLimitMap.get(key);
  if (entry && entry.count > 0) entry.count--;
}

export function _resetRateLimitForTesting(): void {
  rateLimitMap.clear();
}

/**
 * `thread-message.ts` must run this BEFORE resolving a session: resolving can CREATE a session row, a side effect a
 * caller who cannot steer must never cause.
 */
export function canSteer(userId: string, agentGroupId: string): Promise<{ ok: boolean; reason?: string }> {
  // Lease-only role predicates; one block for the whole decision.
  return withCentralSync((): { ok: boolean; reason?: string } => {
    if (isOwner(userId) || isGlobalAdmin(userId) || isAdminOfAgentGroup(userId, agentGroupId)) {
      return { ok: true };
    }
    if (isMember(userId, agentGroupId)) {
      return { ok: false, reason: 'member_role_cannot_steer' };
    }
    return { ok: false, reason: 'not_found' };
  }, 'canSteer');
}

type SteerStatus = 202 | 400 | 403 | 404 | 409 | 422 | 429 | 503;
type SteerResult = { status: SteerStatus; body: Record<string, unknown> };

interface EchoConfig {
  kind: 'thread' | 'headless';
  messagingGroupId?: string;
  platformThreadId?: string;
}

interface SteerExecution {
  target: SteerTarget;
  // Scope check and SSE routing. Tasks: parent_agent_group_id; sessions: agent_group_id.
  agentGroupId: string;
  // Tasks: task.child_session_id; sessions: the session itself.
  childAgentGroupId: string;
  childSessionId: string;
  // Sessions with a null messaging group are headless (no echo).
  echo: EchoConfig;
  onWrite?: () => void;
  envelope: Record<string, unknown>;
}

async function _writeAndEchoSteer(
  exec: SteerExecution,
  body: { idempotency_key: string; text: string },
  ctx: AuthedRequestContext,
): Promise<SteerResult> {
  const userId = ctx.user.id;
  const displayName = ctx.user.display_name ?? userId;
  const text = body.text;
  const idempotencyKey = body.idempotency_key;

  if (!text || !text.trim()) return { status: 400, body: { error: 'empty_message' } };
  if (text.length > 4000) return { status: 400, body: { error: 'message_too_long' } };

  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(exec.agentGroupId)) {
    return { status: 404, body: { error: 'not_found' } };
  }

  // Same not-found shape as the scope filter.
  const roleCheck = await canSteer(userId, exec.agentGroupId);
  if (!roleCheck.ok) {
    return { status: 404, body: { error: 'not_found' } };
  }

  // A row written to a session that cannot wake is never read. A new key is refused before it is reserved; a known
  // key goes on, so an applied request still replays its 202 and a pending one meets the guard at the insert.
  const unwakeable = unwakeableReason(await getSession(exec.childSessionId));
  if (unwakeable && !(await hasSteerReservation(userId, idempotencyKey))) {
    return { status: 409, body: { error: 'session_cannot_wake', reason: unwakeable } };
  }

  const rateLimitKey = `${userId}:${exec.childSessionId}`;
  const rateCheck = checkRateLimit(rateLimitKey);
  if (!rateCheck.allowed) {
    return { status: 429, body: { error: 'rate_limit_exceeded', retry_after: rateCheck.retryAfter } };
  }

  const trimmedText = text.trim();
  const requestHash = createHash('sha256').update(trimmedText).digest('hex');
  const messageId = randomUUID();

  let reserved: Awaited<ReturnType<typeof reserveIdempotency>>;
  try {
    reserved = await reserveIdempotency(userId, idempotencyKey, exec.target, messageId, trimmedText, requestHash);
  } catch (err) {
    if (err instanceof IdempotencyConflict) {
      refundRateLimit(rateLimitKey);
      return {
        status: 422,
        body: { error: 'mismatched_idempotency_payload', conflict_kind: err.conflictKind },
      };
    }
    throw err;
  }

  if (reserved.status === 'applied' && reserved.cached) {
    // Echo recovery on idempotent replay: a crash between reservation and the echo schedule leaves `echo_attempted` 0
    // and the chat never sees the message. The single CAS prevents a double echo.
    if (!reserved.echoAttempted && (await claimEchoAttempted(reserved.id))) {
      setImmediate(() => {
        void (async () => {
          try {
            await _fireEchoAsync(exec, trimmedText, displayName);
          } catch {
            // outer catch covers sync throws — claim already committed
          }
        })();
      });
    }
    return { status: 202, body: _responseShapeForTarget(reserved.cached) };
  }

  const resolvedMessageId = reserved.messageId;
  // Partial-write recovery probe through the read-only seam: no provisioning or migrating. `undefined` means not
  // there yet. `recoverJournal` rolls back a hot journal from an interrupted host write; the 5s busy_timeout matters
  // because a false "not there" costs a duplicate insert.
  const inboundExists =
    readSessionInbound(
      { agentGroupId: exec.childAgentGroupId, sessionId: exec.childSessionId },
      (mailbox) => mailbox.inboundHasMessage(resolvedMessageId),
      { busyTimeoutMs: 5000, recoverJournal: true },
    ) ?? false;

  const steerFlags = await _parseSteerFlags(exec.childSessionId, trimmedText);
  if (!inboundExists) {
    const now = new Date().toISOString();
    const content = withMessageFlags(
      JSON.stringify({
        text: trimmedText,
        sender: displayName,
        _via: 'dashboard',
        _steer: exec.envelope,
      }),
      steerFlags?.parsed.flags ?? { cleanedText: null },
    );
    try {
      await writeSessionMessage(
        exec.childAgentGroupId,
        exec.childSessionId,
        {
          id: resolvedMessageId,
          kind: 'chat',
          timestamp: now,
          content,
          trigger: 1,
        },
        { guard: sessionStillActive(exec.childSessionId) },
      );
    } catch (err: unknown) {
      // The session can close or start archiving after the check above; the writer then refuses before inserting. The
      // reservation stays pending: same-key requests share it, and one still waiting on the writer may yet land.
      const refusal =
        err instanceof SessionWriteRefusedError ? err.reason : unwakeableReason(await getSession(exec.childSessionId));
      const code = (err as { code?: string }).code;
      if (refusal) {
        refundRateLimit(rateLimitKey);
        return { status: 409, body: { error: 'session_cannot_wake', reason: refusal } };
      } else if (code === 'SQLITE_CONSTRAINT_PRIMARYKEY' || code === 'SQLITE_CONSTRAINT_UNIQUE') {
        // Concurrent-retry race (PK on id, UNIQUE on seq) — treat as success.
      } else if (code === 'SQLITE_BUSY') {
        refundRateLimit(rateLimitKey);
        return { status: 503, body: { error: 'db_busy', retry_after: 2 } };
      } else {
        refundRateLimit(rateLimitKey);
        throw err;
      }
    }
  }
  // Only once the row is in: a refused write must not leave the room told about settings that never applied.
  if (steerFlags?.parsed.notice) {
    await postFlagNotice(
      steerFlags.session,
      steerFlags.parsed.notice,
      await _steerNoticeAddress(steerFlags.session),
      `flag-${resolvedMessageId}`,
    );
  }

  if (exec.onWrite) {
    try {
      exec.onWrite();
    } catch (err) {
      log.warn('steer: onWrite hook failed — non-fatal', {
        target: exec.target,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  try {
    emitDashboardEvent('inbound_message', {
      task_id: exec.target.type === 'task' ? exec.target.id : '',
      child_session_id: exec.childSessionId,
      parent_agent_group_id: exec.agentGroupId,
      message_id: resolvedMessageId,
    });
  } catch {
    // non-fatal
  }

  const childSession = await getSession(exec.childSessionId);
  if (childSession) {
    void requestWake(childSession, 'inbound-message').catch((err) =>
      log.warn('steer: wakeContainer failed', { target: exec.target, err }),
    );
  }

  const steerResponse: SteerResponse = {
    target_type: exec.target.type,
    target_id: exec.target.id,
    message_id: resolvedMessageId,
    echo_status: 'pending',
  };
  await applyIdempotency(userId, idempotencyKey, steerResponse);

  if (await claimEchoAttempted(reserved.id)) {
    setImmediate(() => {
      void (async () => {
        try {
          await _fireEchoAsync(exec, trimmedText, displayName);
        } catch {
          // outer catch covers sync throws — claim already committed; nothing to roll back
        }
      })();
    });
  }

  return { status: 202, body: _responseShapeForTarget(steerResponse) };
}

/**
 * A steer is a person's message, so it carries `-m`/`-e`/`-f` the way a typed one does. The notice goes to the room the
 * session's answers reach: its chat, or for a task session (no chat of its own) the room its series was routed to.
 */
async function _parseSteerFlags(
  sessionId: string,
  text: string,
): Promise<{ session: Session; parsed: ParsedMessageFlags } | null> {
  const session = await getSession(sessionId);
  if (!session) return null;
  const agentGroupProvider = (await getAgentGroup(session.agent_group_id))?.agent_provider;
  return { session, parsed: await parseSessionMessageFlags(session, agentGroupProvider, text) };
}

async function _steerNoticeAddress(session: Session): Promise<FlagNoticeAddress> {
  const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  if (mg) return { channelType: mg.channel_type, platformId: mg.platform_id, threadId: session.thread_id };
  const seriesId = taskSeriesId(session.thread_id);
  const stamp = seriesId
    ? await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
        mailbox.getLatestRoutedTaskRow(seriesId),
      )
    : null;
  // Thread left to delivery, which continues the series' stamped thread as it does for the agent's own posts.
  return stamp
    ? { channelType: stamp.channel_type, platformId: stamp.platform_id, threadId: null }
    : { channelType: null, platformId: null, threadId: session.thread_id };
}

/** The task endpoint's body carries `task_id`, the session endpoint's `session_id`. */
function _responseShapeForTarget(r: SteerResponse): Record<string, unknown> {
  const base: Record<string, unknown> = {
    target_type: r.target_type,
    target_id: r.target_id,
    message_id: r.message_id,
    echo_status: r.echo_status,
  };
  if (r.target_type === 'task') base['task_id'] = r.target_id;
  else base['session_id'] = r.target_id;
  return base;
}

async function _fireEchoAsync(exec: SteerExecution, text: string, displayName: string): Promise<void> {
  if (exec.echo.kind !== 'thread' || !exec.echo.messagingGroupId || !exec.echo.platformThreadId) {
    await _emitEchoStatus('skipped_headless', exec);
    return;
  }

  const mg = await getMessagingGroup(exec.echo.messagingGroupId);
  if (!mg) {
    await _emitEchoStatus('adapter_unavailable', exec);
    return;
  }

  const adapter = getChannelAdapter(mg.channel_type);
  if (!adapter || typeof adapter.deliver !== 'function') {
    await _emitEchoStatus('adapter_unavailable', exec);
    return;
  }

  try {
    await adapter.deliver(mg.platform_id, exec.echo.platformThreadId, {
      kind: 'chat',
      content: { text: `[via dashboard] ${text} — ${displayName}` },
    });
    await _emitEchoStatus('echoed', exec);
  } catch {
    await _emitEchoStatus('echo_failed', exec);
  }
}

async function _emitEchoStatus(
  echoStatus: 'echoed' | 'echo_failed' | 'adapter_unavailable' | 'skipped_headless',
  exec: SteerExecution,
): Promise<void> {
  log.debug('steer: echo_status', { echoStatus, target: exec.target });
  if (exec.target.type === 'task') {
    emitDashboardEvent('task_event', {
      task_id: exec.target.id,
      kind: 'progress',
      agent_group_id: exec.agentGroupId,
      echo_status: echoStatus,
    });
  } else {
    emitDashboardEvent('session_event', {
      session_id: exec.target.id,
      agent_group_id: exec.agentGroupId,
      kind: 'outbound',
      outbound_kind: `dashboard-echo:${echoStatus}`,
    });
  }
}

export async function applySessionSteer(
  sessionId: string,
  body: { idempotency_key: string; text: string },
  ctx: AuthedRequestContext,
): Promise<SteerResult> {
  const session = await getSession(sessionId);
  if (!session) return { status: 404, body: { error: 'session_not_found' } };

  if (!ctx.scopes.no_filter && !ctx.scopes.allowed_group_ids.includes(session.agent_group_id)) {
    return { status: 404, body: { error: 'session_not_found' } };
  }

  // A session with no messaging group has no chat surface to echo into.
  const echo: EchoConfig = session.messaging_group_id
    ? {
        kind: 'thread',
        messagingGroupId: session.messaging_group_id,
        ...(session.thread_id ? { platformThreadId: session.thread_id } : {}),
      }
    : { kind: 'headless' };

  const result = await _writeAndEchoSteer(
    {
      target: { type: 'session', id: sessionId },
      agentGroupId: session.agent_group_id,
      childAgentGroupId: session.agent_group_id,
      childSessionId: sessionId,
      echo,
      envelope: { session_id: sessionId, user_id: ctx.user.id },
    },
    body,
    ctx,
  );

  if (result.status === 404 && result.body['error'] === 'not_found') {
    return { status: 404, body: { error: 'session_not_found' } };
  }
  return result;
}

async function _readSteerBody(req: Request): Promise<{ idempotency_key: string; text: string } | { error: Response }> {
  let body: { idempotency_key?: string; text?: string };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return {
      error: new Response(JSON.stringify({ error: 'invalid_request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }
  if (!body.idempotency_key) {
    return {
      error: new Response(JSON.stringify({ error: 'invalid_request' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      }),
    };
  }
  return { idempotency_key: body.idempotency_key, text: body.text ?? '' };
}

function _httpStatusOf(status: SteerStatus): number {
  const statusMap: Record<number, number> = {
    202: 202,
    400: 400,
    403: 403,
    404: 404,
    409: 409,
    422: 422,
    429: 429,
    503: 503,
  };
  return statusMap[status] ?? 500;
}

export const sessionMessageHandler: AuthHandler = async (req, params, ctx) => {
  const body = await _readSteerBody(req);
  if ('error' in body) return body.error;

  const sessionId = params['id'] ?? '';
  const result = await applySessionSteer(sessionId, body, ctx);
  return new Response(JSON.stringify(result.body), {
    status: _httpStatusOf(result.status),
    headers: { 'Content-Type': 'application/json' },
  });
};
