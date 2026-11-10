import { formatParticipantList, type ParticipantListStyle, storedGroupDmMembers } from '../../channels/adapter.js';
import {
  getKnownSlackBots,
  getKnownSlackHumans,
  type SlackBotIdentity,
  slackShownName,
} from '../../channels/slack-mentions.js';
import { platformOf, rawUserId } from '../voice-call/group/place.js';

/**
 * Slack names a group DM `mpdm-<handle>--<handle>--…-<n>`, by every member's legacy username, and the host stores no
 * other mark of one: the adapter's metadata fetch leaves `is_group` at 0 and the name as that slug.
 */
const SLACK_GROUP_DM_RE = /^mpdm-(.+)-\d+$/;
const APP_PARTICIPANTS: ParticipantListStyle = { max: 3, rest: 'others' };

export type ChannelNamer = (mg: { channel_type: string; channel_name: string | null | undefined }) => string | null;

interface Workspace {
  humans: SlackBotIdentity[];
  bots: SlackBotIdentity[];
}

/** Every channel name the app shows, for the person paired as `viewerId`, who is left out of a group DM's name. */
export function channelNamer(viewerId: string): ChannelNamer {
  const viewer = rawUserId(viewerId);
  return ({ channel_type, channel_name }) => {
    if (!channel_name) return null;
    const name = channel_name.replace(/^#/, '');
    const groupDm =
      platformOf(channel_type) === 'slack' ? slackGroupDmName(name, workspaceOf(channel_type), viewer) : null;
    return groupDm ?? `#${name}`;
  };
}

function workspaceOf(channelType: string): Workspace {
  const bots = getKnownSlackBots();
  const teamId = bots.get(channelType)?.teamId;
  if (!teamId) return { humans: [], bots: [] };
  return {
    humans: [...(getKnownSlackHumans().get(teamId) ?? [])],
    bots: [...bots.values()].filter((bot) => bot.teamId === teamId),
  };
}

function slackGroupDmName(name: string, workspace: Workspace, viewer: string): string | null {
  const stored = storedGroupDmMembers(name);
  if (stored) return fromStoredNames(stored, workspace.humans, viewer);
  const handles = SLACK_GROUP_DM_RE.exec(name)?.[1].split('--');
  if (!handles || handles.length < 2 || !handles.every(Boolean)) return null;
  const members = [...workspace.humans, ...workspace.bots];
  const names = handles.flatMap((handle) => {
    const member = members.find((identity) => identity.username.toLowerCase() === handle.toLowerCase());
    if (member?.userId === viewer) return [];
    return [(member && slackShownName(member)) || handle];
  });
  return groupDm(names, names.length);
}

/**
 * The paired person is left out only when every listed name is a roster name, so the list split cleanly, and no one
 * else in the workspace shares theirs. Otherwise the stored list is shown as it stands, with them in it.
 */
function fromStoredNames(
  stored: { names: string[]; total: number; listed: string },
  humans: SlackBotIdentity[],
  viewer: string,
): string {
  const rosterNames = humans.map((human) => slackShownName(human));
  const own = humans.find((human) => human.userId === viewer);
  const ownName = own ? slackShownName(own) : null;
  const reliable =
    ownName !== null &&
    stored.names.every((listed) => rosterNames.includes(listed)) &&
    rosterNames.filter((rosterName) => rosterName === ownName).length === 1;
  if (!reliable) return `Group DM with ${stored.listed}`;
  const names = stored.names.filter((listed) => listed !== ownName);
  return groupDm(names, stored.total - (stored.names.length - names.length));
}

function groupDm(names: string[], total: number): string {
  if (names.length === 0) return 'Group DM';
  const sorted = [...names].sort((a, b) => a.localeCompare(b));
  return `Group DM with ${formatParticipantList(sorted, APP_PARTICIPANTS, total)}`;
}
