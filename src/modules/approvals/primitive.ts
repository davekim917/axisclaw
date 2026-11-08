/**
 * Approvals primitive — the public API that other modules call.
 *
 * Two surfaces:
 *   - `requestApproval()` — queue an approval request, deliver the card to
 *     the right admin DM, record the pending_approvals row. Used by any
 *     module that needs admin confirmation before doing something sensitive.
 *   - `registerApprovalHandler(action, handler)` — called at module import
 *     time. When the admin approves a pending row with matching `action`,
 *     the response handler dispatches into the registered callback. Optional
 *     modules (self-mod, future module gates) register here.
 *
 * Approver picking lives here too. The picks functions walk user_roles
 * (owner, global admin, scoped admin) and resolve to a reachable DM via the
 * permissions module's user-dm helper.
 *
 * Tier: default module. Permissions is an optional module, so importing from
 * it here is technically a tier inversion — but the host bundles both with
 * main, and the alternative (a third "permissions-primitive" default module
 * exposing just user-roles/user-dms) is more churn than it's worth. Revisit
 * if either module becomes genuinely optional.
 */
import { normalizeOptions, type NormalizedOption, type RawOption } from '../../channels/ask-question.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import {
  createPendingApproval,
  deletePendingApproval,
  getPendingApproval,
  getSession,
  updatePendingApprovalMessageId,
} from '../../db/sessions.js';
import { getDeliveryAdapter, settleSessionStatusAfterPublicDelivery } from '../../delivery.js';
import { requestWake } from '../../request-wake.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, PendingApproval, Session } from '../../types.js';
import { getAdminsOfAgentGroup, getGlobalAdmins, getOwners } from '../permissions/db/user-roles.js';
import { displayNameAcrossBots } from '../../slack-user-identity.js';
import { ensureUserDm, resolveUserChannelType } from '../permissions/user-dm.js';
import { cardCopies, closeCardPlace, copyPlace, type CardPlace } from './card-copies.js';

/**
 * Card value for the "Reject with reason…" button. Selecting it doesn't
 * finalize the reject — it holds the row and captures the approver's next DM
 * as a one-line reason relayed to the requesting agent. See reason-capture.ts.
 */
export const REJECT_WITH_REASON_VALUE = 'reject_with_reason';

/**
 * Three-button approval UI. Plain Reject is the instant fast path; "Reject with
 * reason…" opts into the reason-capture flow. Shared by every module approval
 * (create_agent, install_packages, add_mcp_server); OneCLI credential cards
 * keep their own two-button set in onecli-approvals.ts.
 */
const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
  { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: REJECT_WITH_REASON_VALUE },
];

// ── Approval handler registry ──
// Modules that want to be called back when an admin approves a pending row
// register here at import time, keyed by the `action` string they used in
// their `requestApproval()` calls.

export interface ApprovalHandlerContext {
  session: Session;
  payload: Record<string, unknown>;
  /**
   * The verified approval row — the grant an approved continuation carries
   * when it re-enters its guarded entry point. Still live here; resolution
   * deletes it after the handler returns, so a grant executes exactly once.
   */
  approval: PendingApproval;
  /** User ID of the admin who approved. Empty string if unknown. */
  userId: string;
  /** Send a system chat message to the requesting agent's session. */
  notify: (text: string) => Promise<void>;
}

export interface ApprovalDeclined {
  declined: string;
}

export type ApprovalHandler = (ctx: ApprovalHandlerContext) => Promise<void | ApprovalDeclined>;

const approvalHandlers = new Map<string, ApprovalHandler>();
const adminClickActions = new Set<string>();

export interface ApprovalHandlerOptions {
  /** Only an owner or admin of the agent group may answer, even on a card posted in the requesting thread. */
  adminClickOnly?: boolean;
}

export function registerApprovalHandler(
  action: string,
  handler: ApprovalHandler,
  options: ApprovalHandlerOptions = {},
): void {
  if (approvalHandlers.has(action)) {
    log.warn('Approval handler re-registered (overwriting)', { action });
  }
  approvalHandlers.set(action, handler);
  if (options.adminClickOnly) adminClickActions.add(action);
  else adminClickActions.delete(action);
}

export function requiresAdminClick(action: string): boolean {
  return adminClickActions.has(action);
}

export function getApprovalHandler(action: string): ApprovalHandler | undefined {
  return approvalHandlers.get(action);
}

// ── Approval-resolved callbacks ──
// Modules that want to observe approval resolution (any action, approve or
// reject) register here at import time. The response handler fires every
// registered callback after the admin's decision is applied — e.g. a module
// clearing an "awaiting approval" status indicator it set when the card went
// out. Callback errors are logged and isolated; they never block resolution.
//
// A reject with reason fires at the click, so an action held elsewhere stops at
// once, and again when the hold ends. Handlers must tolerate the repeat.
//
// Only authorized clicks resolve an approval (the response handler's
// isAuthorizedApprovalClick gate runs first), so callbacks never fire for
// unauthorized responses.

export interface ApprovalResolvedEvent {
  approval: PendingApproval;
  session: Session;
  outcome: 'approve' | 'reject';
  /** Namespaced user ID (`<channel>:<handle>`) of the resolving admin. Empty string if unknown. */
  userId: string;
}

export type ApprovalResolvedHandler = (event: ApprovalResolvedEvent) => Promise<void> | void;

const approvalResolvedHandlers: ApprovalResolvedHandler[] = [];

export function registerApprovalResolvedHandler(handler: ApprovalResolvedHandler): void {
  approvalResolvedHandlers.push(handler);
}

/** Fire every registered approval-resolved callback. Called by the response handler. */
export async function notifyApprovalResolved(event: ApprovalResolvedEvent): Promise<void> {
  for (const handler of approvalResolvedHandlers) {
    try {
      await handler(event);
      // eslint-disable-next-line no-catch-all/no-catch-all -- isolation is the contract: one bad callback must not block resolution or other callbacks
    } catch (err) {
      log.error('Approval-resolved handler threw', {
        approvalId: event.approval.approval_id,
        action: event.approval.action,
        outcome: event.outcome,
        err,
      });
    }
  }
}

// ── Approver picking ──

/**
 * Ordered list of user IDs eligible to approve an action for the given agent
 * group. Preference: admins @ that group → global admins → owners.
 */
export async function pickApprover(agentGroupId: string | null): Promise<string[]> {
  const approvers: string[] = [];
  const seen = new Set<string>();
  const add = (id: string): void => {
    if (!seen.has(id)) {
      seen.add(id);
      approvers.push(id);
    }
  };

  if (agentGroupId) {
    for (const r of await getAdminsOfAgentGroup(agentGroupId)) add(r.user_id);
  }
  for (const r of await getGlobalAdmins()) add(r.user_id);
  for (const r of await getOwners()) add(r.user_id);

  return approvers;
}

/** Owners → global admins → admins @ that group: the reverse of pickApprover. */
export async function pickOwnersFirst(agentGroupId: string | null): Promise<string[]> {
  const roles = [
    ...(await getOwners()),
    ...(await getGlobalAdmins()),
    ...(agentGroupId ? await getAdminsOfAgentGroup(agentGroupId) : []),
  ];
  return [...new Set(roles.map((r) => r.user_id))];
}

/**
 * Walk the approver list and return the first (approverId, messagingGroup)
 * pair we can actually deliver to. Returns null if nobody is reachable.
 *
 * Tie-break: prefer approvers reachable on the same channel kind as the
 * origin; else first in list.
 *
 * `sameChannelTypeOnly`: no cross-channel-type fallback, for cards carrying a
 * user-originated message body, which must not leak into another workspace.
 * Agent-originated cards leave it off: their content is system-owned, and the
 * fallback keeps the owner reachable.
 */
export async function pickApprovalDelivery(
  approvers: string[],
  originChannelType: string,
  /**
   * `instance` stamps a cold-created DM row. Callers that dispatch on the
   * returned row's instance must pass it: a bare channel type resolves no
   * adapter when every bot is a named instance.
   */
  options: { sameChannelTypeOnly?: boolean; instance?: string } = {},
): Promise<{ userId: string; messagingGroup: MessagingGroup } | null> {
  if (originChannelType) {
    for (const userId of approvers) {
      // Not a split on the id's `:` prefix: a Teams id is `29:<aad-id>`.
      if ((await resolveUserChannelType(userId)) !== originChannelType) continue;
      // privacySafeLogs: keeps the approver's handle and raw platform errors out of the host log.
      const mg = await ensureUserDm(userId, { instance: options.instance, privacySafeLogs: true });
      if (mg) return { userId, messagingGroup: mg };
    }
  }
  if (options.sameChannelTypeOnly) return null;
  // The origin instance belongs to a different platform here; never stamp it on this DM row.
  for (const userId of approvers) {
    const mg = await ensureUserDm(userId, { privacySafeLogs: true });
    if (mg) return { userId, messagingGroup: mg };
  }
  return null;
}

// ── Request API ──

/**
 * Send a system chat to the agent's session. The one writer that keeps
 * `origin: 'host'`, and `event` survives no other writer either, so a note that
 * echoes someone's text cannot pass for a host event. `id` lets a caller check
 * afterwards whether the note landed.
 */
export async function notifyAgent(
  session: Session,
  text: string,
  opts: { id?: string; event?: string } = {},
): Promise<void> {
  await writeSessionMessage(
    session.agent_group_id,
    session.id,
    {
      id: opts.id ?? `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text,
        sender: 'system',
        senderId: 'system',
        origin: 'host',
        ...(opts.event ? { event: opts.event } : {}),
      }),
    },
    { hostOrigin: true },
  );
  const fresh = await getSession(session.id);
  if (fresh) {
    requestWake(fresh, 'inbound-message').catch((err) =>
      log.error('Failed to wake container after notification', { err }),
    );
  }
}

export interface RequestApprovalOptions {
  session: Session;
  agentName: string;
  /** Free-form action identifier. Must match the key the consumer registered via registerApprovalHandler. */
  action: string;
  /** Stored in `pending_approvals.request_id`; defaults to the generated approvalId. */
  requestId?: string;
  /** JSON-serializable opaque payload. Carried on the pending_approvals row, handed to the handler on approve. */
  payload: Record<string, unknown>;
  /** Card title shown to the admin. */
  title: string;
  /** Card body shown to the admin. */
  question: string;
  /**
   * `'admin'` (default) DMs the first reachable admin. `'thread'` posts into the
   * originating conversation, and thread access IS the approval authority there:
   * the clicker is not checked against pickApprover (choice actions excepted).
   */
  deliveryTarget?: 'thread' | 'admin';
  /** Deliver the card to this specific user instead of all of the session group's admins. */
  approverUserId?: string;
  /** Ordered override of the pickApprover chain; ignored when approverUserId is set. */
  approvers?: string[];
  /**
   * With `approvers` chosen for one action's authority: only the approver the card reaches may answer it, since the
   * click check otherwise asks about the session's own agent group, not the action's.
   */
  onlyRecipientAnswers?: boolean;
  /** Custom buttons; pair with registerChoiceHandler on the same action, or clicks get approve/reject semantics. */
  options?: RawOption[];
  /**
   * With deliveryTarget 'thread': post here instead of the session's own
   * conversation. The caller must already have authorized it.
   */
  conversation?: { channelType: string; platformId: string; threadId: string | null; instance?: string | null };
}

/**
 * `duplicate-request`: another live row holds this `requestId`; nothing was
 * written and the agent was NOT notified (the caller owns the wording).
 * `failed`: the agent has already been notified.
 */
export type ApprovalOutcome = 'posted' | 'duplicate-request' | 'failed';

/**
 * Queue an approval request. Picks an approver, delivers the card to their
 * DM, and records the pending_approvals row. Fire-and-forget from the
 * caller's perspective — the admin's response kicks off the registered
 * approval handler for this action via the response dispatcher.
 *
 * The insert is also the RESERVATION: an action whose `requestId` must be
 * unique declares a partial unique index and reads `duplicate-request`. A
 * caller's own pre-check cannot replace it; two sessions can both pass one.
 */
export async function requestApprovalOutcome(opts: RequestApprovalOptions): Promise<ApprovalOutcome> {
  const {
    session,
    action,
    payload,
    title,
    question,
    agentName,
    deliveryTarget = 'admin',
    approverUserId,
    approvers: approverOverride,
    onlyRecipientAnswers = false,
    options: customOptions,
  } = opts;
  const cardOptions = customOptions ?? APPROVAL_OPTIONS;

  let answerer = approverUserId ?? null;
  let destination: {
    channelType: string;
    platformId: string;
    threadId: string | null;
    label: string;
    instance?: string | null;
  };
  if (deliveryTarget === 'thread' && opts.conversation) {
    const c = opts.conversation;
    destination = {
      channelType: c.channelType,
      platformId: c.platformId,
      threadId: c.threadId,
      instance: c.instance ?? null,
      label: `conversation ${c.channelType}/${c.platformId}${c.threadId ? ':' + c.threadId : ''}`,
    };
  } else if (deliveryTarget === 'thread') {
    if (!session.messaging_group_id) {
      await notifyAgent(session, `${action} failed: session has no originating channel to post approval in.`);
      return 'failed';
    }
    const mg = await getMessagingGroup(session.messaging_group_id);
    if (!mg) {
      await notifyAgent(session, `${action} failed: originating channel not found.`);
      return 'failed';
    }
    destination = {
      channelType: mg.channel_type,
      platformId: mg.platform_id,
      threadId: session.thread_id,
      instance: mg.instance,
      label: `thread ${mg.channel_type}/${mg.platform_id}${session.thread_id ? ':' + session.thread_id : ''}`,
    };
  } else {
    const approvers = approverUserId
      ? [approverUserId]
      : (approverOverride ?? (await pickApprover(session.agent_group_id)));
    if (approvers.length === 0) {
      await notifyAgent(session, `${action} failed: no owner or admin configured to approve.`);
      return 'failed';
    }
    const originChannelType = session.messaging_group_id
      ? ((await getMessagingGroup(session.messaging_group_id))?.channel_type ?? '')
      : '';
    const target = await pickApprovalDelivery(approvers, originChannelType);
    if (!target) {
      await notifyAgent(session, `${action} failed: no DM channel found for any eligible approver.`);
      return 'failed';
    }
    if (onlyRecipientAnswers) answerer = target.userId;
    destination = {
      channelType: target.messagingGroup.channel_type,
      platformId: target.messagingGroup.platform_id,
      threadId: null,
      instance: target.messagingGroup.instance,
      label: `admin DM ${target.userId}`,
    };
  }

  const approvalId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const normalizedOptions = normalizeOptions(cardOptions);
  const reserved = await createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    agent_group_id: session.agent_group_id,
    request_id: opts.requestId ?? approvalId,
    action,
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    title,
    question,
    options_json: JSON.stringify(normalizedOptions),
    // Routing columns let the host edit the card later; platform_message_id is backfilled below.
    channel_type: destination.channelType,
    platform_id: destination.platformId,
    thread_id: destination.threadId,
    instance: destination.instance ?? null,
    approver_user_id: answerer,
  });
  // Honour the reservation BEFORE anything is posted: false here is the
  // action-scoped unique index refusing a second live row for this requestId.
  if (!reserved) {
    log.info('Approval request refused: requestId already has a live row', {
      action,
      requestId: opts.requestId ?? approvalId,
      agentGroupId: session.agent_group_id,
      sessionId: session.id,
    });
    return 'duplicate-request';
  }

  const adapter = getDeliveryAdapter();
  if (!adapter) {
    await deletePendingApproval(approvalId);
    log.error('Failed to deliver approval card', {
      action,
      approvalId,
      target: destination.label,
      err: 'delivery adapter unavailable',
    });
    await notifyAgent(session, `${action} failed: delivery adapter unavailable for ${destination.label}.`);
    return 'failed';
  }

  try {
    const platformMsgId = await adapter.deliver(
      destination.channelType,
      destination.platformId,
      destination.threadId,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: approvalId,
        title,
        question,
        options: cardOptions,
      }),
      undefined,
      destination.instance ?? undefined,
    );
    if (platformMsgId) {
      await updatePendingApprovalMessageId(approvalId, platformMsgId);
    }
  } catch (err) {
    await deletePendingApproval(approvalId);
    log.error('Failed to deliver approval card', { action, approvalId, target: destination.label, err });
    await notifyAgent(session, `${action} failed: could not deliver approval request to ${destination.label}.`);
    return 'failed';
  }

  await settleSessionStatusAfterPublicDelivery(session.id, {
    conversation: {
      channelType: destination.channelType,
      platformId: destination.platformId,
      threadId: destination.threadId,
    },
    waitWhenElsewhere: true,
  });

  log.info('Approval requested', { action, approvalId, agentName, target: destination.label, deliveryTarget });
  if (deliveryTarget === 'thread') {
    // Not awaited: a slow or failing DM must not hold the caller, which may still have to mark its request pending.
    void import('./card-pointer.js')
      .then(({ sendCardPointer }) => sendCardPointer(approvalId, session))
      .catch((err: unknown) => log.warn('Card pointer DM failed', { approvalId, err }));
  }
  return 'posted';
}

/** Only for actions with no unique index on `requestId`, which never see 'duplicate-request'. */
export async function requestApproval(opts: RequestApprovalOptions): Promise<boolean> {
  return (await requestApprovalOutcome(opts)) === 'posted';
}

/** Every place this card is shown: the card itself, and each recorded copy, including one recorded after `approval` was read. */
async function cardLocations(approval: PendingApproval): Promise<CardPlace[]> {
  const places: CardPlace[] = [];
  // Skips the card itself when the row lacks a routing column, including a platform message id the adapter never returned.
  if (approval.channel_type && approval.platform_id && approval.platform_message_id) {
    places.push({
      channelType: approval.channel_type,
      platformId: approval.platform_id,
      threadId: approval.thread_id,
      messageId: approval.platform_message_id,
      // Dispatch is exact-key: a bare channel type finds no adapter when every bot is a named instance.
      instance: approval.instance ?? approval.channel_type,
    });
  }
  let fresh: PendingApproval | undefined;
  try {
    fresh = await getPendingApproval(approval.approval_id);
    // eslint-disable-next-line no-catch-all/no-catch-all -- an edit never throws to its caller; the copies already held still get it
  } catch (err) {
    log.warn('Could not re-read an approval for its card copies', { approvalId: approval.approval_id, err });
  }
  const copies = [...cardCopies(approval), ...(fresh ? cardCopies(fresh) : [])];
  const seen = new Set<string>();
  for (const copy of copies) {
    const key = `${copy.platform_id}\n${copy.platform_message_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    places.push(copyPlace(copy));
  }
  return places;
}

/** Edits the card and every copy of it, so answering any one of them closes them all. */
export async function editApprovalCard(approval: PendingApproval, newBody: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  for (const place of await cardLocations(approval)) {
    try {
      await closeCardPlace(adapter, approval.approval_id, place, newBody);
    } catch (err) {
      log.warn('Failed to edit approval card', { approvalId: approval.approval_id, messageId: place.messageId, err });
    }
  }
}

/** The longest resolution line a card edit appends; a card that budgets its own body reserves exactly this. */
export const APPROVAL_RESOLUTION_MAX_UNITS = 160;

export function headUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  let end = Math.max(0, units);
  if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
  return text.slice(0, end);
}

export function fitResolutionLine(line: string): string {
  return line.length <= APPROVAL_RESOLUTION_MAX_UNITS
    ? line
    : headUnits(line, APPROVAL_RESOLUTION_MAX_UNITS - 1).trimEnd() + '…';
}

/** An empty `userId` (the sweep finalizing an unanswered hold) drops the byline. */
export async function approvalResolutionLine(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<string> {
  let selectedLabel = selectedOption;
  try {
    const parsed: unknown = JSON.parse(approval.options_json);
    const matched = Array.isArray(parsed)
      ? (parsed as NormalizedOption[]).find((o) => o?.value === selectedOption)
      : undefined;
    if (matched) selectedLabel = matched.selectedLabel || matched.label || selectedOption;
    // eslint-disable-next-line no-catch-all/no-catch-all -- corrupt metadata just means the raw value is the best label available
  } catch {
    /* fall through to the raw value */
  }
  const name = userId ? (await displayNameAcrossBots(userId)) || userId : '';
  return fitResolutionLine(name ? `${selectedLabel} — ${name}` : selectedLabel);
}

/**
 * The bridge edits no approval card on click; this edits the card the ROW
 * names, only once a click is bound and authorized, so a refused or losing
 * click leaves every card as it was.
 */
export async function editApprovalCardResolution(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
): Promise<void> {
  const resolution = await approvalResolutionLine(approval, selectedOption, userId);
  await editApprovalCard(approval, [approval.title, approval.question, resolution].filter(Boolean).join('\n\n'));
}
