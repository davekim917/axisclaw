import { randomBytes } from 'crypto';
import { ProxyAgent, fetch as undiciFetch } from 'undici';

import { getKnownSlackBots } from '../../channels/slack-mentions.js';
import { extractSlackChannelId } from '../../channels/slack.js';
import { PREVIEW_ORIGIN_SUFFIX } from '../../config.js';
import { readContainerConfig } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { agentProxyUrl } from '../../onecli-agent-proxy.js';
import type { OnecliInjectionSpec } from '../../onecli-secret-writer.js';
import { mergeWorkgroupAndGroupSecrets, secretsHeldBy, slackUserTokenSecrets } from '../../onecli-secrets.js';
import { isReservedAgent, reservedTokenName } from '../../reserved-secrets.js';
import { putReservedToken, ReservedTokenMayBeLive } from '../../reserved-token-store.js';
import { postsSince } from '../../message-archive.js';
import {
  FILES_NOT_ALLOWED,
  NO_ANSWER,
  slackReplyApiFor,
  type SlackReplyApi,
  type SlackResult,
} from '../../slack-user-api.js';
import { getWorkgroupAccessForGroup } from '../../workgroup-access.js';
import { ensureUserDm } from '../permissions/user-dm.js';
import { rawUserId } from '../voice-call/group/place.js';
import { deliverText, dmRoute } from '../voice-call/service.js';
import { sha256, type MobileDevice } from './devices.js';
import { identitiesOf } from './identity.js';
import { appHost } from './pairing.js';
import { issueClaim, type ClaimReady, type Recipient, type ReplyTarget, type SendOutcome } from './reply.js';
import type { ThreadToRead } from './threads.js';

/** Holds the Slack app's client id and secret as one HTTP Basic value, injected only on the code exchange. */
const OAUTH_AGENT = 'approved-run-slack-send-oauth';
/** Registered on the Slack app as its one redirect URL, on the app host. */
export const CALLBACK_PATH = '/slack/oauth/callback';
const SLACK_API = 'https://slack.com/api/';
const CHAT_SCOPE = 'chat:write';
const FILE_SCOPE = 'files:write';
/** What Connect asks for. A token granted the first alone still posts words. */
const USER_SCOPES = [CHAT_SCOPE, FILE_SCOPE];
/**
 * Every Slack method, for a connected token: what it may do is its own scopes and the calls the reply client has
 * (`SlackReplyApi`), and only the host uses it.
 */
const CONNECT_PATH = '/api/*';
const CONNECT_TTL_MS = 10 * 60_000;
const EXCHANGE_TIMEOUT_MS = 30_000;
const SLACK_USER_RE = /^[UW][A-Z0-9]+$/;
const SLACK_TEAM_RE = /^T[A-Z0-9]+$/;
const SLACK_TS_RE = /^\d{9,11}\.\d{6}$/;
/** A thread screen asks for its reply box on every poll; a send always asks Slack afresh. */
const SHOWN_PROOF_TTL_MS = 5 * 60_000;
const FILES_NEED_RECONNECT = 'This Slack token cannot send files. Reconnect Slack to send files. Nothing was posted.';
/** Slack's answers that mean the person's token no longer works, so the app offers Connect Slack again. */
const TOKEN_GONE = new Set(['invalid_auth', 'not_authed', 'token_revoked', 'token_expired', 'account_inactive']);

/**
 * The Slack app people connect, and the one workspace it is installed in. There a person posts only through the token
 * they connected, so either empty turns replying off in that workspace. Its client secret is a reserved vault token,
 * never configuration.
 */
const envFile = readEnvFile(['MOBILE_SLACK_SEND_CLIENT_ID', 'MOBILE_SLACK_SEND_TEAM_ID']);
const setting = (name: keyof typeof envFile) => (process.env[name] || envFile[name] || '').trim();
const clientId = () => setting('MOBILE_SLACK_SEND_CLIENT_ID');
const sendTeam = () => setting('MOBILE_SLACK_SEND_TEAM_ID');

const configured = () => clientId() !== '' && SLACK_TEAM_RE.test(sendTeam()) && PREVIEW_ORIGIN_SUFFIX !== '';
const hasSendApp = (teamId: string) => teamId === sendTeam();

interface Sender {
  teamId: string;
  slackUserId: string;
}

/** The person behind a pairing, as a user of the workspace a bot registered them in. Never chosen by the device. */
async function senderOf(pairedId: string): Promise<Sender | null> {
  const bots = getKnownSlackBots();
  for (const id of await identitiesOf(pairedId)) {
    const teamId = bots.get(id.slice(0, id.indexOf(':')))?.teamId;
    const slackUserId = rawUserId(id);
    if (teamId && SLACK_TEAM_RE.test(teamId) && SLACK_USER_RE.test(slackUserId)) return { teamId, slackUserId };
  }
  return null;
}

/** In a workspace with no send app, a phone is set up to send by a link DMed to the person, as on Discord. */
export async function enablesByLink(device: MobileDevice): Promise<boolean> {
  const sender = await senderOf(device.user_id);
  return sender !== null && !hasSendApp(sender.teamId);
}

/** The OneCLI agent holding one person's token: reserved, so no container may run as it and no group be granted it. */
function personAgent({ teamId, slackUserId }: Sender): string | null {
  const agent = `approved-run-slack-send-${teamId}-${slackUserId}`.toLowerCase();
  return isReservedAgent(agent) ? agent : null;
}

const tokenInjection = (agent: string): OnecliInjectionSpec => ({
  name: reservedTokenName(agent),
  hostPattern: 'slack.com',
  pathPattern: CONNECT_PATH,
  headerName: 'Authorization',
  valueFormat: 'Bearer {value}',
});

interface Exchanged {
  teamId: string;
  userId: string;
  token: string;
  scopes: string[];
  rotating: boolean;
}

/** Through the gateway as the reserved OAuth agent, which injects the client credentials: the host never holds them. */
async function exchangeCode(code: string): Promise<Exchanged | { error: string }> {
  const res = await undiciFetch(`${SLACK_API}oauth.v2.access`, {
    method: 'POST',
    dispatcher: new ProxyAgent(await agentProxyUrl(OAUTH_AGENT)),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, redirect_uri: redirectUri() }).toString(),
    redirect: 'manual',
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || body.ok !== true) {
    return { error: typeof body?.error === 'string' ? body.error : `HTTP ${res.status}` };
  }
  const user = (body.authed_user ?? {}) as Record<string, unknown>;
  const team = (body.team ?? {}) as Record<string, unknown>;
  if (typeof user.access_token !== 'string' || typeof user.id !== 'string' || typeof team.id !== 'string') {
    return { error: 'no user token in the answer' };
  }
  return {
    teamId: team.id,
    userId: user.id,
    token: user.access_token,
    scopes: typeof user.scope === 'string' ? user.scope.split(',') : [],
    rotating: user.expires_in !== undefined || typeof user.refresh_token === 'string',
  };
}

/** Best effort: a token the host will not keep should not stay valid at Slack either. */
async function revokeToken(token: string): Promise<void> {
  const res = await undiciFetch(`${SLACK_API}auth.revoke`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    redirect: 'manual',
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
  await res.arrayBuffer();
}

const realDeps = {
  exchange: exchangeCode,
  revoke: revokeToken,
  store: putReservedToken,
  apiFor: slackReplyApiFor,
  copyAt: waitForCopy,
  held: secretsHeldBy,
};
let deps = realDeps;

export function _setSlackSendDepsForTest(fakes: Partial<typeof deps> | null): void {
  deps = fakes ? { ...deps, ...fakes } : realDeps;
}

const redirectUri = () => `https://${appHost()}${CALLBACK_PATH}`;

interface PendingConnect extends Sender {
  deviceId: string;
  userId: string;
  expiresAt: number;
}

/** By hash, in memory: a host restart expires them, as it does pairing codes. */
const connects = new Map<string, PendingConnect>();
/**
 * The page each finished sign-in showed, by state, while its claim lives. A browser that loads the redirect again, as
 * Chrome does when it comes back to the tab after opening the app, gets the same page and claim, not a spent state.
 */
const shownPages = new Map<string, { code: string; page: ConnectPage; expiresAt: number }>();

export const NOT_AVAILABLE = 'Replying from the app is not available for this account.';

/** A Slack sign-in link for this device's own person; the device names no one. */
export async function startConnect(device: MobileDevice): Promise<{ url: string } | null> {
  const sender = configured() ? await senderOf(device.user_id) : null;
  if (!sender || !hasSendApp(sender.teamId) || !personAgent(sender)) return null;
  const now = Date.now();
  for (const [key, entry] of connects) if (entry.deviceId === device.id || entry.expiresAt < now) connects.delete(key);
  const state = randomBytes(32).toString('base64url');
  connects.set(sha256(state), {
    ...sender,
    deviceId: device.id,
    userId: device.user_id,
    expiresAt: now + CONNECT_TTL_MS,
  });
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.search = new URLSearchParams({
    client_id: clientId(),
    user_scope: USER_SCOPES.join(','),
    redirect_uri: redirectUri(),
    state,
    team: sender.teamId,
  }).toString();
  return { url: url.toString() };
}

export interface ConnectPage {
  status: number;
  heading: string;
  note: string;
  /** Opens the app with a one-time claim that only the device that started this can redeem. */
  claimLink?: string;
}

const refused = (status: number, note: string): ConnectPage => ({ status, heading: 'Slack was not connected', note });

/**
 * Slack's redirect after sign-in. The state is spent before anything awaits. The token is kept only when Slack says it
 * belongs to the same person, in the same workspace, that the device is paired as.
 */
export async function finishConnect(query: URLSearchParams): Promise<ConnectPage> {
  const stateKey = sha256(query.get('state') ?? '');
  const now = Date.now();
  for (const [key, shown] of shownPages) if (shown.expiresAt < now) shownPages.delete(key);
  const shown = shownPages.get(stateKey);
  if (shown && shown.code === sha256(query.get('code') ?? '')) return shown.page;
  const pending = connects.get(stateKey);
  connects.delete(stateKey);
  if (!pending || Date.now() > pending.expiresAt) {
    return refused(410, 'This sign-in has expired. Tap Connect Slack in the app to start again.');
  }
  const code = query.get('code');
  if (!code) return refused(200, 'Slack sign-in was cancelled. Nothing was connected.');

  let exchanged: Awaited<ReturnType<typeof exchangeCode>>;
  try {
    exchanged = await deps.exchange(code);
    // eslint-disable-next-line no-catch-all/no-catch-all -- any failure leaves nothing stored, and the page says so
  } catch (err) {
    log.warn('Mobile: Slack code exchange failed', { deviceId: pending.deviceId, err });
    return refused(503, 'Slack could not be reached. Nothing was connected. Try again from the app.');
  }
  if ('error' in exchanged) {
    log.warn('Mobile: Slack refused the code exchange', { deviceId: pending.deviceId, error: exchanged.error });
    return refused(503, `Slack refused the sign-in (${exchanged.error}). Nothing was connected.`);
  }
  const why =
    exchanged.teamId !== pending.teamId || exchanged.userId !== pending.slackUserId
      ? 'That Slack account is not the one this phone is paired as.'
      : !exchanged.scopes.includes(CHAT_SCOPE)
        ? 'Slack did not grant permission to post.'
        : exchanged.rotating
          ? 'The Slack app hands out expiring tokens, which this host does not renew.'
          : null;
  const agent = personAgent(pending);
  if (why || !agent) {
    log.warn('Mobile: Slack sign-in not kept', { deviceId: pending.deviceId, why });
    await deps.revoke(exchanged.token).catch((err: unknown) => log.warn('Mobile: Slack token revoke failed', { err }));
    return refused(409, `${why ?? NOT_AVAILABLE} Nothing was connected.`);
  }
  const { deviceId, userId } = pending;
  // A token granted chat:write alone is kept for words; its own scopes refuse a file when one is sent.
  const stored: ClaimReady = deps.store(agent, tokenInjection(agent), exchanged.token).then(
    () => {
      log.info('Mobile: Slack connected for sending', {
        deviceId,
        agent,
        files: exchanged.scopes.includes(FILE_SCOPE),
      });
      void noticeConnected(userId).catch(() =>
        log.warn('Mobile: Slack connect notice could not be sent', { deviceId }),
      );
      return null;
    },
    (err: unknown) => {
      log.error('Mobile: Slack token could not be stored', { deviceId, agent, err });
      return err instanceof ReservedTokenMayBeLive
        ? 'Slack signed you in and the token may be stored, but the host could not confirm that only you hold it, so this phone was not set up to send. Connect Slack again.'
        : 'The host could not finish setting up sending. Try again in a few minutes.';
    },
  );
  const { claim, expiresAt } = issueClaim(deviceId, stored);
  const page = {
    status: 200,
    heading: 'Slack signed you in',
    note: 'Tap Open Anderton to finish.',
    claimLink: `anderton://slack-connected?claim=${claim}&host=${appHost()}`,
  };
  shownPages.set(stateKey, { code: sha256(code), page, expiresAt });
  return page;
}

async function noticeConnected(userId: string): Promise<void> {
  const dm = await ensureUserDm(userId);
  if (!dm) throw new Error('no DM');
  await deliverText(
    dmRoute(dm),
    "📱 A phone connected Slack to the Anderton app, so replies sent from it post as you. If that wasn't you, tell any agent to revoke the device.",
  );
}

interface SlackThread {
  sender: Sender;
  channel: string;
  threadTs: string;
  /** The thread as the archive keys it. */
  threadId: string;
  groups: string[];
}

/** A Slack thread, in the person's own workspace, served by an agent they can call. */
async function slackThread(thread: ThreadToRead, pairedId: string): Promise<SlackThread | null> {
  const sender = await senderOf(pairedId);
  if (!sender || !thread.threadId || !thread.platformId.startsWith('slack:')) return null;
  const bots = getKnownSlackBots();
  const groups = [
    ...new Set(
      thread.agents
        .filter(({ channelType }) => bots.get(channelType)?.teamId === sender.teamId)
        .map(({ agentGroupId }) => agentGroupId),
    ),
  ];
  if (groups.length === 0) return null;
  const channel = extractSlackChannelId(thread.platformId);
  const [platform, threadChannel, threadTs] = thread.threadId.split(':');
  if (platform !== 'slack' || threadChannel !== channel || !SLACK_TS_RE.test(threadTs ?? '')) return null;
  return { sender, channel, threadTs, threadId: thread.threadId, groups };
}

interface Poster {
  agent: string;
  unlock: ReplyTarget['unlock'];
  /** Its token may hold `files:write`: a group's was seen to, and a connected one's is learned on the send itself. */
  files: boolean;
}

/** Chosen by whether the person's workspace has a send app, never by who they are. */
async function posterFor({ sender, groups }: SlackThread, fresh: boolean): Promise<Poster | null> {
  if (hasSendApp(sender.teamId)) {
    const agent = configured() ? personAgent(sender) : null;
    return agent ? { agent, unlock: 'connect', files: true } : null;
  }
  for (const group of groups) {
    const scopes = await provenFor(group, sender, fresh);
    if (scopes) return { agent: group, unlock: 'enable', files: scopes.includes(FILE_SCOPE) };
  }
  return null;
}

/** The token's scopes once it is proven to post as this person, else null. */
type Proof = Promise<string[] | null>;

const proofs = new Map<string, { until: number; proven: Proof }>();

async function provenFor(group: string, sender: Sender, fresh: boolean): Proof {
  const key = JSON.stringify([group, sender.teamId, sender.slackUserId]);
  const now = Date.now();
  for (const [old, entry] of proofs) if (entry.until < now) proofs.delete(old);
  const cached = proofs.get(key);
  if (cached && !fresh) return cached.proven;
  const proven: Proof = postsAs(group, sender).catch((err: unknown) => {
    log.warn('Mobile: could not check a group’s Slack token', { group, err });
    if (proofs.get(key)?.proven === proven) proofs.delete(key);
    return null;
  });
  proofs.set(key, { until: now + SHOWN_PROOF_TTL_MS, proven });
  return proven;
}

/**
 * Through the group's own gateway identity, never its `-noslack` one. The gateway injects every held secret whose host
 * matches, so a second one that could match slack.com (a wildcard or unlisted host might) could be the token a call
 * carries instead of the declared one auth.test vouches for. Throws when the group's config or the vault cannot be read.
 */
async function postsAs(group: string, { teamId, slackUserId }: Sender): Proof {
  const agentGroup = await getAgentGroup(group);
  if (!agentGroup) return null;
  const config = readContainerConfig(agentGroup.folder);
  const declared = slackUserTokenSecrets(
    mergeWorkgroupAndGroupSecrets((await getWorkgroupAccessForGroup(group)).onecliSecrets, config.onecliSecrets),
    config.slack_user_token?.onecli_secret_names,
  );
  if (declared.length === 0) return null;
  const onSlack = (await deps.held(group)).filter(({ hostPattern }) => {
    const host = hostPattern?.trim().toLowerCase() ?? '';
    return host === '' || host.includes('*') || host === 'slack.com';
  });
  const [token] = onSlack;
  if (onSlack.length !== 1 || token.hostPattern?.trim().toLowerCase() !== 'slack.com') return null;
  if (!declared.some((name) => name === token.name || name === token.id)) return null;
  const who = await (await deps.apiFor(group)).authTest();
  return who.ok && who.userId === slackUserId && who.teamId === teamId ? (who.scopes ?? []) : null;
}

/**
 * Posts as the person, under the token the host picks from the device's own person. The words go as typed, after a
 * mention of the chosen agent's bot in this workspace, which is what wakes it. A screen deciding what to show may reuse
 * a recent proof; a send never does.
 */
export async function slackReplyTarget(
  thread: ThreadToRead,
  device: MobileDevice,
  shown = false,
  recipient: Recipient = undefined,
): Promise<ReplyTarget | null> {
  const found = await slackThread(thread, device.user_id);
  const poster = found && (await posterFor(found, !shown));
  if (!found || !poster) return null;
  const agent = thread.agents.find(({ agentGroupId }) => agentGroupId === recipient);
  const bot = agent && getKnownSlackBots().get(agent.channelType);
  const mention = bot?.teamId === found.sender.teamId ? `<@${bot.userId}> ` : null;
  const { channel, threadTs } = found;
  return {
    unlock: poster.unlock,
    files: poster.files,
    refuse: (_words, files) => {
      if (agent && !mention) return `The host does not know ${agent.name}’s bot in this workspace. Nothing was posted.`;
      if (files.length > 0 && !poster.files) return FILES_NEED_RECONNECT;
      return null;
    },
    post: async (words, files) => {
      const text = `${mention ?? ''}${words}`;
      if (files.length === 0) return posted(poster, (api) => api.postMessage(channel, text, threadTs));
      const comment = text.trim();
      let sharingFrom = new Date().toISOString();
      const outcome = await posted(poster, async (api) => {
        const shared = await api.shareFiles(channel, files, { threadTs, comment });
        if (shared.sharingFrom) sharingFrom = shared.sharingFrom;
        return shared;
      });
      if (outcome.outcome !== 'sent') return outcome;
      const since = new Date(Date.parse(sharingFrom) - COPY_CLOCK_SLACK_MS).toISOString();
      // Slack does not say a share's ts, so its copy in the archive dates it. A share with no words is never archived,
      // and the host's own time only places it in the thread. The share has posted, so a lookup that fails only goes
      // without the date.
      if (!comment) return { ...outcome, postedAt: new Date().toISOString() };
      const senderIds = thread.agents.map(({ channelType }) => `${channelType}:${found.sender.slackUserId}`);
      const postedAt = await deps
        .copyAt({ platformId: thread.platformId, threadId: found.threadId, senderIds, since }, comment)
        .catch((err: unknown) => {
          log.warn('Mobile: a shared file’s copy could not be looked up', { err });
          return null;
        });
      return postedAt ? { ...outcome, postedAt } : outcome;
    },
  };
}

/** Room for Slack's clock to run behind the host's when looking for a share's copy. */
const COPY_CLOCK_SLACK_MS = 1_000;
/** How long a copy must stay the only one that could be it, so one that lands second can still show it is not. */
const COPY_SETTLE_MS = 1_500;
const COPY_WAIT_MS = 10_000;
const COPY_LOOK_GAP_MS = 500;
let copyWaitMs = COPY_WAIT_MS;

export function _setCopyWaitForTest(ms: number | null): void {
  copyWaitMs = ms ?? COPY_WAIT_MS;
}

/** Letters and digits alone, so formatting the adapter drops or adds on the way to the archive does not count. */
const bare = (text: string) =>
  text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, '');

/**
 * When the person's copy of a share lands in the archive, waited for briefly: their one message since the share was
 * asked for that says exactly what the share's comment said, and still the only one a moment later. Null if none has
 * landed by then, or more than one could be it.
 */
async function waitForCopy(input: Parameters<typeof postsSince>[0], comment: string): Promise<string | null> {
  const until = Date.now() + copyWaitMs;
  const said = bare(comment);
  const copies = () => postsSince(input).filter(({ text }) => bare(text) === said);
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  for (;;) {
    const found = copies();
    if (found.length > 1) return null;
    if (found.length === 1) {
      await pause(Math.min(COPY_SETTLE_MS, copyWaitMs));
      const settled = copies();
      return settled.length === 1 ? settled[0].sentAt : null;
    }
    if (Date.now() >= until) return null;
    await pause(COPY_LOOK_GAP_MS);
  }
}

async function posted(
  { agent, unlock }: Poster,
  send: (api: SlackReplyApi) => Promise<SlackResult>,
): Promise<SendOutcome> {
  const result = await send(await deps.apiFor(agent));
  // The Slack adapter dates a message from its ts this way, and the archive keeps that date.
  if (result.ok)
    return {
      outcome: 'sent',
      ...(result.ts ? { postedAt: new Date(Number.parseFloat(result.ts) * 1e3).toISOString() } : {}),
    };
  if (result.error === FILES_NOT_ALLOWED) {
    return unlock === 'connect'
      ? { outcome: 'failed', error: 'Reconnect Slack to send files. Nothing was posted.', offerConnect: true }
      : { outcome: 'failed', error: FILES_NEED_RECONNECT };
  }
  if (result.local) return { outcome: 'failed', error: 'The host could not reach Slack. Nothing was posted.' };
  if (result.error === NO_ANSWER) {
    return {
      outcome: 'unknown',
      error: 'Slack did not answer, so it may have posted. Check the thread before sending again.',
    };
  }
  if (unlock === 'connect' && TOKEN_GONE.has(result.error ?? '')) {
    return {
      outcome: 'failed',
      error: 'Slack no longer accepts your connection. Connect Slack again.',
      reconnect: true,
      offerConnect: true,
    };
  }
  return { outcome: 'failed', error: `Slack refused it (${result.error}). Nothing was posted.` };
}

export function _resetSlackSendForTest(): void {
  connects.clear();
  shownPages.clear();
  proofs.clear();
  copyWaitMs = COPY_WAIT_MS;
}
