import { withCentralSync, withRawDb } from '../../db/central-lease.js';
import { getSession, TASKS_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { readSessionInbound } from '../mailbox/index.js';
import type { TaskDeliveryRoute } from '../mailbox/ops/reads.js';
import type { Session } from '../../types.js';
import { isOwnerSafeSlackSession } from './slack-user-token-gate.js';

const DISPATCH_THREAD_PREFIX = `${TASKS_SYSTEM_THREAD_ID}:dispatch-`;
const MAX_ORIGIN_HOPS = 2;

/**
 * Which messaging group the Slack owner-safety gate judges for this session.
 * Task sessions have no messaging group, and blanket-trusting them would let a
 * non-owner create a task that reads the owner's Slack, so a task is judged by
 * WHERE IT POSTS. A dispatched session that posts nowhere is judged by the
 * session that dispatched it: that session wrote its whole prompt and already
 * holds whatever token it is judged to hold. Every ambiguity returns null (not owner-safe).
 */
export async function resolveSlackSafetyMessagingGroupId(session: Session, hops = 0): Promise<string | null> {
  if (session.messaging_group_id) return session.messaging_group_id;

  // Per-series task sessions only: the shared `system:tasks` session mixes
  // destinations, so it has no single subject and stays fail-closed.
  if (!session.thread_id?.startsWith(`${TASKS_SYSTEM_THREAD_ID}:`)) return null;

  let read: { route: TaskDeliveryRoute | null; origin: string | null } | undefined;
  try {
    // Read-only: the spawn gate must never provision or migrate the session it
    // judges. The 5s busy timeout and journal recovery are required: without
    // them an unresolved route spawns every scheduled fire under `-noslack`.
    read = readSessionInbound(
      { agentGroupId: session.agent_group_id, sessionId: session.id },
      (mailbox) => ({
        route: mailbox.getLatestTaskDeliveryRoute(),
        origin: mailbox.getLatestTaskEvent()?.originSessionId ?? null,
      }),
      { busyTimeoutMs: 5000, recoverJournal: true },
    );
  } catch (err) {
    log.warn('Slack safety subject lookup failed for task session', { sessionId: session.id, err });
    return null;
  }

  if (!read) return null;
  const { route, origin } = read;
  if (route) {
    if (!route.channel_type) return null;
    return (await getMessagingGroupByPlatform(route.channel_type, route.platform_id))?.id ?? null;
  }

  if (!session.thread_id.startsWith(DISPATCH_THREAD_PREFIX) || !origin || hops >= MAX_ORIGIN_HOPS) return null;
  const parent = await getSession(origin);
  if (!parent || parent.status !== 'active') return null;
  if (parent.agent_group_id !== session.agent_group_id) return null;
  return resolveSlackSafetyMessagingGroupId(parent, hops + 1);
}

/** Whether this session is one the spawn would give the owner's Slack user token, judged now. */
export async function sessionIsOwnerSafe(session: Session, alsoAllowedIn: string[] | undefined): Promise<boolean> {
  const subject = await resolveSlackSafetyMessagingGroupId(session);
  return withCentralSync(
    () => withRawDb((db) => isOwnerSafeSlackSession(db, session.agent_group_id, subject, alsoAllowedIn)),
    'slack owner-safe check',
  );
}
