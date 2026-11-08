/**
 * An approval card can be posted in more than one place: the card itself, and a copy in the DM of whoever has to
 * answer it or in the workgroup's approvals channel. Only the host records a copy, so a click counts on the card or
 * on a recorded copy, never on a card an agent posted with the same approval id.
 */
import { getPendingApproval, updatePendingApprovalCardCopies } from '../../db/sessions.js';
import { getDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import type { PendingApproval } from '../../types.js';

export interface ApprovalCardCopy {
  channel_type: string;
  platform_id: string;
  instance: string | null;
  platform_message_id: string;
  /** A copy in the workgroup's approvals channel, deleted rather than edited once the card resolves. */
  queue?: true;
}

function isCopy(raw: unknown): raw is ApprovalCardCopy {
  if (!raw || typeof raw !== 'object') return false;
  const c = raw as Record<string, unknown>;
  return (
    typeof c.channel_type === 'string' &&
    !!c.channel_type &&
    typeof c.platform_id === 'string' &&
    !!c.platform_id &&
    typeof c.platform_message_id === 'string' &&
    !!c.platform_message_id &&
    (c.instance === null || typeof c.instance === 'string') &&
    (c.queue === undefined || c.queue === true)
  );
}

export function cardCopies(approval: Pick<PendingApproval, 'card_copies'>): ApprovalCardCopy[] {
  try {
    const parsed: unknown = JSON.parse(approval.card_copies ?? '[]');
    return Array.isArray(parsed) ? parsed.filter(isCopy) : [];
    // eslint-disable-next-line no-catch-all/no-catch-all -- a corrupt list names no copies, so none of their clicks count
  } catch {
    return [];
  }
}

/** The recorded copy a click was made on: same channel, same conversation, same message. */
export function clickedCopy(
  approval: Pick<PendingApproval, 'card_copies'>,
  click: { channelType: string; platformId: string; messageId?: string | null },
): ApprovalCardCopy | undefined {
  if (!click.platformId || !click.messageId) return undefined;
  return cardCopies(approval).find(
    (c) =>
      c.platform_id === click.platformId &&
      c.platform_message_id === click.messageId &&
      (c.channel_type === click.channelType || c.instance === click.channelType),
  );
}

/** Records one more copy of the card; false when the approval is gone. The card pointer is the only caller. */
export async function recordCardCopy(approvalId: string, copy: ApprovalCardCopy): Promise<boolean> {
  const current = await getPendingApproval(approvalId);
  if (!current) return false;
  return updatePendingApprovalCardCopies(approvalId, JSON.stringify([...cardCopies(current), copy]));
}

export interface CardPlace {
  channelType: string;
  platformId: string;
  threadId: string | null;
  messageId: string;
  instance: string;
  queue?: true;
}

export function copyPlace(copy: ApprovalCardCopy): CardPlace {
  return {
    channelType: copy.channel_type,
    platformId: copy.platform_id,
    threadId: null,
    messageId: copy.platform_message_id,
    instance: copy.instance ?? copy.channel_type,
    ...(copy.queue ? { queue: true as const } : {}),
  };
}

/**
 * Shows `newBody` with no buttons in one place. An approvals-channel copy is deleted instead, so that channel holds
 * only open cards; one that cannot be deleted is closed in place like any other.
 */
export async function closeCardPlace(
  adapter: ChannelDeliveryAdapter,
  approvalId: string,
  place: CardPlace,
  newBody: string,
): Promise<void> {
  if (place.queue && adapter.deleteMessage) {
    try {
      await adapter.deleteMessage(place.channelType, place.platformId, place.threadId, place.messageId, place.instance);
      return;
      // eslint-disable-next-line no-catch-all/no-catch-all -- any failed delete falls back to closing the card in place
    } catch (err) {
      log.warn('Could not delete an approvals-channel card; closing it in place', { approvalId, err });
    }
  }
  await adapter.deliver(
    place.channelType,
    place.platformId,
    place.threadId,
    'chat-sdk',
    JSON.stringify({ operation: 'edit', messageId: place.messageId, text: newBody, clearActions: true }),
    undefined,
    place.instance,
  );
}

export async function closeLateCardCopy(approvalId: string, copy: ApprovalCardCopy, newBody: string): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (adapter) await closeCardPlace(adapter, approvalId, copyPlace(copy), newBody);
}
