/**
 * Choice cards — approvals whose buttons are the requester's own options.
 *
 * A module that wants an answer rather than an approve/reject decision calls
 * requestApproval with custom `options` and registers a handler here under the
 * same action. The response handler then routes the row through this file:
 *
 *   - Authority is never thread membership: isAuthorizedApprovalClick skips its
 *     any-thread-member shortcut for these, requires owner/admin privilege on
 *     the agent group, and a card may narrow that further to named approvers
 *     (choiceClickAllowed).
 *   - The host edits the card only after the first authorized click has won
 *     the pending→approved compare-and-swap AND its answer was delivered, so a
 *     refused, unknown or losing click leaves the card live and untouched.
 *   - A click whose answer cannot be delivered is not consumed: the row goes
 *     back to pending and the card stays live.
 */
import { registerAnswerCardAction } from '../../answer-cards.js';
import type { NormalizedOption } from '../../channels/ask-question.js';
import { recordChoiceReceipt } from '../../db/choice-receipts.js';
import {
  deletePendingApproval,
  getSession,
  transitionPendingApprovalStatus,
  updatePendingApprovalStatus,
} from '../../db/sessions.js';
import { log } from '../../log.js';
import { displayNameAcrossBots, equivalentSlackUserIds } from '../../slack-user-identity.js';
import type { PendingApproval, Session } from '../../types.js';
import {
  APPROVAL_RESOLUTION_MAX_UNITS,
  editApprovalCard,
  fitResolutionLine,
  headUnits,
  notifyApprovalResolved,
} from './primitive.js';
import { cardReleaseScopeJson, unscopedReleaseCard } from './release-ship-scope.js';

export interface ChoiceHandlerContext {
  approval: PendingApproval;
  /** The session that asked, when it is still live; undefined once it has ended. */
  requester: Session | undefined;
  /** Value of the clicked option, verified against the row's stored options. */
  value: string;
  label: string;
  /** Namespaced user ID (`<channel>:<handle>`) of the authorized clicker. */
  userId: string;
  /** Set when the owner answered from the host (`ncl approvals choose`) rather than on the card. */
  answeredFrom?: 'host';
}

/**
 * Deliver the answer. Resolve to the session that received it, or null when no
 * live session can take it. Throw only when the answer was NOT recorded: once
 * the row is written, a failed wake is not a failed delivery, because the sweep
 * wakes a session with due rows (sweep-scheduling, sweep-continuation).
 */
export type ChoiceHandler = (ctx: ChoiceHandlerContext) => Promise<Session | null>;

const choiceHandlers = new Map<string, ChoiceHandler>();

export function registerChoiceHandler(action: string, handler: ChoiceHandler): void {
  if (choiceHandlers.has(action)) {
    log.warn('Choice handler re-registered (overwriting)', { action });
  }
  choiceHandlers.set(action, handler);
  registerAnswerCardAction(action);
}

export function getChoiceHandler(action: string): ChoiceHandler | undefined {
  return choiceHandlers.get(action);
}

/**
 * Whether `userId` is among the card's named approvers. A card without
 * `approvers` (payload) names none, and the response handler's owner/admin
 * check is the whole rule. Narrowing only: that check still applies to a
 * listed user. A listed Slack id matches the clicker's same-workspace sibling
 * ids, the equivalence role checks use (equivalentSlackUserIds).
 */
export function choiceClickAllowed(approval: PendingApproval, userId: string): boolean {
  const approvers = choiceApprovers(approval);
  if (approvers === undefined) return true;
  const clicker = new Set(equivalentSlackUserIds(userId));
  return approvers.some((approver) => clicker.has(approver));
}

/** How a resolveChoice call ended; `uncounted` is a Ship relayed on an out-of-date release card. */
export type ChoiceOutcome = 'resolved' | 'uncounted' | 'unknown_option' | 'already_answered' | 'undelivered';

/** First click wins: the pending→approved compare-and-swap lets exactly one racing click through. */
export async function resolveChoice(
  approval: PendingApproval,
  selectedOption: string,
  userId: string,
  tellClicker?: (text: string) => Promise<void>,
  answeredFrom?: 'host',
): Promise<ChoiceOutcome> {
  const handler = getChoiceHandler(approval.action);
  if (!handler) return 'unknown_option';

  const option = choiceOptions(approval).find((o) => o.value === selectedOption);
  if (!option) {
    // Untrusted transport input, not a decision. The card was not touched.
    log.warn('Ignoring choice response with an unknown option', {
      approvalId: approval.approval_id,
      action: approval.action,
      selectedOption,
      userId,
    });
    return 'unknown_option';
  }

  if (!(await transitionPendingApprovalStatus(approval.approval_id, 'pending', 'approved'))) {
    // The winner delivers and edits the card.
    log.info('Ignoring click on an already-resolved choice', { approvalId: approval.approval_id, userId });
    return 'already_answered';
  }
  // The decision time is the CAS, captured before any await for the immutable receipt.
  const resolvedAt = new Date().toISOString();

  let deliveredTo: Session | null;
  try {
    deliveredTo = await handler({
      approval,
      requester: await liveSession(approval.session_id),
      value: option.value,
      label: option.label,
      userId,
      ...(answeredFrom ? { answeredFrom } : {}),
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- the answer was not recorded (ChoiceHandler); keep the click unconsumed
  } catch (err) {
    log.error('Choice answer could not be delivered — card left open', {
      approvalId: approval.approval_id,
      action: approval.action,
      userId,
      err,
    });
    await updatePendingApprovalStatus(approval.approval_id, 'pending');
    return 'undelivered';
  }

  if (!deliveredTo) {
    log.error('Choice answered but no live session can take it — card left open', {
      approvalId: approval.approval_id,
      action: approval.action,
      sessionId: approval.session_id,
      userId,
    });
    await updatePendingApprovalStatus(approval.approval_id, 'pending');
    return 'undelivered';
  }

  log.info('Choice resolved', {
    approvalId: approval.approval_id,
    action: approval.action,
    userId,
    sessionId: deliveredTo.id,
    ...(answeredFrom ? { answeredFrom } : {}),
  });
  await writeChoiceReceipt(approval, deliveredTo, option, userId, resolvedAt, answeredFrom);
  await deletePendingApproval(approval.approval_id);
  const name = (await displayNameAcrossBots(userId)) || userId;
  const uncounted = option.value === 'ship' && unscopedReleaseCard(approval);
  await editApprovalCard(
    approval,
    cardText(
      approval,
      uncounted
        ? `⚠️ Ship did not count (out-of-date card) — ${
            answeredFrom ? deciderName(name, answeredFrom, UNCOUNTED_NAME_UNITS) : headUnits(name, UNCOUNTED_NAME_UNITS)
          }`
        : answeredLine(option.label, name, answeredFrom),
    ),
  );
  if (uncounted) await tellClicker?.(UNCOUNTED_SHIP);
  // A choice resolves as approval of the chosen option.
  await notifyApprovalResolved({ approval, session: deliveredTo, outcome: 'approve', userId });
  return uncounted ? 'uncounted' : 'resolved';
}

const FROM_HOST = ' (from the host)';
const HOST_DECIDER_UNITS = 48;

/** A host answer cuts the label, then the name, so its marker always fits the resolution line. */
function answeredLine(label: string, name: string, answeredFrom: 'host' | undefined): string {
  if (answeredFrom !== 'host') return `✅ ${label} — ${name}`;
  const by = ` — ${deciderName(name, answeredFrom, HOST_DECIDER_UNITS)}`;
  const room = APPROVAL_RESOLUTION_MAX_UNITS - '✅ '.length - by.length;
  return `✅ ${label.length <= room ? label : `${headUnits(label, room - 1).trimEnd()}…`}${by}`;
}

/**
 * The name a card, report or note shows for who decided, so a host answer is never mistaken for a click. A host
 * answer's name is cut to fit `units` before the marker, never the marker itself.
 */
export function deciderName(name: string, answeredFrom?: 'host', units = Infinity): string {
  if (answeredFrom !== 'host') return name;
  return `${headUnits(name, Math.max(0, units - FROM_HOST.length))}${FROM_HOST}`;
}

/**
 * Close an open choice card without an answer: claim it (pending→expired, so a
 * racing click loses), drop the row so a late click finds nothing, then edit
 * the card to its ask plus `line`. The row is retired even when the edit fails.
 * Returns false when the card was no longer open.
 */
export async function retireChoice(approval: PendingApproval, line: string): Promise<boolean> {
  if (!(await transitionPendingApprovalStatus(approval.approval_id, 'pending', 'expired'))) return false;
  await deletePendingApproval(approval.approval_id);
  await editApprovalCard(approval, cardText(approval, line));
  return true;
}

/** Same predicate as unwakeableReason in src/container-runner.ts. */
async function liveSession(sessionId: string | null): Promise<Session | undefined> {
  const session = sessionId ? await getSession(sessionId) : undefined;
  return session && session.status === 'active' && session.archived_at == null ? session : undefined;
}

/**
 * Durable evidence that THIS card resolved to THIS value for THIS user.
 * Best-effort: a failure must not unwind a delivered answer, so a consumer
 * finding no receipt must treat the request as unverified and fail closed.
 */
async function writeChoiceReceipt(
  approval: PendingApproval,
  deliveredTo: Session,
  option: NormalizedOption,
  userId: string,
  resolvedAt: string,
  answeredFrom: 'host' | undefined,
): Promise<void> {
  try {
    await recordChoiceReceipt({
      requestId: approval.request_id,
      approvalId: approval.approval_id,
      action: approval.action,
      agentGroupId: approval.agent_group_id,
      sessionId: deliveredTo.id,
      platformId: approval.platform_id,
      threadId: approval.thread_id,
      platformMessageId: approval.platform_message_id,
      value: option.value,
      label: option.label,
      clickerUserId: userId,
      releaseScopeJson: cardReleaseScopeJson(approval) ?? null,
      resolvedAt,
      answeredFrom: answeredFrom ?? null,
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- the answer is already delivered; a receipt-write failure must not reopen the card
  } catch (err) {
    log.error('Failed to write choice receipt — answer was still delivered', {
      approvalId: approval.approval_id,
      requestId: approval.request_id,
      err,
    });
  }
}

export function choiceApprovers(approval: PendingApproval): string[] | undefined {
  try {
    const approvers = (JSON.parse(approval.payload) as { approvers?: unknown }).approvers;
    return Array.isArray(approvers) ? approvers.filter((a): a is string => typeof a === 'string') : undefined;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a corrupt payload names no approvers; the admin check still applies
  } catch {
    return undefined;
  }
}

export function choiceOptions(approval: PendingApproval): NormalizedOption[] {
  try {
    const parsed: unknown = JSON.parse(approval.options_json);
    return Array.isArray(parsed) ? (parsed as NormalizedOption[]) : [];
    // eslint-disable-next-line no-catch-all/no-catch-all -- corrupt metadata matches no option, so the click is ignored
  } catch {
    return [];
  }
}

// A release card's body may use 1800 of Discord's 1900-unit edit, which keeps only the head of an over-long edit.
const UNCOUNTED_NAME_UNITS = 32;
const UNCOUNTED_SHIP =
  'This card is out of date: it does not list the risks a Ship accepts, so your click did not count. Ask for a fresh card if one does not appear.';

function cardText(approval: PendingApproval, line: string): string {
  return [approval.title, approval.question, fitResolutionLine(line)].filter(Boolean).join('\n\n');
}
