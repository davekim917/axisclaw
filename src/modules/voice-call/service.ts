import { randomBytes } from 'crypto';

import { neutralizeMentions } from '../../channels/neutralize-mentions.js';
import { PREVIEW_ORIGIN_SUFFIX, TIMEZONE, VOICE_CALL_AGENT_GROUPS, VOICE_CALL_CODEX_BIN } from '../../config.js';
import { deriveHumanRequest } from '../../caller-identity.js';
import { withCentralSync } from '../../db/central-lease.js';
import { readContainerConfig } from '../../container-config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { scrubSecrets } from '../../secret-scrubber.js';
import { SessionWriteRefusedError, writeSessionMessage } from '../../session-manager.js';
import { formatLocalTime } from '../../timezone.js';
import { isChannelVariant, type AgentGroup, type MessagingGroup } from '../../types.js';
import { agentGroupAccessUnderLease } from '../permissions/access.js';
import { getUser } from '../permissions/db/users.js';
import { ensureUserDm } from '../permissions/user-dm.js';
import { VoiceCallBridge, type CallPorts } from './call.js';
import { openLiveCall, readCodexLogin } from './live.js';
import { calls, type CallPageEvent, type CallRoute, type VoiceCall } from './registry.js';
import { followSessionFeed } from './session-feed.js';
import { isDiscordChannelType } from '../../discord-bot.js';
import { platformName } from './prompts.js';

export const RING_MS = 5 * 60_000;
export const MAX_CALL_MS = 60 * 60_000;
/** Once audio is up, the voice service itself ends a call whose phone has gone, so only this window needs a timer. */
export const AUDIO_CONNECT_MS = 60_000;
const MAX_LIVE_CALLS = 4;
const RECHECK_MS = 60_000;
const NOT_ALLOWED = 'Only the owner, admins and members of this agent can call it.';
const ACCESS_CHANGED = 'Your access to voice calls changed, so the call ended.';

/** The pilot's caller rule. Read the central DB, so call it under `withCentralSync`. */
export const mayCall = (userId: string, agentGroupId: string) =>
  agentGroupAccessUnderLease(userId, agentGroupId).allowed;
const stillMayCall = (call: VoiceCall) =>
  withCentralSync(() => mayCall(call.callerId, call.agentGroupId), 'voice-call caller check');

const enabledGroups = new Map<string, string | undefined>(
  VOICE_CALL_AGENT_GROUPS.split(',')
    .map((entry) => entry.split(':').map((part) => part.trim()))
    .filter(([id]) => id)
    .map(([id, voice]): [string, string | undefined] => [id, voice || undefined]),
);

export class VoiceCallRefused extends Error {}

export const voiceCallUrl = (id: string) => `https://${id}.${PREVIEW_ORIGIN_SUFFIX}`;

export const voiceFor = (agentGroupId: string) => enabledGroups.get(agentGroupId);

export function voiceCallsEnabledFor(agentGroupId: string): boolean {
  return PREVIEW_ORIGIN_SUFFIX !== '' && enabledGroups.has(agentGroupId);
}

function emit(call: VoiceCall, event: CallPageEvent): void {
  for (const listener of call.listeners) listener(event);
}

function finish(call: VoiceCall, reason: string): void {
  if (call.state === 'ended') return;
  call.state = 'ended';
  clearTimeout(call.timer);
  if (call.audioTimer) clearTimeout(call.audioTimer);
  if (call.recheckTimer) clearInterval(call.recheckTimer);
  call.bridge?.end({ dropped: false, reason });
  emit(call, { type: 'ended', text: reason });
  call.listeners.clear();
  calls.delete(call.id);
  log.info('Voice call ended', {
    callId: call.id.slice(0, 8),
    sessionId: call.sessionId,
    reason,
    requests: call.requests,
  });
}

export async function deliverText(
  route: Pick<CallRoute, 'channelType' | 'instance' | 'platformId' | 'threadId'>,
  text: string,
) {
  const adapter = getDeliveryAdapter();
  if (!adapter) throw new Error('No delivery adapter is ready.');
  await adapter.deliver(
    route.channelType,
    route.platformId,
    route.threadId,
    'chat',
    JSON.stringify({ text: scrubSecrets(text) }),
    undefined,
    route.instance,
  );
}

/** Where `deliverText` reaches a DM `ensureUserDm` resolved. */
export const dmRoute = (dm: MessagingGroup) => ({
  channelType: dm.channel_type,
  instance: dm.instance ?? dm.channel_type,
  platformId: dm.platform_id,
  threadId: null,
});

const requestIdPrefix = (call: VoiceCall) => `voice-${call.id}-`;

function injectAsCaller(call: VoiceCall, text: string, wake: boolean): { id: string; written: Promise<void> } {
  call.requests += 1;
  const id = `${requestIdPrefix(call)}${call.requests}`;
  return { id, written: writeAsCaller(call, id, text, wake) };
}

async function writeAsCaller(call: VoiceCall, id: string, text: string, wake: boolean): Promise<void> {
  try {
    await write(call, id, text, wake);
  } catch (err) {
    if (err instanceof SessionWriteRefusedError) finish(call, ACCESS_CHANGED);
    throw err;
  }
  if (!wake) return;
  try {
    const session = await getSession(call.sessionId);
    if (session) await requestWake(session, 'inbound-message');
  } catch (err) {
    log.warn('Voice call: request written but the container did not wake', { callId: call.id.slice(0, 8), err });
  }
}

function write(call: VoiceCall, id: string, text: string, wake: boolean): Promise<void> {
  return writeSessionMessage(
    call.agentGroupId,
    call.sessionId,
    {
      id,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: call.route.platformId,
      channelType: call.route.channelType,
      messagingGroupId: call.route.messagingGroupId,
      threadId: call.route.threadId,
      content: JSON.stringify({ text, sender: call.callerName, senderId: call.callerHandle }),
      trigger: wake ? 1 : 0,
    },
    {
      guard: () =>
        mayCall(call.callerId, call.agentGroupId) || { ok: false, reason: 'the caller may no longer make voice calls' },
    },
  );
}

function portsFor(call: VoiceCall): CallPorts {
  return {
    openLive: ({ offer, instructions, onEvent }) =>
      openLiveCall({
        offer,
        instructions,
        onEvent,
        login: () => readCodexLogin(VOICE_CALL_CODEX_BIN),
        voice: enabledGroups.get(call.agentGroupId),
      }),
    feed: (onEvent) =>
      followSessionFeed(
        { agentGroupId: call.agentGroupId, sessionId: call.sessionId },
        call.route,
        requestIdPrefix(call),
        onEvent,
      ),
    inject: (text, wake) => injectAsCaller(call, text, wake),
    mirror: (text) =>
      void deliverText(call.route, neutralizeMentions(text)).catch((err: unknown) =>
        log.warn('Voice call: thread post failed', { callId: call.id.slice(0, 8), err }),
      ),
    status: (text) => emit(call, { type: 'status', text }),
    caption: (role, text, done) => emit(call, { type: 'caption', role, text, done }),
    ended: (text) => finish(call, text),
  };
}

/** The name the agent goes by in this conversation, as the rest of the host shows it. */
export async function spokenName(agentGroup: AgentGroup, messagingGroupId: string): Promise<string> {
  try {
    const { resolveAssistantName } = await import('../../container-runner.js');
    return await resolveAssistantName(agentGroup, readContainerConfig(agentGroup.folder), messagingGroupId);
  } catch (err) {
    log.warn('Voice call: could not resolve the agent name', { agentGroupId: agentGroup.id, err });
    return agentGroup.name;
  }
}

/**
 * Mints a call link for the human who asked in this session and sends it to that person's DM, never into the
 * thread: the link speaks as them. The host picks the caller from the session's latest human message, so an agent
 * cannot mint a link that speaks as anyone else.
 */
export async function mintVoiceCall(input: { sessionId: string; agentGroupId: string }): Promise<{
  sentTo: string;
  expiresAt: string;
}> {
  if (!voiceCallsEnabledFor(input.agentGroupId))
    throw new VoiceCallRefused('Voice calls are not enabled for this agent.');
  const session = await getSession(input.sessionId);
  if (!session || session.agent_group_id !== input.agentGroupId || !session.messaging_group_id) {
    throw new VoiceCallRefused('Voice calls start from a conversation thread.');
  }
  const mg = await getMessagingGroup(session.messaging_group_id);
  const chat = mg?.channel_type ?? '';
  if (!mg || !(chat === 'slack' || isChannelVariant(chat, 'slack') || isDiscordChannelType(chat)))
    throw new VoiceCallRefused('Voice calls start from Slack or Discord.');
  const request = await deriveHumanRequest(session);
  if (!request) throw new VoiceCallRefused('No person has asked in this thread, so there is no one to call.');
  const callerId = request.userId;
  if (!(await withCentralSync(() => mayCall(callerId, input.agentGroupId), 'voice-call caller check'))) {
    throw new VoiceCallRefused(NOT_ALLOWED);
  }
  const caller = await getUser(callerId);
  const agentGroup = await getAgentGroup(input.agentGroupId);
  const agentName = agentGroup ? await spokenName(agentGroup, mg.id) : 'your agent';
  const instance = mg.instance ?? mg.channel_type;

  const dm = await ensureUserDm(callerId, { instance, privacySafeLogs: true });
  if (!dm) throw new VoiceCallRefused('Could not open a DM with the caller to send the call link.');

  for (const existing of calls.values()) {
    if (existing.sessionId !== session.id || existing.callerId !== callerId) continue;
    if (existing.state !== 'ringing') throw new VoiceCallRefused('A voice call from this thread is already live.');
    finish(existing, 'A newer call link replaced this one.');
  }
  if ([...calls.values()].filter((c) => c.state !== 'ringing').length >= MAX_LIVE_CALLS) {
    throw new VoiceCallRefused('Too many voice calls are live on this host right now.');
  }

  const id = randomBytes(16).toString('hex');
  const call: VoiceCall = {
    id,
    sessionId: session.id,
    agentGroupId: input.agentGroupId,
    agentName,
    callerId,
    callerName: caller?.display_name || 'the caller',
    callerHandle: callerId.slice(callerId.indexOf(':') + 1),
    route: { ...request.route, instance, messagingGroupId: mg.id },
    state: 'ringing',
    token: null,
    expiresAt: Date.now() + RING_MS,
    timer: setTimeout(() => finish(call, 'This call link expired.'), RING_MS),
    audioTimer: null,
    recheckTimer: null,
    bridge: null,
    listeners: new Set(),
    requests: 0,
  };
  call.timer.unref();
  calls.set(id, call);

  try {
    await deliverText(
      dmRoute(dm),
      `📞 Tap to call ${call.agentName}: ${voiceCallUrl(id)}\nIt works once and expires at ${formatLocalTime(new Date(call.expiresAt).toISOString(), TIMEZONE)}. Anyone with this link can speak as you, so don't forward it.`,
    );
  } catch (err) {
    finish(call, 'The call link could not be sent.');
    throw new VoiceCallRefused(`Could not send the call link: ${err instanceof Error ? err.message : String(err)}`);
  }
  log.info('Voice call link sent', { callId: id.slice(0, 8), sessionId: session.id, agentGroupId: input.agentGroupId });
  return { sentTo: call.callerName, expiresAt: new Date(call.expiresAt).toISOString() };
}

export async function answerVoiceCall(call: VoiceCall, offer: string): Promise<{ answer: string; token: string }> {
  if (call.state !== 'ringing') throw new VoiceCallRefused('This call link has already been used.');
  if ([...calls.values()].filter((c) => c.state === 'connecting' || c.state === 'live').length >= MAX_LIVE_CALLS) {
    throw new VoiceCallRefused('Too many voice calls are live on this host right now. Try again in a few minutes.');
  }
  call.state = 'connecting';
  call.token = randomBytes(16).toString('hex');
  clearTimeout(call.timer);
  call.expiresAt = Date.now() + MAX_CALL_MS;
  call.timer = setTimeout(
    () => call.bridge?.end({ dropped: false, reason: 'The call reached its one-hour limit.' }),
    MAX_CALL_MS,
  );
  call.timer.unref();
  const bridge = new VoiceCallBridge(
    { agentName: call.agentName, callerName: call.callerName, platform: platformName(call.route.channelType) },
    portsFor(call),
  );
  call.bridge = bridge;
  try {
    if (!(await stillMayCall(call))) throw new VoiceCallRefused(NOT_ALLOWED);
    const answer = await bridge.start(offer);
    if (call.state === 'connecting') call.state = 'live';
    call.audioTimer = setTimeout(() => hangUpVoiceCall(call, true), AUDIO_CONNECT_MS);
    call.audioTimer.unref();
    call.recheckTimer = setInterval(() => {
      stillMayCall(call).then(
        (allowed) => allowed || finish(call, ACCESS_CHANGED),
        (err: unknown) => {
          log.warn('Voice call: caller check failed', { callId: call.id.slice(0, 8), err });
          finish(call, 'The call ended because your access could not be checked.');
        },
      );
    }, RECHECK_MS);
    call.recheckTimer.unref();
    const session = await getSession(call.sessionId);
    if (session) void requestWake(session, 'inbound-message').catch(() => undefined);
    return { answer, token: call.token };
  } catch (err) {
    finish(call, 'The call could not start.');
    throw err;
  }
}

export function connectVoiceAudio(call: VoiceCall): void {
  if (call.audioTimer) clearTimeout(call.audioTimer);
  call.audioTimer = null;
  log.info('Voice call audio connected', { callId: call.id.slice(0, 8) });
  call.bridge?.audioConnected();
}

const AUDIO_NUMBERS = ['inBytes', 'inPackets', 'inLost', 'inEnergy', 'outBytes', 'outPackets', 'rttMs'] as const;
const AUDIO_WORDS = {
  path: ['host', 'srflx', 'prflx', 'relay'],
  protocol: ['udp', 'tcp'],
  playback: ['none', 'playing', 'blocked'],
} as const;

/** The page's WebRTC numbers at hang-up, kept only where they are what they claim to be. */
export function logAudioReport(call: VoiceCall, raw: unknown): void {
  if (!raw || typeof raw !== 'object') return;
  const given = raw as Record<string, unknown>;
  const report: Record<string, number | string | boolean> = {};
  for (const key of AUDIO_NUMBERS) {
    const value = given[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0)
      report[key] = Math.round(value * 1000) / 1000;
  }
  for (const [key, allowed] of Object.entries(AUDIO_WORDS)) {
    const value = given[key];
    if (typeof value === 'string' && (allowed as readonly string[]).includes(value)) report[key] = value;
  }
  if (typeof given.outPaused === 'boolean') report.outPaused = given.outPaused;
  if (Object.keys(report).length > 0) log.info('Voice call audio report', { callId: call.id.slice(0, 8), ...report });
}

export function hangUpVoiceCall(call: VoiceCall, dropped: boolean): void {
  if (call.bridge) call.bridge.end({ dropped, reason: dropped ? 'The call dropped.' : 'Call ended.' });
  else finish(call, 'Call ended.');
}

export function _resetVoiceCallsForTest(): void {
  for (const call of calls.values()) {
    clearTimeout(call.timer);
    if (call.audioTimer) clearTimeout(call.audioTimer);
    if (call.recheckTimer) clearInterval(call.recheckTimer);
  }
  calls.clear();
}
