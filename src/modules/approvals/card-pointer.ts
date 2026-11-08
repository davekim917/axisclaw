/**
 * A card posted into a thread is easy to miss, and a link to it can open only the channel, so the human who has to
 * answer it also gets a copy of the card in their DM, followed by where the original is. A copy that cannot be posted
 * falls back to the link alone. A card the asker can't answer goes to the workgroup's approvals channel instead, when
 * one is set, and to the DM when posting there fails.
 */
import { deriveHumanRequesterId } from '../../caller-identity.js';
import { getChannelAdapter } from '../../channels/channel-registry.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { getPendingApproval } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { PendingApproval, Session } from '../../types.js';
import { equivalentSlackUserIds } from '../../slack-user-identity.js';
import { getUser } from '../permissions/db/users.js';
import { cardOverrun, cardTextBudget } from './card-budget.js';
import { cardCopies, closeLateCardCopy, recordCardCopy, type ApprovalCardCopy } from './card-copies.js';
import { choiceApprovers, getChoiceHandler } from './choices.js';
import { approvalsChannelFor } from './approvals-channel.js';
import { headUnits, pickApprovalDelivery, pickApprover } from './primitive.js';
import { canAnswerApproval } from './response-handler.js';

export type CardPointerOutcome =
  | 'copied-requester'
  | 'copied-approver'
  | 'queued'
  | 'sent-requester'
  | 'sent-approver'
  | 'skipped-not-pending'
  | 'skipped-already-copied'
  | 'skipped-card-in-dm'
  | 'skipped-no-recipient'
  | 'failed';

const MAX_TITLE_UNITS = 150;

/** Called once per posted card, so the pending_approvals row is the dedupe key. */
export async function sendCardPointer(approvalId: string, session: Session): Promise<CardPointerOutcome> {
  try {
    return await pointAtCard(approvalId, session);
    // eslint-disable-next-line no-catch-all/no-catch-all -- fail-open is the contract: the card is already posted
  } catch (err) {
    log.warn('Card pointer DM failed', { approvalId, err });
    return 'failed';
  }
}

async function pointAtCard(approvalId: string, session: Session): Promise<CardPointerOutcome> {
  const approval = await getPendingApproval(approvalId);
  if (!approval || approval.status !== 'pending' || !approval.channel_type || !approval.platform_id) {
    return 'skipped-not-pending';
  }
  if (cardCopies(approval).length > 0) return 'skipped-already-copied';
  const cardMg = await getMessagingGroupByPlatform(
    approval.channel_type,
    approval.platform_id,
    approval.instance ?? undefined,
  );
  if (cardMg?.is_group === 0) return 'skipped-card-in-dm';

  const requester = await deriveHumanRequesterId(session);
  const requesterAnswers = requester !== null && (await canAnswerApproval(approval, requester));
  const adapter = getDeliveryAdapter();
  const link = permalinkOf(approval, approval.channel_type, approval.platform_id);
  const askedBy =
    requesterAnswers || !requester
      ? null
      : `${(await getUser(requester))?.display_name || 'The person who asked'} asked, and can't answer this card.`;

  const answerers = requesterAnswers ? [requester] : await answerersOf(approval);
  if (!requesterAnswers && answerers.length > 0 && adapter) {
    const queue = await approvalsChannelFor(approval.agent_group_id, approval.channel_type);
    const answersThere = (bot: string) =>
      answerers.some((a) => equivalentSlackUserIds(a).some((id) => id.startsWith(`${bot}:`)));
    if (queue && queue.platformId !== approval.platform_id && answersThere(queue.channelType)) {
      const from = link ?? (cardMg?.name ? `the thread in ${cardMg.name}` : 'the thread where it was asked');
      const send = (content: Record<string, unknown>) =>
        adapter.deliver(
          queue.channelType,
          queue.platformId,
          null,
          'chat-sdk',
          JSON.stringify(content),
          undefined,
          queue.channelType,
        );
      const question = [approval.question, `From ${from}.`, askedBy].filter(Boolean).join('\n\n');
      const at = { channel_type: queue.channelType, platform_id: queue.platformId, instance: queue.channelType };
      if (await postCopy(approval, at, send, { question, queue: true })) {
        log.info('Card posted to the approvals channel', { approvalId });
        return 'queued';
      }
      log.warn('Approvals channel post failed; sending the DM copy instead', { approvalId });
    }
  }

  const target = await pickApprovalDelivery(answerers, approval.channel_type, {
    instance: approval.instance ?? undefined,
  });
  if (!target || target.messagingGroup.platform_id === approval.platform_id) {
    log.info('Card pointer DM not sent: no reachable DM for anyone who can answer the card', {
      approvalId,
      requesterAnswers,
    });
    return 'skipped-no-recipient';
  }

  if (!adapter) {
    log.warn('Card pointer DM not sent: delivery adapter unavailable', { approvalId });
    return 'failed';
  }
  const dm = target.messagingGroup;
  const recipient = requesterAnswers ? 'requester' : 'approver';
  const send = (content: Record<string, unknown>) =>
    adapter.deliver(
      dm.channel_type,
      dm.platform_id,
      null,
      'chat-sdk',
      JSON.stringify(content),
      undefined,
      dm.instance ?? dm.channel_type,
    );

  if (await postCopy(approval, { ...dm, instance: dm.instance ?? null }, send)) {
    const original =
      link ?? (cardMg?.name ? `the card in ${cardMg.name}` : 'the card in the thread where it was asked');
    const note = [`This is a copy of ${original}; answering either one closes both.`, askedBy].filter(Boolean);
    await send({ text: note.join('\n') }).catch((err: unknown) =>
      log.warn('Card copy posted, but its note did not send', { approvalId, err }),
    );
    log.info('Card copy DM sent', { approvalId, recipient });
    return requesterAnswers ? 'copied-requester' : 'copied-approver';
  }

  const where =
    link ?? (cardMg?.name ? `the card is in ${cardMg.name}.` : 'the card is in the thread where it was asked.');
  const lines = [`Your call is needed: ${headUnits(approval.title, MAX_TITLE_UNITS)} — ${where}`, askedBy];
  await send({ text: lines.filter(Boolean).join('\n') });
  log.info('Card pointer DM sent', { approvalId, recipient });
  return requesterAnswers ? 'sent-requester' : 'sent-approver';
}

/**
 * Posts the card itself into a DM or the approvals channel and records it, so a click there counts. A copy on a
 * platform that shows less than the card's own (a Slack card in a Discord DM) is posted only when it fits there. A
 * copy that lands once the card is no longer pending is closed straight away, since the answer's edit may have missed
 * it.
 */
async function postCopy(
  approval: PendingApproval,
  at: Pick<ApprovalCardCopy, 'channel_type' | 'platform_id' | 'instance'>,
  send: (content: Record<string, unknown>) => Promise<string | undefined>,
  options: { question?: string; queue?: true } = {},
): Promise<boolean> {
  const question = options.question ?? approval.question;
  const smaller = cardTextBudget(at.channel_type) < cardTextBudget(approval.channel_type);
  if (smaller && cardOverrun(at.channel_type, approval.title, question) > 0) {
    log.info('Card copy not posted: it would not show whole there', {
      approvalId: approval.approval_id,
      channelType: at.channel_type,
    });
    return false;
  }
  let messageId: string | undefined;
  try {
    messageId = await send({
      type: 'ask_question',
      questionId: approval.approval_id,
      title: approval.title,
      question,
      options: JSON.parse(approval.options_json) as unknown,
    });
    // eslint-disable-next-line no-catch-all/no-catch-all -- a copy that fails to post falls back to the next surface
  } catch (err) {
    log.warn('Card copy failed to post', { approvalId: approval.approval_id, platformId: at.platform_id, err });
    return false;
  }
  if (!messageId) {
    log.warn('Card copy gave no message id', { approvalId: approval.approval_id, platformId: at.platform_id });
    return false;
  }
  const copy: ApprovalCardCopy = {
    channel_type: at.channel_type,
    platform_id: at.platform_id,
    instance: at.instance,
    platform_message_id: messageId,
    ...(options.queue ? { queue: true as const } : {}),
  };
  const recorded = await recordCardCopy(approval.approval_id, copy);
  const now = await getPendingApproval(approval.approval_id);
  if (!recorded || !now || now.status !== 'pending') {
    await closeLateCardCopy(
      approval.approval_id,
      copy,
      `${[approval.title, approval.question].filter(Boolean).join('\n\n')}\n\nNo longer open.`,
    ).catch((err: unknown) => log.warn('Could not close a late card copy', { approvalId: approval.approval_id, err }));
  }
  return true;
}

async function answerersOf(approval: PendingApproval): Promise<string[]> {
  const named = approval.approver_user_id
    ? [approval.approver_user_id]
    : getChoiceHandler(approval.action)
      ? choiceApprovers(approval)
      : undefined;
  const answerers: string[] = [];
  for (const userId of named ?? (await pickApprover(approval.agent_group_id))) {
    if (await canAnswerApproval(approval, userId)) answerers.push(userId);
  }
  return answerers;
}

function permalinkOf(approval: PendingApproval, channelType: string, platformId: string): string | null {
  const adapter = getChannelAdapter(approval.instance ?? channelType);
  return approval.platform_message_id
    ? (adapter?.messagePermalink?.(platformId, approval.thread_id, approval.platform_message_id) ?? null)
    : null;
}
