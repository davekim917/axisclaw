/**
 * `ncl approvals choose`: the owner answers a choice card (release, migration, approved run) from the host terminal.
 */
import { getPendingApproval } from '../../db/sessions.js';
import { log } from '../../log.js';
import { notifyOwner } from '../../notify-owner.js';
import { equivalentSlackUserIds } from '../../slack-user-identity.js';
import type { PendingApproval } from '../../types.js';
import { getOwners } from '../permissions/db/user-roles.js';
import {
  choiceApprovers,
  choiceClickAllowed,
  choiceOptions,
  getChoiceHandler,
  resolveChoice,
  type ChoiceOutcome,
} from './choices.js';
import { ONECLI_ACTION } from './onecli-approvals.js';
import { answerRefusal, onlyNamed } from './response-handler.js';

/**
 * `ncl approvals choose`: the owner answers a choice card from the host. It resolves exactly as the owner's own click
 * on that card would, under the id that click would carry, and passes the same approver and privilege check; it never
 * answers for anyone else. Callers MUST have rejected agent-originated requests.
 */
export async function chooseFromHost(
  approvalId: string,
  value: string,
  origin: readonly string[] = [],
): Promise<{ resolved: true; userId: string; label: string; uncounted: boolean } | { resolved: false; error: string }> {
  const refuse = (error: string) => ({ resolved: false as const, error });
  const approval = await getPendingApproval(approvalId);
  if (!approval) return refuse(`No open card ${approvalId}: it was already answered, expired, or never existed.`);
  if (approval.action === ONECLI_ACTION) {
    return refuse('OneCLI credential approvals resolve through the gateway flow, not the CLI.');
  }
  if (!getChoiceHandler(approval.action)) {
    return refuse(`${approvalId} is not a choice card; answer it with approvals approve or reject.`);
  }
  if (approval.status !== 'pending') return refuse(`${approvalId} was already answered.`);
  if (!approval.platform_message_id) return refuse(`${approvalId} has not been posted yet, so it cannot be answered.`);
  const option = choiceOptions(approval).find((o) => o.value === value);
  if (!option) {
    const values = choiceOptions(approval).map((o) => o.value);
    return refuse(`"${value}" is not an option on this card. Its options are: ${values.join(', ') || '(none)'}.`);
  }

  const owner = await ownerOnCard(approval);
  if ('error' in owner) return refuse(owner.error);
  const refusal = await answerRefusal(approval, owner.userId, false);
  if (refusal) return refuse(refusal);

  let outcome: ChoiceOutcome;
  try {
    outcome = await resolveChoice(approval, value, owner.userId, undefined, 'host');
  } catch (err) {
    await tellOwnerOfHostAnswer(approval, option.label, owner.userId, 'failed', origin);
    throw err;
  }
  await tellOwnerOfHostAnswer(approval, option.label, owner.userId, outcome, origin);
  switch (outcome) {
    case 'resolved':
      return { resolved: true, userId: owner.userId, label: option.label, uncounted: false };
    case 'uncounted':
      return { resolved: true, userId: owner.userId, label: option.label, uncounted: true };
    case 'already_answered':
      return refuse(`${approvalId} was already answered.`);
    case 'undelivered':
      return refuse('No live session could take the answer, so the card stays open. Nothing was decided.');
    case 'unknown_option':
      return refuse(`"${value}" is not an option on this card.`);
  }
}

const HOST_ANSWER_OUTCOME: Record<ChoiceOutcome | 'failed', string> = {
  failed: 'It failed partway, so whether it was recorded is unknown: check the card and the session.',
  resolved: 'It counted.',
  uncounted: 'It was recorded but did not count: the release card is out of date.',
  already_answered: 'It did not count: someone answered first.',
  undelivered: 'It did not count: no live session could take it, so the card is still open.',
  unknown_option: 'It did not count: the option is not on the card.',
};

/**
 * Every host answer that tried to decide as the owner reaches the owner, whatever its outcome, so a use they did not
 * make is seen: detection, not prevention. The answer stands whether or not this notice is delivered.
 */
async function tellOwnerOfHostAnswer(
  approval: PendingApproval,
  label: string,
  userId: string,
  outcome: ChoiceOutcome | 'failed',
  origin: readonly string[],
): Promise<void> {
  const body = [
    `"${approval.title}" (${approval.approval_id}) was answered as you (${userId}) from the host: ${label}.`,
    HOST_ANSWER_OUTCOME[outcome],
    'Run by (nearest process first, as the caller reported it):',
    ...(origin.length > 0 ? origin.map((line) => `• ${line}`) : ['• not reported']),
  ].join('\n');
  try {
    const sent = await notifyOwner({ title: 'A card was answered as you from the host', body });
    if (sent.code !== 0) {
      log.warn('Owner was not told of a host answer', { approvalId: approval.approval_id, reason: sent.message });
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- the answer stands whether or not the notice reached the owner
  } catch (err) {
    log.warn('Owner was not told of a host answer', { approvalId: approval.approval_id, err });
  }
}

/**
 * The owner's id as a click on this card would carry it: the card's own channel form of an owner identity (a
 * same-workspace Slack sibling counts, as it does for a click). On a card that names approvers, only an owner form
 * the card lists.
 */
async function ownerOnCard(approval: PendingApproval): Promise<{ userId: string } | { error: string }> {
  const channelType = approval.channel_type;
  if (!channelType) return { error: 'This card has no channel, so no click could answer it.' };
  const forms = new Set<string>();
  for (const { user_id } of await getOwners()) {
    for (const id of equivalentSlackUserIds(user_id)) if (id.startsWith(`${channelType}:`)) forms.add(id);
  }
  const approvers = choiceApprovers(approval);
  const candidates = [...forms].filter((id) => choiceClickAllowed(approval, id));
  if (candidates.length === 0) {
    return approvers === undefined
      ? { error: `The owner has no identity on this card's channel (${channelType}), so cannot answer it.` }
      : { error: `The owner is not among this card's approvers. ${await onlyNamed(approvers)}` };
  }
  if (candidates.length > 1) {
    return {
      error: `More than one owner identity could answer this card (${candidates.join(', ')}); answer on the card.`,
    };
  }
  return { userId: candidates[0] };
}
