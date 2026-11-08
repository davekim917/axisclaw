/**
 * A workgroup's shared approvals channel: where a card goes when the person who asked can't answer it, so every
 * approver sees one live queue instead of one person's DM. Unset keeps the DM copy.
 */
import { getKnownSlackBots } from '../../channels/slack-mentions.js';
import { getDb } from '../../db/connection.js';

export interface ApprovalsChannel {
  /** The bot that posts and deletes there; it must be a member of the channel. */
  channelType: string;
  platformId: string;
}

function parse(raw: string | null | undefined): ApprovalsChannel | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<ApprovalsChannel> | null;
    return typeof parsed?.channelType === 'string' &&
      !!parsed.channelType &&
      typeof parsed.platformId === 'string' &&
      !!parsed.platformId
      ? { channelType: parsed.channelType, platformId: parsed.platformId }
      : null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a corrupt setting names no channel, so the DM copy is used
  } catch {
    return null;
  }
}

export async function getWorkgroupApprovalsChannel(workgroupId: string): Promise<ApprovalsChannel | null> {
  const row = await getDb().get<{ approvals_channel: string | null }>(
    'SELECT approvals_channel FROM workgroups WHERE id = ?',
    workgroupId,
  );
  return parse(row?.approvals_channel);
}

/**
 * The approvals channel of the agent group's workgroup, when it is in the same workspace as the card: a card is never
 * copied into another tenant's channel, whatever a workgroup names.
 */
export async function approvalsChannelFor(
  agentGroupId: string | null,
  cardChannelType: string,
): Promise<ApprovalsChannel | null> {
  if (!agentGroupId) return null;
  const row = await getDb().get<{ approvals_channel: string | null }>(
    'SELECT w.approvals_channel FROM workgroups w JOIN agent_groups a ON a.workgroup_id = w.id WHERE a.id = ?',
    agentGroupId,
  );
  const channel = parse(row?.approvals_channel);
  return channel && sameWorkspace(channel.channelType, cardChannelType) ? channel : null;
}

/** A non-Slack bot can span tenants (one Discord bot is in many guilds), so only a shared Slack team counts. */
function sameWorkspace(a: string, b: string): boolean {
  const bots = getKnownSlackBots();
  const teamA = bots.get(a)?.teamId;
  return !!teamA && teamA === bots.get(b)?.teamId;
}

export async function setWorkgroupApprovalsChannel(
  workgroupId: string,
  channel: ApprovalsChannel | null,
): Promise<void> {
  if (channel && !getKnownSlackBots().has(channel.channelType)) {
    throw new Error(`Approvals channels are Slack only, and "${channel.channelType}" is not a running Slack bot here.`);
  }
  if (channel && !/^slack:[A-Z0-9]+$/.test(channel.platformId)) {
    throw new Error('--channel takes a Slack channel id as slack:<channel-id>, e.g. slack:C0EXAMPLE1.');
  }
  const result = await getDb().run(
    'UPDATE workgroups SET approvals_channel = ? WHERE id = ?',
    channel ? JSON.stringify(channel) : null,
    workgroupId,
  );
  if (result.changes === 0) throw new Error(`No workgroup: ${workgroupId}`);
}
