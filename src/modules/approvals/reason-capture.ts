/**
 * "Reject with reason…" capture flow.
 *
 * When an admin clicks the third approval button, the reject is held instead of
 * finalized: the row is parked at status='awaiting_reason' and the admin is
 * prompted in the card's own thread for a one-line reason. Their next message in
 * that thread (≤ 280 chars) is captured by a router message-interceptor and
 * relayed to the requesting agent as one combined message — `Your <action>
 * request was rejected by admin: "<reason>"`. A card with no thread to answer in
 * falls back to the admin's DM. Only the clicker's own reply is taken, and a
 * plain Reject never arms this, so no other message is swallowed.
 *
 * Restart-safety: arming lives in an in-memory map (lost on restart, like the
 * agent-naming capture it mirrors), but the hold is a durable DB row. If the
 * admin never replies — or the host restarts mid-capture — the host sweep
 * (sweepAwaitingReasonRejects, run each tick) finalizes a plain reject once the
 * row's window elapses, so the requesting agent is never stranded.
 *
 * Reuses, not reinvents: the agent-naming prompt-then-capture pattern
 * (in-memory map + next-DM interceptor) and the shared finalizeReject path.
 */
import type { InboundEvent } from '../../channels/adapter.js';
import { getDeliveryAdapter } from '../../delivery.js';
import {
  deletePendingApproval,
  claimExpiredReasonHold,
  getExpiredAwaitingReasonApprovals,
  getPendingApproval,
  getSession,
  markApprovalAwaitingReason,
  restartApprovalReasonWindow,
  transitionPendingApprovalStatus,
} from '../../db/sessions.js';
import { log } from '../../log.js';
import { registerMessageInterceptor } from '../../router.js';
import { replyThreads } from '../../thread-context.js';
import type { PendingApproval, Session } from '../../types.js';
import { inboundSender } from '../permissions/inbound-sender.js';
import { displayNameAcrossBots } from '../../slack-user-identity.js';
import { upsertUser } from '../permissions/db/users.js';
import { ensureUserDm } from '../permissions/user-dm.js';
import type { ApprovalCardCopy } from './card-copies.js';
import { finalizeReject, resolveClaimed } from './finalize.js';
import { editApprovalCardResolution, REJECT_WITH_REASON_VALUE } from './primitive.js';

/** How long an awaiting-reason hold waits for the admin's reply before the sweep finalizes a plain reject. */
const REASON_CAPTURE_WINDOW_MS = 5 * 60 * 1000;
/** Cap on the relayed reason — one cheap guardrail against a wall of text landing in another team's agent context. */
const MAX_REASON_LEN = 280;

const PROMPT_TEXT =
  "Reply here with a one-line reason for the rejection — I'll relay it to the agent. " +
  'No reply within ~5 min declines it without a reason.';

interface ReasonArming {
  approvalId: string;
  /** Namespaced id of the admin who clicked: only their reply is taken, and the resolution is attributed to them. */
  userId: string;
}

/**
 * Approvers waiting to type a rejection reason, keyed by where they reply and who they are
 * (`<instance>|<platformId>|<threadId>|<userId>`), so two approvers asked in one thread each keep their own capture. Cleared
 * on receipt, staleness, or restart.
 */
const awaitingReason = new Map<string, ReasonArming>();

// Sibling bots in one channel each receive their own copy of a message; only the copy reaching the card's bot counts.
function replyKey(instance: string, platformId: string, threadId: string | null, userId: string): string {
  return `${instance}|${platformId}|${threadId ?? ''}|${userId}`;
}

function clampReason(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= MAX_REASON_LEN) return trimmed;
  return trimmed.slice(0, MAX_REASON_LEN - 1) + '…';
}

function extractText(event: InboundEvent): string {
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    return typeof parsed.text === 'string' ? parsed.text : '';
  } catch {
    return '';
  }
}

export async function claimReasonHold(approval: PendingApproval): Promise<boolean> {
  const expiresAt = new Date(Date.now() + REASON_CAPTURE_WINDOW_MS).toISOString();
  return markApprovalAwaitingReason(approval.approval_id, expiresAt);
}

/**
 * Begin the reject-with-reason hold for an approval the admin chose not to
 * finalize outright, after `claimReasonHold` parked the row. Prompts where the
 * card is (see reasonTarget), then arms capture. If we can't reach the admin
 * (nowhere to ask, no adapter, delivery throws) we finalize a plain reject
 * immediately rather than strand the requesting agent.
 */
export async function armReasonCapture(
  approval: PendingApproval,
  session: Session,
  userId: string,
  onCopy?: ApprovalCardCopy,
): Promise<void> {
  const adapter = getDeliveryAdapter();
  const target = await reasonTarget(approval, userId, onCopy);
  if (!target || !adapter) {
    log.warn('reject-with-reason: cannot reach approver, finalizing plain reject', {
      approvalId: approval.approval_id,
      userId,
      hasTarget: Boolean(target),
      hasAdapter: Boolean(adapter),
    });
    if (await claimHeldReject(approval)) await finalizeReject(approval, session, userId);
    return;
  }

  try {
    await adapter.deliver(
      target.channelType,
      target.platformId,
      target.threadId,
      'chat-sdk',
      JSON.stringify({ text: PROMPT_TEXT }),
      undefined,
      target.instance,
    );
  } catch (err) {
    log.error('reject-with-reason: reason prompt delivery failed, finalizing plain reject', {
      approvalId: approval.approval_id,
      err,
    });
    if (await claimHeldReject(approval)) await finalizeReject(approval, session, userId);
    return;
  }

  // The window counts from the prompt the admin can read, not the click; a hold the sweep already closed while the
  // prompt was in flight is not re-armed.
  const expiresAt = new Date(Date.now() + REASON_CAPTURE_WINDOW_MS).toISOString();
  if (!(await restartApprovalReasonWindow(approval.approval_id, expiresAt))) return;
  // Armed before the card edit is awaited, so a reply typed during it is still captured.
  for (const threadId of target.replyThreads) {
    awaitingReason.set(replyKey(target.instance ?? target.channelType, target.platformId, threadId, userId), {
      approvalId: approval.approval_id,
      userId,
    });
  }
  // The bridge edits no card on click; without this the held card shows live
  // buttons while the approver types. finalizeReject edits it again.
  await editApprovalCardResolution(approval, REJECT_WITH_REASON_VALUE, userId);
  log.info('reject-with-reason: awaiting reason reply', {
    approvalId: approval.approval_id,
    userId,
    inThread: target.inThread,
  });
}

interface ReasonTarget {
  channelType: string;
  platformId: string;
  /** Where the prompt is posted. */
  threadId: string | null;
  /** Where a reply counts. */
  replyThreads: Array<string | null>;
  instance: string | undefined;
  inThread: boolean;
}

/**
 * Where the reason is asked for and read: the clicker's DM for an approvals-channel copy, else the DM copy that was
 * clicked, else the card's thread, else beside the card, else the approver's DM.
 */
async function reasonTarget(
  approval: PendingApproval,
  userId: string,
  onCopy: ApprovalCardCopy | undefined,
): Promise<ReasonTarget | null> {
  // The approvals channel is a queue of open cards, so a reason asked from it goes to the clicker's DM. The clicker may
  // have passed authorization as their identity on another bot and never messaged this one, which leaves no user row
  // for ensureUserDm to open the DM from.
  if (onCopy?.queue) {
    if (userId) {
      await upsertUser({
        id: userId,
        kind: onCopy.channel_type,
        display_name: await displayNameAcrossBots(userId),
        created_at: new Date().toISOString(),
      });
    }
    return dmTarget(userId);
  }
  if (onCopy) {
    return {
      channelType: onCopy.channel_type,
      platformId: onCopy.platform_id,
      threadId: null,
      replyThreads: [null],
      instance: onCopy.instance ?? onCopy.channel_type,
      inThread: false,
    };
  }
  if (approval.channel_type && approval.platform_id && (approval.thread_id || approval.platform_message_id)) {
    const located = {
      channelType: approval.channel_type,
      platformId: approval.platform_id,
      instance: approval.instance ?? approval.channel_type,
      inThread: true,
    };
    return {
      ...located,
      threadId: approval.thread_id,
      replyThreads: replyThreads(approval.platform_id, approval.thread_id, approval.platform_message_id),
    };
  }
  return dmTarget(userId);
}

async function dmTarget(userId: string): Promise<ReasonTarget | null> {
  const dm = userId ? await ensureUserDm(userId) : null;
  if (!dm) return null;
  return {
    channelType: dm.channel_type,
    platformId: dm.platform_id,
    threadId: null,
    replyThreads: [null],
    instance: undefined,
    inThread: false,
  };
}

/**
 * Router message-interceptor: capture the clicker's next message where the
 * reason was asked for. Returns true (consume the message) when it answers an
 * armed reason and the row is still live; false otherwise so normal routing runs.
 *
 * Exported for tests; registered as the interceptor below.
 */
export async function captureReasonReply(event: InboundEvent): Promise<boolean> {
  // Keyed by the sender too: someone else talking in the thread is not the reason, and their message routes as usual.
  const sender = inboundSender(event)?.userId;
  if (!sender) return false;
  // Bridges label a message outside any thread differently: Slack DMs use the message's own id, Discord DMs the
  // channel itself. Either counts as a reply beside the card.
  const outsideThread =
    event.threadId === event.platformId ||
    event.threadId === `${event.platformId}:${event.message.nativeId ?? event.message.id}`;
  const threads = outsideThread ? [event.threadId, null] : [event.threadId];
  const instance = event.instance ?? event.channelType;
  const arming = threads.map((t) => awaitingReason.get(replyKey(instance, event.platformId, t, sender))).find(Boolean);
  if (!arming) return false;

  // The clicker answered — disarm every place this approval was armed, regardless of outcome.
  for (const [key, armed] of awaitingReason) if (armed.approvalId === arming.approvalId) awaitingReason.delete(key);

  // Already finalized (e.g. ghosted by the sweep): the reply is no longer a
  // reason — let it route normally instead of swallowing it.
  const approval = await getPendingApproval(arming.approvalId);
  if (!approval) return false;
  return resolveClaimed(
    () => claimHeldReject(approval),
    async () => {
      const session = approval.session_id ? await getSession(approval.session_id) : null;
      if (!session) {
        await deletePendingApproval(approval.approval_id);
        return;
      }
      const reason = clampReason(extractText(event));
      await finalizeReject(approval, session, arming.userId, reason || undefined);
      log.info('reject-with-reason: reason captured and relayed', {
        approvalId: approval.approval_id,
        hasReason: reason.length > 0,
      });
    },
  );
}

function claimHeldReject(approval: PendingApproval): Promise<boolean> {
  return transitionPendingApprovalStatus(approval.approval_id, 'awaiting_reason', 'rejected');
}

registerMessageInterceptor(captureReasonReply);

/**
 * Host-sweep finalizer: any reject-with-reason hold whose window elapsed (admin
 * ghosted, or the host restarted mid-capture and lost the in-memory arming) is
 * finalized as a plain reject. Restart-safe — the hold is a durable row, so the
 * requesting agent always gets its decision. Called once per sweep tick.
 */
export async function sweepAwaitingReasonRejects(): Promise<void> {
  const nowIso = new Date().toISOString();
  const rows = await getExpiredAwaitingReasonApprovals(nowIso);
  for (const approval of rows) {
    await resolveClaimed(
      () => claimExpiredReasonHold(approval.approval_id, nowIso),
      async () => {
        const session = approval.session_id ? await getSession(approval.session_id) : null;
        if (!session) {
          await deletePendingApproval(approval.approval_id);
          return;
        }
        // Plain reject, unknown resolver — the admin opted in but never typed.
        await finalizeReject(approval, session, '');
        log.info('reject-with-reason: window elapsed, finalized as plain reject', { approvalId: approval.approval_id });
      },
    );
  }
}
