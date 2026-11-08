/**
 * Admin-approval gates for in-container Bash: `request_bash_gate` (soft
 * sensitive, e.g. email send) and `request_destructive_gate`. Distinct action
 * names so cards, logs and policy can differ; shared ack mechanics.
 *
 * The container hook writes the request (requestId === messages_out.id) and
 * polls inbound.db's `delivered` table for requestId; approve, reject or
 * timeout writes the decision there. Without a registered handler the
 * container-side hook blocks until its own timeout on every send.
 */

import { containerStartedAtMs, getContainerIdentity, hasPendingAdoption } from '../../container-runner.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { log } from '../../log.js';
import { readSessionInbound, SessionDbMissingError, SessionDbUnopenableError } from '../mailbox/index.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { withCentralSync } from '../../db/central-lease.js';
import { readContainerConfig } from '../../container-config.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';
import { resolveUserChannelType } from '../permissions/user-dm.js';
import { getUser } from '../permissions/db/users.js';
import type { PendingApproval, Session } from '../../types.js';
import {
  deletePendingApproval,
  getApprovalByRequestId,
  getPendingApproval,
  getPendingApprovalsByAction,
  getPendingApprovalsBySession,
  getSession,
  transitionPendingApprovalStatus,
} from '../../db/sessions.js';

import {
  APPROVAL_RESOLUTION_MAX_UNITS,
  editApprovalCard,
  headUnits,
  registerApprovalHandler,
  registerApprovalResolvedHandler,
  requestApproval,
  notifyAgent,
  type ApprovalDeclined,
  type ApprovalHandlerContext,
} from '../approvals/primitive.js';

// Approvers are often in a meeting when the card lands.
const BASH_GATE_TIMEOUT_MS = 60 * 60 * 1000;
const GATE_CARD_TITLE_MAX_CHARS = 140;
// The card body (summary, command preview, footer) is budgeted in UTF-16 units so
// that both the posted card and its approve/reject edit (title, body and resolution
// line as one message) fit the platform's text limit; past it the footer, the
// command's tail or the resolution line would be dropped silently.
const GATE_COMMAND_PREVIEW_MIN_UNITS = 600;

const WITHDRAW_ACTION = 'gate-withdraw';
/** Withdraw cards being posted, so two quick messages from one sender post one card. */
const offering = new Set<string>();
const WITHDRAW_OPTIONS = [
  { label: 'Withdraw', selectedLabel: '↩️ Withdrawn', value: 'approve', style: 'danger' as const },
];

const pendingTimeouts = new Map<string, NodeJS.Timeout>();

/**
 * Lets the router skip the gate query in the common case. Not persisted, so after a host restart an adopted
 * container's open gate is missing here and a follow-up offers no Withdraw.
 */
const sessionsWithActiveGates = new Set<string>();

export function sessionHasActiveGates(sessionId: string): boolean {
  return sessionsWithActiveGates.has(sessionId);
}

interface BashGatePayload {
  requestId: string;
  label: string;
  summary: string;
  command: string;
  sessionId: string;
}

/**
 * Runs long after the dispatching drain, in its own short session. Existing-only:
 * a session whose mailbox is gone has no container polling for the decision.
 */
async function writeGateAck(
  session: Session,
  requestId: string,
  outcome: 'approved' | 'rejected' | 'timeout',
  errorText?: string,
  receipt: string | null = null,
): Promise<void> {
  await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
    if (outcome === 'approved') {
      mailbox.markDelivered(requestId, receipt);
    } else {
      mailbox.markDeliveryFailed(requestId, errorText ?? outcome);
    }
  });
}

function clearPending(requestId: string): void {
  const handle = pendingTimeouts.get(requestId);
  if (handle) {
    clearTimeout(handle);
    pendingTimeouts.delete(requestId);
  }
}

interface GateCategory {
  deliveryAction: string;
  approvalAction: string;
  defaultLabel: string;
  defaultSummary: string;
  logPrefix: string;
  titleEmoji: string;
  kindNoun: string;
  /** Owner or admin of the agent group only, though the card is posted in the thread. */
  adminClickOnly?: boolean;
  /** From a session with no conversation, the card goes to the group's `sends_as_user_id` instead of being refused. */
  chatlessToSender?: boolean;
  /**
   * The request may carry `pureSend`, which the container's email gate sets only when the command is the send alone and
   * its summary shows all of it. The card then leaves the command off.
   */
  summaryMayStandForCommand?: boolean;
}

function tailUnits(text: string, units: number): string {
  if (text.length <= units) return text;
  let start = text.length - Math.max(0, units);
  if (start < text.length && /[\uDC00-\uDFFF]/.test(text[start])) start++;
  return text.slice(start);
}

// Head+tail preview: a long command's final arguments are often the most
// consequential part.
function commandPreview(command: string, units: number): string {
  if (command.length <= units) return command;
  const marker = '\n…[middle omitted; full command retained in the approval record]…\n';
  const headLength = Math.floor((units - marker.length) / 2);
  return headUnits(command, headLength) + marker + tailUnits(command, units - marker.length - headLength);
}

// The adapters' configured maxTextLength (Slack 2800, Discord 1900), copied because adapters are skill-installed and
// may be absent; 1900 also covers any other platform.
const SLACK_MESSAGE_MAX_UNITS = 2800;
const OTHER_MESSAGE_MAX_UNITS = 1900;

export function cardBodyBudget(platformId: string | undefined, title: string): number {
  const limit = platformId?.startsWith('slack:') ? SLACK_MESSAGE_MAX_UNITS : OTHER_MESSAGE_MAX_UNITS;
  // The edit is `title\n\nbody\n\nresolution`; Discord's post wraps the title as `**title**\n\n`, which is shorter.
  return limit - title.length - '\n\n\n\n'.length - APPROVAL_RESOLUTION_MAX_UNITS;
}

function buildCardBody(
  category: GateCategory,
  summary: string,
  command: string,
  budget: number,
  pureSend: boolean,
): string {
  const timeoutMinutes = BASH_GATE_TIMEOUT_MS / 60_000;
  const who = category.adminClickOnly ? ' Only an owner or admin of this agent can approve.' : '';
  const footer = `_Reject, or no answer within ${timeoutMinutes} min, cancels the ${category.kindNoun.toLowerCase()}.${who}_`;
  const separator = '\n\n';
  if (pureSend) {
    const card = [summary, footer].join(separator);
    if (card.length <= budget) return card;
  }
  const fence = (body: string) => '```\n' + body + '\n```';
  const fixed = footer.length + separator.length + (command ? fence('').length + separator.length : 0);
  const summaryUnits = budget - fixed - Math.min(GATE_COMMAND_PREVIEW_MIN_UNITS, command.length);
  const shownSummary = summary.length <= summaryUnits ? summary : headUnits(summary, summaryUnits - 1) + '…';
  const parts: string[] = [shownSummary];
  if (command) {
    // The full command is persisted in the approval payload; the card preview
    // keeps head and tail so the approver never infers omitted final arguments.
    parts.push(fence(commandPreview(command, budget - fixed - shownSummary.length)));
  }
  parts.push(footer);
  return parts.join(separator);
}

function buildCardTitle(category: GateCategory, label: string): string {
  const title = `${category.titleEmoji} ${label}`;
  const codePoints = Array.from(title);
  if (codePoints.length <= GATE_CARD_TITLE_MAX_CHARS) return title;
  return (
    codePoints
      .slice(0, GATE_CARD_TITLE_MAX_CHARS - 1)
      .join('')
      .trimEnd() + '…'
  );
}

export const NOBODY_WATCHING =
  'Refused, and retrying will not change it: this session has no conversation, so nobody is watching to approve ' +
  'this. Hand the step to a person: say in your report exactly what needs to run and why, then stop.';
const TASK_BRIEF_MAX_UNITS = 200;

export function taskBrief(session: Session): string | null {
  try {
    const prompt = readSessionInbound(
      { agentGroupId: session.agent_group_id, sessionId: session.id },
      (mailbox) => mailbox.getLatestTaskEvent()?.prompt ?? null,
    );
    const line = prompt
      ?.split('\n')
      .find((l) => l.trim())
      ?.trim();
    if (!line) return null;
    return line.length <= TASK_BRIEF_MAX_UNITS ? line : headUnits(line, TASK_BRIEF_MAX_UNITS - 1) + '…';
  } catch (err) {
    log.warn('Gate card could not read the task that asked', { sessionId: session.id, err });
    return null;
  }
}

export function chatlessCardBudget(dmChannelType: string | null, title: string): number {
  return cardBodyBudget(dmChannelType?.startsWith('slack') ? 'slack:' : undefined, title);
}

function commandCarries(command: string, text: string): boolean {
  return command.includes(text) || command.includes(JSON.stringify(text).slice(1, -1));
}

/** The group's `sends_as_user_id`, while that person is an owner or admin of the group; null otherwise. */
export async function chatlessSender(session: Session): Promise<string | null> {
  const group = await getAgentGroup(session.agent_group_id);
  const approverUserId = group ? readContainerConfig(group.folder).sends_as_user_id : undefined;
  if (!approverUserId) return null;
  const allowed = await withCentralSync(
    () => hasAdminPrivilege(approverUserId, session.agent_group_id),
    'chat-less send approver',
  );
  return allowed ? approverUserId : null;
}

/**
 * The card for a gate filed where nobody is watching, or the refusal the agent reads instead. Only a post goes to a
 * person, and only to the one whose credentials it posts with; the card never cuts the command short, because that
 * person has no thread around it to fill in what a preview leaves out.
 */
async function chatlessCard(
  category: GateCategory,
  session: Session,
  title: string,
  summary: string,
  command: string,
  sendParts: unknown,
): Promise<string | { approverUserId: string; question: string }> {
  if (!category.chatlessToSender) return NOBODY_WATCHING;
  const approverUserId = await chatlessSender(session);
  if (!approverUserId) return `${NOBODY_WATCHING} No one is set to approve posts from background sessions here.`;

  const fence = (body: string) => '```\n' + body + '\n```';
  const brief = taskBrief(session);
  const footer = `_Reject, or no answer within ${BASH_GATE_TIMEOUT_MS / 60_000} min, cancels the ${category.kindNoun}._`;
  const head = [`_Asked by a background task with no conversation${brief ? `: ${brief}` : ''}_`, summary];
  const text = Array.isArray(sendParts) && typeof sendParts[0] === 'string' ? sendParts[0] : null;
  if (text === null) return `${NOBODY_WATCHING} The post's text could not be read from the command to show on a card.`;
  const dmChannel = await resolveUserChannelType(approverUserId);
  const budget = chatlessCardBudget(dmChannel, title);
  const card = (parts: string[]) => [...parts, 'Command:', fence(command), footer].join('\n\n');
  const withText = card([...head, 'Text, exactly as it will post:', fence(text)]);
  if (withText.length <= budget) return { approverUserId, question: withText };
  // The command alone shows the text only when it carries it verbatim; `--data @file` does not.
  if (commandCarries(command, text) && card(head).length <= budget) {
    return { approverUserId, question: card(head) };
  }
  return `${NOBODY_WATCHING} The post is too long to show in full on a card.`;
}

function createGateHandler(category: GateCategory) {
  return async function handleGateRequest(
    content: Record<string, unknown>,
    session: Session,
  ): Promise<{ deferAck: true }> {
    const label = typeof content.label === 'string' ? content.label : category.defaultLabel;
    const summary = typeof content.summary === 'string' ? content.summary : category.defaultSummary;
    // Keep the full command: truncating would drop consequential trailing flags.
    const command = typeof content.command === 'string' ? content.command : '';
    const requestId = typeof content.requestId === 'string' ? (content.requestId as string) : '';
    if (!requestId) {
      log.warn(`${category.deliveryAction} missing requestId`, { content });
      // Still defer: the container polls for a decision on its own requestId,
      // and auto-acking would falsely unblock it.
      return { deferAck: true };
    }

    if (filedByEarlierContainer(session.id, requestId)) {
      await writeGateAck(session, requestId, 'rejected', STOPPED_BEFORE_POSTED_ERROR);
      log.info('Gate request from a replaced container refused', { sessionId: session.id, requestId });
      return { deferAck: true };
    }
    const remainingMs = Math.min(
      BASH_GATE_TIMEOUT_MS,
      (requestedAtMs(requestId) ?? Date.now()) + BASH_GATE_TIMEOUT_MS - Date.now(),
    );
    if (remainingMs <= 0) {
      await writeGateAck(session, requestId, 'timeout', EXPIRED_BEFORE_POSTED_ERROR);
      log.info('Gate request expired before it was posted', { sessionId: session.id, requestId });
      return { deferAck: true };
    }
    const title = buildCardTitle(category, label);
    let chatless: { approverUserId: string; question: string } | null = null;
    if (!session.messaging_group_id) {
      const decided = await chatlessCard(category, session, title, summary, command, content.sendParts);
      if (typeof decided === 'string') {
        await writeGateAck(session, requestId, 'rejected', decided);
        log.info(`${category.logPrefix} gate refused: the session has no conversation`, {
          sessionId: session.id,
          requestId,
        });
        return { deferAck: true };
      }
      chatless = decided;
    }
    await supersedeOrphanedGates(session);
    sessionsWithActiveGates.add(session.id);

    // Schedule the timeout before dispatching, so a throw below still
    // auto-resolves the container side.
    const timer = setTimeout(() => {
      void (async () => {
        pendingTimeouts.delete(requestId);
        await expireGate(category, session.id, requestId, session);
      })().catch((err) => {
        log.error(`${category.logPrefix} gate timeout handler failed`, { requestId, err });
      });
    }, remainingMs);
    timer.unref(); // don't block process shutdown on a pending gate
    pendingTimeouts.set(requestId, timer);

    const payload: BashGatePayload = {
      requestId,
      label,
      summary,
      command,
      sessionId: session.id,
    };

    const platformId = session.messaging_group_id
      ? (await getMessagingGroup(session.messaging_group_id))?.platform_id
      : undefined;
    const approvalDelivered = await requestApproval({
      session,
      agentName: session.agent_group_id,
      action: category.approvalAction,
      requestId,
      payload: payload as unknown as Record<string, unknown>,
      title,
      question:
        chatless?.question ??
        buildCardBody(
          category,
          summary,
          command,
          cardBodyBudget(platformId, title),
          category.summaryMayStandForCommand === true && content.pureSend === true,
        ),
      // In-thread: thread access IS the authority for work-level gates
      // (response-handler.ts doesn't check clicker identity) unless the category
      // is adminClickOnly. Self-mod and credential approvals stay admin-DM.
      ...(chatless
        ? { deliveryTarget: 'admin' as const, approverUserId: chatless.approverUserId }
        : { deliveryTarget: 'thread' as const }),
    });
    if (!approvalDelivered) {
      clearPending(requestId);
      sessionsWithActiveGates.delete(session.id);
      await writeGateAck(
        session,
        requestId,
        'rejected',
        `${category.approvalAction} delivery failed: approval request could not be posted.`,
      );
      return { deferAck: true };
    }

    // Mark 'pending' so the delivery loop's dedup skips it; otherwise every
    // poll re-dispatches the gate and posts another card.
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => mailbox.markPending(requestId));

    return { deferAck: true };
  };
}

function createApprovalHandler(logPrefix: string) {
  return async function handleGateApproval(ctx: ApprovalHandlerContext): Promise<void | ApprovalDeclined> {
    const { payload, userId } = ctx;
    const p = payload as unknown as BashGatePayload;
    if (!p.requestId || !p.sessionId) {
      log.warn(`${logPrefix} gate approval with malformed payload`, { payload });
      return;
    }
    if (filedByEarlierContainer(p.sessionId, p.requestId)) {
      clearPending(p.requestId);
      try {
        await releaseActiveGate(p.sessionId, ctx.approval.approval_id);
        await writeGateAck(ctx.session, p.requestId, 'rejected', STOPPED_BEFORE_ANSWERED_ERROR);
      } catch (err) {
        log.warn('Failed to settle a gate whose container stopped', { requestId: p.requestId, err });
      }
      log.info(`${logPrefix} gate approved after its container stopped; nothing ran`, {
        requestId: p.requestId,
        userId,
      });
      return {
        declined:
          '⏭️ The agent stopped before this was answered, so nothing ran. It will ask again if it still needs this.',
      };
    }
    clearPending(p.requestId);
    sessionsWithActiveGates.delete(p.sessionId);
    await closeWithdrawOffers(ctx.approval.approval_id);

    const session = await getSession(p.sessionId);
    if (!session) {
      log.warn(`${logPrefix} gate approval for unknown session`, { sessionId: p.sessionId, requestId: p.requestId });
      return;
    }

    // Only invoked on Approve; Reject is handled in response-handler.ts.
    await writeGateAck(session, p.requestId, 'approved');
    log.info(`${logPrefix} gate approved`, { requestId: p.requestId, userId });
    // Best-effort, never awaited: an awaited rejection whose fallback notify
    // also fails leaves the approval row clickable, replaying the ack.
    void Promise.resolve(notifyAgent(session, `${logPrefix} gate approved: ${p.label}`)).catch((err) =>
      log.warn(`${logPrefix} gate approval notification failed`, { requestId: p.requestId, err }),
    );
  };
}

const BASH_GATE: GateCategory = {
  deliveryAction: 'request_bash_gate',
  approvalAction: 'bash-gate',
  defaultLabel: 'Bash command',
  defaultSummary: 'The agent wants to run a sensitive command.',
  logPrefix: 'Bash',
  titleEmoji: '⚠️',
  kindNoun: 'command',
  summaryMayStandForCommand: true,
};
const DESTRUCTIVE_GATE: GateCategory = {
  deliveryAction: 'request_destructive_gate',
  approvalAction: 'destructive-gate',
  defaultLabel: 'Destructive command',
  defaultSummary: 'The agent wants to run a destructive command.',
  logPrefix: 'Destructive',
  titleEmoji: '🛑',
  kindNoun: 'destructive command',
};
const PROD_GATE: GateCategory = {
  deliveryAction: 'request_prod_gate',
  approvalAction: 'prod-gate',
  defaultLabel: 'Change an owner or admin must approve',
  defaultSummary: 'The agent wants to make a change that only an owner or admin can approve.',
  logPrefix: 'Owner-or-admin',
  titleEmoji: '🚨',
  kindNoun: 'change',
  adminClickOnly: true,
};
const SEND_GATE: GateCategory = {
  deliveryAction: 'request_send_gate',
  approvalAction: 'send-gate',
  defaultLabel: 'Post in your name',
  defaultSummary: 'The agent wants to post as you.',
  logPrefix: 'Send',
  titleEmoji: '✉️',
  kindNoun: 'post',
  adminClickOnly: true,
  chatlessToSender: true,
  summaryMayStandForCommand: true,
};
const GATE_CATEGORIES = [BASH_GATE, DESTRUCTIVE_GATE, PROD_GATE, SEND_GATE];

for (const category of GATE_CATEGORIES) {
  registerDeliveryAction(
    category.deliveryAction,
    createGateHandler(category),
    unguarded(`request path only; execution waits for the registered ${category.approvalAction} approval handler`),
  );
  registerApprovalHandler(category.approvalAction, createApprovalHandler(category.logPrefix), {
    adminClickOnly: category.adminClickOnly,
  });
}
registerApprovalHandler(WITHDRAW_ACTION, handleWithdraw);

// A container polls for its gate's decision, and an agent's hook that stops waiting may run the command, so a
// reject is written as soon as the approval layer reports it.
registerApprovalResolvedHandler(async ({ approval, session, outcome }) => {
  if (outcome !== 'reject' || !isGateAction(approval.action)) return;
  await writeGateAck(session, approval.request_id, 'rejected', 'Rejected by an approver.');
  clearPending(approval.request_id);
  await releaseActiveGate(session.id, approval.approval_id);
  log.info('Gate rejected', { requestId: approval.request_id, action: approval.action });
});

/**
 * Times a gate out: the waiting command reads a timeout, and the card, if its row is still pending, says nothing ran.
 * Only an approve stops it. A reject whose own ack never landed still fails the gate here, and its row is left to the
 * reject's owner.
 */
async function expireGate(
  category: GateCategory,
  sessionId: string,
  requestId: string,
  session: Session | undefined,
  rowRequired = false,
): Promise<boolean> {
  const pending = await getApprovalByRequestId(requestId, sessionId, category.approvalAction);
  const rejected = pending?.status === 'rejected' || pending?.status === 'awaiting_reason';
  const claimed = !pending
    ? !rowRequired
    : rejected ||
      pending.status === 'expired' ||
      (await transitionPendingApprovalStatus(pending.approval_id, 'pending', 'expired'));
  if (!claimed) return false;
  log.warn(`${category.logPrefix} gate timed out`, { requestId, sessionId });
  if (session) {
    try {
      await writeGateAck(
        session,
        requestId,
        'timeout',
        `${category.logPrefix} gate timed out after ${BASH_GATE_TIMEOUT_MS / 60_000} minutes.`,
      );
    } catch (err) {
      if (!(err instanceof SessionDbMissingError || err instanceof SessionDbUnopenableError)) throw err;
    }
  }
  if (pending && !rejected) {
    await editApprovalCard(
      pending,
      `🕒 *${pending.title}* — timed out\n\nNo approval received within ${BASH_GATE_TIMEOUT_MS / 60_000} minutes. The ${category.kindNoun} was not run.`,
    );
    await deletePendingApproval(pending.approval_id);
  }
  if (!rejected) await releaseActiveGate(sessionId, pending?.approval_id ?? '');
  return true;
}

/**
 * Expires gates whose hour has passed with no timer left to do it (a host restart drops every armed timer), and
 * finishes any gate already claimed as expired whose cleanup failed part-way.
 */
export async function expireOverdueGates(now: number = Date.now()): Promise<number> {
  let expired = 0;
  for (const category of GATE_CATEGORIES) {
    for (const p of await getPendingApprovalsByAction(category.approvalAction)) {
      if (!p.session_id || pendingTimeouts.has(p.request_id)) continue;
      if (
        (p.status === 'approved' || p.status === 'rejected') &&
        gateAskedAtMs(p) + BASH_GATE_TIMEOUT_MS + GATE_HOOK_MARGIN_MS <= now
      ) {
        try {
          await closeAbandonedGate(category, p);
          expired++;
        } catch (err) {
          log.warn('Failed to close an abandoned gate', { approvalId: p.approval_id, err });
        }
        continue;
      }
      const overdue = p.status === 'pending' && gateAskedAtMs(p) + BASH_GATE_TIMEOUT_MS <= now;
      if (!overdue && p.status !== 'expired') continue;
      try {
        if (await expireGate(category, p.session_id, p.request_id, await getSession(p.session_id), true)) expired++;
      } catch (err) {
        log.warn('Failed to expire an overdue gate', { approvalId: p.approval_id, err });
      }
    }
  }
  return expired;
}

/**
 * Closes a gate whose answer was claimed but never finished: the host died, or the answer's own writes failed. Its
 * hook has stopped waiting by now, so no ack is written; for an approve, whether the command ran is only known in the
 * agent's thread.
 */
async function closeAbandonedGate(category: GateCategory, p: PendingApproval): Promise<void> {
  const outcome =
    p.status === 'rejected'
      ? `The ${category.kindNoun} was not run.`
      : `Check the agent's thread to see whether the ${category.kindNoun} ran.`;
  await editApprovalCard(p, `⏹️ *${p.title}* — closed\n\nThis answer was never finished being applied. ${outcome}`);
  await deletePendingApproval(p.approval_id);
  await releaseActiveGate(p.session_id!, p.approval_id);
  log.info('Closed a gate whose answer was never finished', { approvalId: p.approval_id, status: p.status });
}

export function _dropGateTimersForTesting(): void {
  for (const handle of pendingTimeouts.values()) clearTimeout(handle);
  pendingTimeouts.clear();
}

async function releaseActiveGate(sessionId: string, resolvedApprovalId: string): Promise<void> {
  await closeWithdrawOffers(resolvedApprovalId);
  const siblings = (await getPendingApprovalsBySession(sessionId)).filter(
    (p) => isGateAction(p.action) && p.approval_id !== resolvedApprovalId,
  );
  if (siblings.length === 0) sessionsWithActiveGates.delete(sessionId);
}

function isGateAction(action: string): boolean {
  return GATE_CATEGORIES.some((category) => category.approvalAction === action);
}

/**
 * Every producer stamps a request id with the container's clock at the moment it asked, and the host names a
 * container before starting it, so an id older than the current container's name came from a container that is gone.
 */
function requestedAtMs(requestId: string): number | null {
  const match = /^gate-(\d+)-/.exec(requestId);
  return match ? Number(match[1]) : null;
}

/**
 * True when no live container can be waiting on this request. A container is named before it starts, so with no
 * name the session either has no container or one still spawning, and neither filed this; an adopted survivor whose
 * name the runtime could not report may have, so it is given the benefit of the doubt.
 */
function filedByEarlierContainer(sessionId: string, requestId: string): boolean {
  const name = getContainerIdentity(sessionId);
  if (name === null) return !hasPendingAdoption(sessionId);
  const startedAt = containerStartedAtMs(name);
  const askedAt = requestedAtMs(requestId);
  return startedAt !== null && askedAt !== null && askedAt < startedAt;
}

const STOPPED_BEFORE_ANSWERED_ERROR = 'The agent stopped before this approval was answered.';
const STOPPED_BEFORE_POSTED_ERROR = 'The agent stopped before this approval request was posted.';
const EXPIRED_BEFORE_POSTED_ERROR = 'The approval window ran out before this request was posted.';

// The plugin's gate hook waits a minute past the host's timeout for the decision it writes.
const GATE_HOOK_MARGIN_MS = 2 * 60 * 1000;

/** Never later than the host's post time, so a future-dated id cannot stretch a gate. */
function gateAskedAtMs(p: PendingApproval): number {
  const postedAt = Date.parse(p.created_at);
  return Math.min(requestedAtMs(p.request_id) ?? postedAt, postedAt);
}

/**
 * When the session's open gate stops waiting, or null with none open. A container waiting on its gate does no
 * provider work, so its heartbeat goes quiet for up to the gate's whole window. Only gates its current container
 * filed count: an earlier container's card has nobody waiting on it.
 */
export async function openGateDeadlineMs(sessionId: string): Promise<number | null> {
  let deadline: number | null = null;
  for (const p of await getPendingApprovalsBySession(sessionId)) {
    if (!isGateAction(p.action) || filedByEarlierContainer(sessionId, p.request_id)) continue;
    const at = gateAskedAtMs(p) + BASH_GATE_TIMEOUT_MS + GATE_HOOK_MARGIN_MS;
    if (Number.isFinite(at)) deadline = Math.max(deadline ?? at, at);
  }
  return deadline;
}

const SUPERSEDED_ERROR = 'Superseded: the agent restarted and asked again.';

/** Closes the cards an earlier container of this session filed: that container is gone, so an answer reaches nobody. */
async function supersedeOrphanedGates(session: Session): Promise<void> {
  for (const p of await getPendingApprovalsBySession(session.id)) {
    if (!isGateAction(p.action) || !filedByEarlierContainer(session.id, p.request_id)) continue;
    try {
      await writeGateAck(session, p.request_id, 'rejected', SUPERSEDED_ERROR);
    } catch (err) {
      log.warn('Failed to settle superseded gate', { approvalId: p.approval_id, err });
    }
    clearPending(p.request_id);
    try {
      await editApprovalCard(
        p,
        `⏭️ *${p.title}* — superseded\n\nThe agent restarted before this was answered and asked again in a newer card. Answer that one.`,
      );
    } catch (err) {
      log.warn('Failed to edit superseded gate card', { approvalId: p.approval_id, err });
    }
    await deletePendingApproval(p.approval_id);
    await closeWithdrawOffers(p.approval_id);
    log.info('Gate superseded by a restarted container', { approvalId: p.approval_id, requestId: p.request_id });
  }
}

/**
 * Rejects one open gate outside the card: the waiting command reads `reason`, and the card shows `cardText`.
 * False when the gate was already answered, or its decision could not be written (its timeout still applies).
 */
async function settleGate(
  p: PendingApproval,
  session: Session,
  reason: string,
  cardText: string,
): Promise<'settled' | 'answered' | 'failed'> {
  if (!(await transitionPendingApprovalStatus(p.approval_id, 'pending', 'rejected'))) return 'answered';
  try {
    // request_id is the gate's own outbound message id, which the container polls on.
    await writeGateAck(session, p.request_id, 'rejected', reason);
  } catch (err) {
    await transitionPendingApprovalStatus(p.approval_id, 'rejected', 'pending');
    log.warn('Failed to settle a gate; its timeout still applies', { approvalId: p.approval_id, err });
    return 'failed';
  }
  clearPending(p.request_id);
  try {
    await editApprovalCard(p, cardText);
  } catch (err) {
    log.warn('Failed to edit a settled gate card', { approvalId: p.approval_id, err });
  }
  await deletePendingApproval(p.approval_id);
  await releaseActiveGate(session.id, p.approval_id);
  return 'settled';
}

interface WithdrawPayload {
  gateApprovalId: string;
  sender: string;
}

/**
 * A message into a session whose turn waits on a gate leaves the gate open; the agent reads the message once the
 * gate is answered or times out. A sender who cannot answer the gate gets a card only they can press to withdraw it,
 * since nothing else they can do frees the turn before the timeout.
 */
export async function offerGateWithdraw(sessionId: string, sender: string | null): Promise<void> {
  if (!sender) return;
  const session = await getSession(sessionId);
  if (!session) return;
  // The response handler's import chain reaches the router, which imports this module.
  const { canAnswerApproval } = await import('../approvals/response-handler.js');
  for (const gate of await getPendingApprovalsBySession(sessionId)) {
    if (!isGateAction(gate.action) || gate.status !== 'pending') continue;
    const requestId = `withdraw:${gate.approval_id}:${sender}`;
    if (offering.has(requestId)) continue;
    offering.add(requestId);
    try {
      if (await canAnswerApproval(gate, sender)) continue;
      if (await getApprovalByRequestId(requestId, sessionId, WITHDRAW_ACTION)) continue;
      await postWithdraw(session, gate, sender, requestId);
      // The gate may have been answered while the card was posted, after its settle closed the offers it could see.
      if ((await getPendingApproval(gate.approval_id))?.status !== 'pending')
        await closeWithdrawOffers(gate.approval_id);
    } finally {
      offering.delete(requestId);
    }
  }
}

async function postWithdraw(session: Session, gate: PendingApproval, sender: string, requestId: string): Promise<void> {
  const name = (await getUser(sender))?.display_name || sender;
  const payload: WithdrawPayload = { gateApprovalId: gate.approval_id, sender };
  await requestApproval({
    session,
    agentName: session.agent_group_id,
    action: WITHDRAW_ACTION,
    requestId,
    payload: payload as unknown as Record<string, unknown>,
    title: headUnits(`↩️ Withdraw: ${gate.title}`, GATE_CARD_TITLE_MAX_CHARS),
    question: `${name}, the agent reads your message once the card above is answered. Withdraw that card to stop it waiting now: nothing it asked for runs.`,
    deliveryTarget: 'thread',
    approverUserId: sender,
    options: WITHDRAW_OPTIONS,
  });
}

/** A Withdraw card whose gate was settled some other way is closed, so no live button is left behind. */
async function closeWithdrawOffers(gateApprovalId: string): Promise<void> {
  if (!gateApprovalId) return;
  for (const offer of await getPendingApprovalsByAction(WITHDRAW_ACTION)) {
    if (offer.status !== 'pending' || withdrawPayload(offer)?.gateApprovalId !== gateApprovalId) continue;
    if (!(await transitionPendingApprovalStatus(offer.approval_id, 'pending', 'rejected'))) continue;
    try {
      await editApprovalCard(
        offer,
        `${offer.title}\n\nThe card above is no longer waiting, so there is nothing to withdraw.`,
      );
    } catch (err) {
      log.warn('Failed to close a Withdraw card', { approvalId: offer.approval_id, err });
    }
    await deletePendingApproval(offer.approval_id);
  }
}

function withdrawPayload(offer: PendingApproval): Partial<WithdrawPayload> | null {
  try {
    return JSON.parse(offer.payload) as Partial<WithdrawPayload>;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a corrupt payload names no gate, so it is never closed here
  } catch {
    return null;
  }
}

async function handleWithdraw(ctx: ApprovalHandlerContext): Promise<void | ApprovalDeclined> {
  const { gateApprovalId } = ctx.payload as unknown as WithdrawPayload;
  const gate = typeof gateApprovalId === 'string' ? await getPendingApproval(gateApprovalId) : undefined;
  const session = gate ? await getSession(gate.session_id ?? '') : undefined;
  if (!gate || !session || !isGateAction(gate.action) || gate.status !== 'pending') {
    return { declined: 'That card was already answered, so there was nothing to withdraw.' };
  }
  const name = (await getUser(ctx.userId))?.display_name || ctx.userId;
  const settled = await settleGate(
    gate,
    session,
    `Withdrawn by ${name}.`,
    `↩️ *${gate.title}* — withdrawn\n\n${name} withdrew it before anyone answered. Nothing ran.`,
  );
  if (settled === 'answered') return { declined: 'That card was already answered, so there was nothing to withdraw.' };
  if (settled === 'failed')
    return { declined: 'It could not be withdrawn; the card above still times out on its own.' };
  log.info('Gate withdrawn by its requester', { approvalId: gate.approval_id, userId: ctx.userId });
}
