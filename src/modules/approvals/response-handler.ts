/**
 * Handle an admin's response to an approval card.
 *
 * Two categories of pending_approvals rows exist:
 *   1. Module-initiated actions — the module called `requestApproval()` with
 *      some free-form `action` string and registered a handler via
 *      `registerApprovalHandler(action, handler)`. On approve, we look up the
 *      handler and call it; on plain reject we relay a decline to the agent; on
 *      "Reject with reason…" we hold the row and capture the clicker's next message
 *      where the card is as a one-line reason (see reason-capture.ts). Reject finalization is shared
 *      via finalizeReject.
 *   2. OneCLI credential approvals (`action = 'onecli_credential'`). Resolved
 *      row-keyed, so the card stays clickable across a host restart — see
 *      onecli-approvals.ts.
 *   3. Choice cards (`registerChoiceHandler`, choices.ts) — the card carries
 *      the requester's own buttons; any stored option is an answer.
 *
 * The response handler is registered via core's `registerResponseHandler`;
 * core iterates handlers and the first one to return `true` claims the response.
 */
import { withCentralSync } from '../../db/central-lease.js';
import { requestWake } from '../../request-wake.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import {
  deletePendingApproval,
  getPendingApproval,
  getSession,
  transitionPendingApprovalStatus,
} from '../../db/sessions.js';
import type { ResponsePayload } from '../../response-registry.js';
import { log } from '../../log.js';
import type { PendingApproval, Session } from '../../types.js';
import { hasAdminPrivilege, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';
import { getUser } from '../permissions/db/users.js';
import { equivalentSlackUserIds } from '../../slack-user-identity.js';
import { choiceApprovers, choiceClickAllowed, getChoiceHandler, resolveChoice } from './choices.js';
import { finalizeReject, resolveClaimed, writeApprovalNote } from './finalize.js';
import { ONECLI_ACTION, resolveOneCLIApproval } from './onecli-approvals.js';
import {
  editApprovalCard,
  editApprovalCardResolution,
  fitResolutionLine,
  getApprovalHandler,
  notifyApprovalResolved,
  REJECT_WITH_REASON_VALUE,
  requiresAdminClick,
  type ApprovalDeclined,
} from './primitive.js';
import { clickedCopy, type ApprovalCardCopy } from './card-copies.js';
import { armReasonCapture, claimReasonHold } from './reason-capture.js';

/** Thread-target cards live in the originating chat, where thread access IS the approval authority. */
async function isThreadDelivery(approval: PendingApproval, session: Session): Promise<boolean> {
  if (!session.messaging_group_id) return false;
  const mg = await getMessagingGroup(session.messaging_group_id);
  if (!mg) return false;
  return approval.channel_type === mg.channel_type && approval.platform_id === mg.platform_id;
}

/**
 * The clicked message must be a card the host posted: the card itself, or a copy the host recorded, matched on its
 * channel, conversation and message together. With no stored id a choice card refuses (its id is backfilled just after
 * delivery); any other kind resolves.
 */
function clickedCard(approval: PendingApproval, payload: ResponsePayload): 'card' | ApprovalCardCopy | null {
  const copy = clickedCopy(approval, payload);
  if (copy) return copy;
  if (!approval.platform_message_id) return getChoiceHandler(approval.action) ? null : 'card';
  return payload.messageId === approval.platform_message_id ? 'card' : null;
}

export async function handleApprovalsResponse(payload: ResponsePayload): Promise<boolean> {
  const approval = await getPendingApproval(payload.questionId);
  if (!approval) return false;

  // Every approval resolves only from its own card: an agent can post a raw
  // ask_question card carrying the same approval id. Claimed, so no later
  // handler takes the id either.
  const clicked = clickedCard(approval, payload);
  if (!clicked) {
    log.warn('Ignoring a click that was not made on the approval card', {
      approvalId: approval.approval_id,
      action: approval.action,
      userId: payload.userId,
      channelType: payload.channelType,
      clickedMessageId: payload.messageId ?? null,
      cardMessageId: approval.platform_message_id,
    });
    return true;
  }

  // Ahead of isAuthorizedApprovalClick: the OneCLI resolver enforces its own
  // approver-set auth and claims every onecli_credential row.
  const refusedCredential = async (approvers: readonly string[]): Promise<void> =>
    tellClicker(
      payload,
      approvers.length === 0
        ? `No one can approve this credential request any more, so it will expire.${NOT_COUNTED}`
        : `${await onlyNamed(approvers)}${NOT_COUNTED}`,
    );
  if (
    await resolveOneCLIApproval(payload.questionId, payload.value, namespacedUserId(payload) ?? '', refusedCredential)
  ) {
    return true;
  }

  const refusal = await clickRefusal(approval, payload, clicked !== 'card' && clicked.queue === true);
  if (refusal) {
    log.warn('Ignoring unauthorized approval response', {
      approvalId: approval.approval_id,
      action: approval.action,
      userId: payload.userId,
      channelType: payload.channelType,
    });
    await tellClicker(payload, refusal);
    return true;
  }

  if (approval.action === ONECLI_ACTION) {
    // Unreachable today; guards the module-approval path below, which would
    // delete a still-clickable credential row.
    log.warn('OneCLI approval row reached the module-approval path — ignoring', {
      approvalId: approval.approval_id,
    });
    return true;
  }

  if (getChoiceHandler(approval.action)) {
    await resolveChoice(approval, payload.value, namespacedUserId(payload) ?? '', (text) => tellClicker(payload, text));
    return true;
  }

  const copy = clicked === 'card' ? undefined : clicked;
  if (!(await handleRegisteredApproval(approval, payload.value, namespacedUserId(payload) ?? '', copy)).claimed) {
    await tellClicker(payload, 'Someone already answered this card. Your click did not count.');
  }
  return true;
}

/**
 * `ncl approvals approve|reject`: the same resolution as an authorized click.
 * Callers MUST have rejected agent-originated requests: an agent must never
 * resolve an approval, least of all its own.
 */
export async function resolveApprovalFromHost(
  approvalId: string,
  decision: 'approve' | 'reject',
  userId: string,
): Promise<{ resolved: boolean; error?: string; declined?: string }> {
  const approval = await getPendingApproval(approvalId);
  if (!approval) return { resolved: false, error: `No pending approval ${approvalId}` };
  if (approval.action === ONECLI_ACTION) {
    return {
      resolved: false,
      error: 'OneCLI credential approvals resolve through the gateway flow, not the CLI.',
    };
  }
  if (getChoiceHandler(approval.action)) {
    return { resolved: false, error: 'Choice cards resolve by clicking one of their options, not approve/reject.' };
  }
  if (approval.status === 'awaiting_reason') {
    return { resolved: false, error: `Approval ${approvalId} was already rejected; it is waiting for the reason.` };
  }
  const { claimed, declined } = await handleRegisteredApproval(approval, decision, userId);
  if (!claimed) return { resolved: false, error: `Approval ${approvalId} was already answered by someone else.` };
  return declined ? { resolved: true, declined } : { resolved: true };
}

const CLAIMED_STATUS: Record<string, PendingApproval['status']> = {
  approve: 'approved',
  reject: 'rejected',
  [REJECT_WITH_REASON_VALUE]: 'awaiting_reason',
};

/** `claimed` is false only when another response already claimed the approval; `declined` is a handler's refusal. */
async function handleRegisteredApproval(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
  onCopy?: ApprovalCardCopy,
): Promise<{ claimed: boolean; declined?: string }> {
  if (!approval.session_id) {
    await deletePendingApproval(approval.approval_id);
    return { claimed: true };
  }
  const session = await getSession(approval.session_id);
  if (!session) {
    await deletePendingApproval(approval.approval_id);
    return { claimed: true };
  }

  // Unknown values are untrusted transport input: the approval stays pending.
  const claimedStatus = CLAIMED_STATUS[selectedOption];
  if (!claimedStatus) {
    log.warn('Ignoring approval response with an unknown option', {
      approvalId: approval.approval_id,
      action: approval.action,
      selectedOption,
      userId,
    });
    return { claimed: true };
  }

  let declined: string | undefined;
  const claimed = await resolveClaimed(
    () =>
      claimedStatus === 'awaiting_reason'
        ? claimReasonHold(approval)
        : transitionPendingApprovalStatus(approval.approval_id, 'pending', claimedStatus),
    async () => {
      declined = await applyResponse(approval, session, selectedOption, userId, onCopy);
    },
  );
  if (!claimed) {
    log.warn('Ignoring a response to an approval already answered', {
      approvalId: approval.approval_id,
      selectedOption,
      userId,
    });
  }
  return { claimed, declined };
}

async function applyResponse(
  approval: PendingApproval,
  session: Session,
  selectedOption: string,
  userId: string,
  onCopy?: ApprovalCardCopy,
): Promise<string | undefined> {
  // "Reject with reason…" — hold the row and capture the clicker's reply
  // instead of finalizing now. The agent is notified exactly once: after the
  // reason arrives, or after the sweep's timeout if the admin ghosts.
  if (selectedOption === REJECT_WITH_REASON_VALUE) {
    // Decided at the click: a gated command waiting in its container stands down now, not after a reason arrives.
    await notifyApprovalResolved({ approval, session, outcome: 'reject', userId });
    await armReasonCapture(approval, session, userId, onCopy);
    return;
  }

  if (selectedOption === 'reject') {
    await finalizeReject(approval, session, userId);
    return;
  }

  // Approved — dispatch to the module that registered for this action.
  const notify = (text: string): Promise<void> => writeApprovalNote(session, text);

  const handler = getApprovalHandler(approval.action);
  if (!handler) {
    log.warn('No approval handler registered — row dropped', {
      approvalId: approval.approval_id,
      action: approval.action,
    });
    await notify(`Your ${approval.action} was approved, but no handler is installed to apply it.`);
    await editApprovalCardResolution(approval, selectedOption, userId);
    await deletePendingApproval(approval.approval_id);
    await notifyApprovalResolved({ approval, session, outcome: 'approve', userId });
    await requestWake(session, 'approval-response');
    return;
  }

  const payload = JSON.parse(approval.payload);
  let result: void | ApprovalDeclined = undefined;
  try {
    result = await handler({ session, payload, approval, userId, notify });
    if (!result) log.info('Approval handled', { approvalId: approval.approval_id, action: approval.action, userId });
  } catch (err) {
    log.error('Approval handler threw', { approvalId: approval.approval_id, action: approval.action, err });
    await notify(
      `Your ${approval.action} was approved, but applying it failed: ${err instanceof Error ? err.message : String(err)}.`,
    );
  }

  if (result) {
    log.info('Approval declined by its handler', { approvalId: approval.approval_id, action: approval.action, userId });
    await editApprovalCard(approval, [approval.title, approval.question, result.declined].filter(Boolean).join('\n\n'));
    await deletePendingApproval(approval.approval_id);
    return result.declined;
  }

  // The bridge edits no approval card on click; the card shows live buttons until this lands.
  await editApprovalCardResolution(approval, selectedOption, userId);
  await deletePendingApproval(approval.approval_id);
  await notifyApprovalResolved({ approval, session, outcome: 'approve', userId });
  await requestWake(session, 'approval-response');
}

function namespacedUserId(payload: ResponsePayload): string | null {
  if (!payload.userId) return null;
  return payload.userId.includes(':') ? payload.userId : `${payload.channelType}:${payload.userId}`;
}

/** A click in the approvals channel is not thread access, so it never takes the thread-member shortcut. */
async function clickRefusal(
  approval: PendingApproval,
  payload: ResponsePayload,
  inApprovalsChannel: boolean,
): Promise<string | null> {
  const userId = namespacedUserId(payload);
  if (!userId) return 'Your click could not be matched to a user, so it did not count.';
  const refusal = await answerRefusal(approval, userId, !inApprovalsChannel);
  return refusal && `${refusal}${NOT_COUNTED}`;
}

const NOT_COUNTED = ' Your click did not count.';

export async function canAnswerApproval(approval: PendingApproval, userId: string): Promise<boolean> {
  return (await answerRefusal(approval, userId)) === null;
}

/** Why `userId` may not answer this approval, or null when they may. */
export async function answerRefusal(
  approval: PendingApproval,
  userId: string,
  threadShortcut = true,
): Promise<string | null> {
  // An approval may name a specific approver; only that user may resolve it, from any of their same-workspace bots.
  if (approval.approver_user_id) {
    return equivalentSlackUserIds(userId).includes(approval.approver_user_id)
      ? null
      : await onlyNamed([approval.approver_user_id]);
  }

  // Any thread member may resolve a thread-delivered card. Choice cards never
  // take this shortcut (an answer is a decision the agent acts on), nor do
  // actions registered adminClickOnly.
  if (
    threadShortcut &&
    approval.session_id &&
    !getChoiceHandler(approval.action) &&
    !requiresAdminClick(approval.action)
  ) {
    const session = await getSession(approval.session_id);
    if (session && (await isThreadDelivery(approval, session))) return null;
  }

  if (getChoiceHandler(approval.action) && !choiceClickAllowed(approval, userId)) {
    return await onlyNamed(choiceApprovers(approval) ?? []);
  }

  const agentGroupId =
    approval.agent_group_id ?? (approval.session_id ? (await getSession(approval.session_id))?.agent_group_id : null);

  if (!agentGroupId) {
    const allowed = await withCentralSync(() => isOwner(userId) || isGlobalAdmin(userId), 'approval click authority');
    return allowed ? null : 'Only the owner or a global admin can answer this card.';
  }

  const allowed = await withCentralSync(() => hasAdminPrivilege(userId, agentGroupId), 'approval click authority');
  return allowed ? null : 'Only an admin of this agent can answer this card.';
}

export async function onlyNamed(approvers: readonly string[]): Promise<string> {
  const names: string[] = [];
  for (const id of approvers) {
    const name = (await getUser(id))?.display_name;
    if (!name) return 'Only the people this card names can answer it.';
    if (!names.includes(name)) names.push(name);
  }
  if (names.length === 0) {
    return 'Only the people this card names can answer it.';
  }
  const all = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return `Only ${fitResolutionLine(all)} can answer this card.`;
}

async function tellClicker(payload: ResponsePayload, text: string): Promise<void> {
  if (!payload.replyToClicker) return;
  try {
    await payload.replyToClicker(text);
    // eslint-disable-next-line no-catch-all/no-catch-all -- the refusal stands whether or not its explanation reached the clicker
  } catch (err) {
    log.warn('Could not tell a clicker why the click did not count', { questionId: payload.questionId, err });
  }
}
