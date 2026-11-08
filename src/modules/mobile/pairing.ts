import { randomBytes } from 'crypto';

import { canAccessAgentGroup } from '../permissions/access.js';
import { deriveHumanRequest, resolveRequester, type HumanRequest } from '../../caller-identity.js';
import { PREVIEW_ORIGIN_SUFFIX, TIMEZONE } from '../../config.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { formatLocalTime } from '../../timezone.js';
import type { Session } from '../../types.js';
import { getUser } from '../permissions/db/users.js';
import { ensureUserDm } from '../permissions/user-dm.js';
import { userPlatform } from '../voice-call/group/place.js';
import { deliverText, dmRoute } from '../voice-call/service.js';
import { createDevice, sha256 } from './devices.js';
import { identitiesOf } from './identity.js';

const CODE_TTL_MS = 10 * 60_000;

interface PendingCode {
  userId: string;
  expiresAt: number;
  dm: Parameters<typeof dmRoute>[0];
}

/** By the code's hash, so a process dump holds no working code. In memory on purpose: a host restart expires them. */
const pending = new Map<string, PendingCode>();

export const appHost = () => `app.${PREVIEW_ORIGIN_SUFFIX}`;

function issueCode(userId: string, dm: PendingCode['dm']): { code: string; hash: string; expiresAt: number } {
  for (const [hash, entry] of pending) if (entry.userId === userId) pending.delete(hash);
  const code = randomBytes(32).toString('base64url');
  const hash = sha256(code);
  const expiresAt = Date.now() + CODE_TTL_MS;
  pending.set(hash, { userId, expiresAt, dm });
  return { code, hash, expiresAt };
}

/** Spends the code before anything awaits, so two racing requests cannot both redeem it. */
function spendCode(code: string): PendingCode | null {
  const hash = sha256(code);
  const entry = pending.get(hash);
  pending.delete(hash);
  return entry && Date.now() <= entry.expiresAt ? entry : null;
}

/** The host picks the person from the thread's latest human message, never from the agent. */
async function askerIn(input: {
  sessionId: string;
  agentGroupId: string;
}): Promise<{ session: Session; request: HumanRequest }> {
  const session = await getSession(input.sessionId);
  if (!session || session.agent_group_id !== input.agentGroupId)
    throw new Error('This command runs from a conversation thread.');
  const request = await deriveHumanRequest(session);
  if (!request) throw new Error('No person has asked in this thread, so there is no one to act for.');
  return { session, request };
}

/**
 * Every id of the one person asking, for a verb that reads or changes that person's devices. Stricter than pairing,
 * which only sends a link to someone's own DM: a spoken request names nobody, so this refuses rather than guess.
 */
export async function askerIds(input: { sessionId: string; agentGroupId: string }): Promise<string[]> {
  const session = await getSession(input.sessionId);
  if (!session || session.agent_group_id !== input.agentGroupId)
    throw new Error('This command runs from a conversation thread.');
  const requester = await resolveRequester(session);
  if (requester.kind !== 'one')
    throw new Error('Could not tell who is asking. Ask them to type the request in a thread of their own.');
  return identitiesOf(requester.userId);
}

/**
 * Sends the person in this thread a one-time link that pairs the app as them, the same trust model as `ncl voice
 * call`: the link speaks only as that person and goes only to their DM. Its code never comes back to the agent, and
 * thread history drops it, but anything that can read that DM can read it, which is why redeeming one DMs the person.
 */
export async function pairFromThread(input: { sessionId: string; agentGroupId: string }): Promise<{
  sentTo: string;
  expiresAt: string;
}> {
  if (!PREVIEW_ORIGIN_SUFFIX) throw new Error('The app is not set up on this host.');
  const { session, request } = await askerIn(input);
  const { userId } = request;
  if (!userPlatform(userId)) throw new Error('The app pairs from Slack or Discord.');
  const access = await canAccessAgentGroup(userId, input.agentGroupId);
  if (!access.allowed) throw new Error('Only people who can talk to this agent can pair the app from it.');
  const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const dm = await ensureUserDm(userId, { instance: mg?.instance ?? mg?.channel_type, privacySafeLogs: true });
  if (!dm) throw new Error('Could not open a DM to send the pairing link.');
  const user = await getUser(userId);

  const { code, hash, expiresAt } = issueCode(userId, dm);
  const until = new Date(expiresAt).toISOString();
  const sent = await deliverText(
    dmRoute(dm),
    `📱 Open this on your phone to pair the Anderton app: https://${appHost()}/pair#${code}\nIt works once and expires at ${formatLocalTime(until, TIMEZONE)}. Anyone with this link signs in as you, so don't forward it.`,
  ).then(
    () => true,
    () => false,
  );
  if (!sent) {
    // The adapter's error is dropped on purpose: it can quote the message, and what is thrown here reaches the agent.
    pending.delete(hash);
    log.warn('Mobile: pairing link could not be sent', { agentGroupId: input.agentGroupId });
    throw new Error('Could not send the pairing link.');
  }
  log.info('Mobile: pairing link sent', { agentGroupId: input.agentGroupId });
  return { sentTo: user?.display_name || 'Someone', expiresAt: until };
}

/**
 * DMs the person a link that lets the device that asked send replies as them. The link carries only a claim that
 * device alone can redeem, so the DM is how the person shows the device is theirs; it never reaches an agent.
 */
export async function sendReplyLink(userId: string, claim: string, expiresAt: number): Promise<boolean> {
  const dm = await ensureUserDm(userId, { privacySafeLogs: true });
  if (!dm) return false;
  const until = new Date(expiresAt).toISOString();
  const sent = await deliverText(
    dmRoute(dm),
    `📱 Open this on the phone that asked, to let the Anderton app send replies as you: https://${appHost()}/replies#${claim}\nIt works once, only on that phone, and expires at ${formatLocalTime(until, TIMEZONE)}. If you didn't ask for it, ignore it.`,
  ).then(
    () => true,
    () => false,
  );
  log[sent ? 'info' : 'warn'](sent ? 'Mobile: reply link sent' : 'Mobile: reply link could not be sent');
  return sent;
}

export async function redeemCode(code: string, label: string | null) {
  const spent = spendCode(code);
  const user = spent ? await getUser(spent.userId) : undefined;
  const platform = user && userPlatform(user.id);
  if (!spent || !user || !platform) return null;
  const { key, deviceId } = await createDevice(user.id, label);
  log.info('Mobile: device paired', { deviceId });
  void deliverText(
    dmRoute(spent.dm),
    `📱 A phone${label ? ` (${label})` : ''} just paired with the Anderton app as you. If that wasn't you, tell any agent to revoke it.`,
  ).catch(() => log.warn('Mobile: pairing notice could not be sent', { deviceId }));
  return { key, deviceId, userName: user.display_name || 'Someone', platform };
}
