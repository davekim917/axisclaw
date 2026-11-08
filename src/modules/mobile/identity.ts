import { getDb } from '../../db/connection.js';
import { equivalentSlackUserIds } from '../../slack-user-identity.js';
import { rawUserId, userPlatform } from '../voice-call/group/place.js';

/** A raw Slack id means nothing in another workspace, so only a bot of the person's own one can vouch for them. */
export const inOwnWorkspace = (userId: string, channelType: string) =>
  userPlatform(userId) !== 'slack' || equivalentSlackUserIds(userId).includes(`${channelType}:${rawUserId(userId)}`);

/** The text after the first colon, as `rawUserId` reads it: this decides who someone is, so it never goes by a pattern. */
const RAW_ID_SQL = `SELECT id FROM users WHERE substr(id, instr(id, ':') + 1) = ?`;

/**
 * Every id the host holds for the person behind this one, which is theirs first: each bot records people under its
 * own channel type. Slack ids are scoped to a workspace, so those go by registered teamId; a Discord id is global.
 */
export async function identitiesOf(userId: string): Promise<string[]> {
  const candidates =
    userPlatform(userId) === 'discord'
      ? (await getDb().all<{ id: string }>(RAW_ID_SQL, rawUserId(userId)))
          .map(({ id }) => id)
          .filter((id) => userPlatform(id) === 'discord')
      : equivalentSlackUserIds(userId);
  const siblings = candidates.filter((id) => id !== userId);
  if (siblings.length === 0) return [userId];
  const known = await getDb().all<{ id: string }>(
    `SELECT id FROM users WHERE id IN (${siblings.map(() => '?').join(', ')})`,
    ...siblings,
  );
  return [userId, ...known.map(({ id }) => id)];
}
