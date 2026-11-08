import { createHmac, randomBytes, timingSafeEqual } from 'crypto';

import { INSTALL_SLUG, VOICE_CALL_PUBLIC_IP, VOICE_GROUP_SIGNAL_PORT } from '../../../config.js';
import { runRuntime } from '../../../container-runtime.js';
import { log } from '../../../log.js';

const LIVEKIT_IMAGE =
  'livekit/livekit-server:v1.13.9@sha256:d0c04791bf63ca8dcea123571827d56ba9504bd57c8d5de60ee03b5408cc3154';
const CONTAINER = `nanoclaw-livekit-${INSTALL_SLUG}`;
export const VOICE_NETWORK = 'nanoclaw-voice';
/** Marks every container group calls start, so boot can remove what a previous host left running. */
export const VOICE_LABEL = `nanoclaw-voice=${INSTALL_SLUG}`;
export const LIVEKIT_INTERNAL_URL = `ws://${CONTAINER}:7880`;
const START_TIMEOUT_MS = 20_000;
const RUNTIME_TIMEOUT_MS = 30_000;
const ROOM_SERVICE_TIMEOUT_MS = 5_000;
const MAX_PARTICIPANTS = 8;

export interface RoomGrant {
  room: string;
  roomJoin?: boolean;
  roomAdmin?: boolean;
  roomCreate?: boolean;
  canPublish?: boolean;
  canSubscribe?: boolean;
  canPublishData?: boolean;
  canPublishSources?: string[];
  canUpdateOwnMetadata?: boolean;
}

export interface TokenClaims {
  iss: string;
  sub?: string;
  name?: string;
  nbf: number;
  exp: number;
  video: RoomGrant;
}

let keys: { apiKey: string; apiSecret: string } | null = null;
let starting: Promise<void> | null = null;

export const groupCallsConfigured = () => VOICE_CALL_PUBLIC_IP !== '';

const signalOrigin = () => `http://127.0.0.1:${VOICE_GROUP_SIGNAL_PORT}`;

function liveKitConfig(apiKey: string, apiSecret: string): string {
  return [
    'port: 7880',
    'rtc:',
    '  tcp_port: 7881',
    '  udp_port: 7882',
    '  use_external_ip: false',
    `  node_ip: ${VOICE_CALL_PUBLIC_IP}`,
    'room:',
    '  empty_timeout: 300',
    `  max_participants: ${MAX_PARTICIPANTS}`,
    'logging:',
    '  level: warn',
    'keys:',
    `  ${apiKey}: ${apiSecret}`,
  ].join('\n');
}

async function ensureNetwork(): Promise<void> {
  try {
    await runRuntime(['network', 'inspect', VOICE_NETWORK], RUNTIME_TIMEOUT_MS);
  } catch {
    // The interface name is fixed so a host firewall rule can drop this network's traffic to the host itself.
    await runRuntime(
      [
        'network',
        'create',
        '--driver',
        'bridge',
        '--label',
        VOICE_LABEL,
        '-o',
        'com.docker.network.bridge.name=nc-voice0',
        VOICE_NETWORK,
      ],
      RUNTIME_TIMEOUT_MS,
    );
  }
}

async function waitForSignal(): Promise<void> {
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${signalOrigin()}/`, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error('The call room server did not start.');
}

/** Starts the room server with fresh keys if it is not running. Its keys live only in this process. */
export function ensureLiveKit(): Promise<void> {
  if (!groupCallsConfigured()) return Promise.reject(new Error('Group calls are not configured on this host.'));
  if (keys && !starting) return Promise.resolve();
  starting ??= (async () => {
    await runRuntime(['rm', '-f', CONTAINER], RUNTIME_TIMEOUT_MS).catch(() => undefined);
    await ensureNetwork();
    const fresh = { apiKey: `nc${randomBytes(6).toString('hex')}`, apiSecret: randomBytes(32).toString('base64url') };
    await runRuntime(
      [
        'run',
        '-d',
        '--rm',
        '--name',
        CONTAINER,
        '--label',
        VOICE_LABEL,
        '--network',
        VOICE_NETWORK,
        '-p',
        `127.0.0.1:${VOICE_GROUP_SIGNAL_PORT}:7880`,
        '-p',
        `${VOICE_CALL_PUBLIC_IP}:7881:7881/tcp`,
        '-p',
        `${VOICE_CALL_PUBLIC_IP}:7882:7882/udp`,
        '--memory',
        '512m',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges',
        '-e',
        `LIVEKIT_CONFIG=${liveKitConfig(fresh.apiKey, fresh.apiSecret)}`,
        LIVEKIT_IMAGE,
      ],
      RUNTIME_TIMEOUT_MS,
    );
    keys = fresh;
    await waitForSignal();
    log.info('Group call room server started');
  })().finally(() => {
    starting = null;
  });
  return starting.catch((err: unknown) => {
    keys = null;
    throw err;
  });
}

export async function stopLiveKit(): Promise<void> {
  keys = null;
  await runRuntime(['rm', '-f', CONTAINER], RUNTIME_TIMEOUT_MS).catch((err: unknown) =>
    log.warn('Group call: could not stop the room server', { err }),
  );
}

/** Removes every container a previous host process started for group calls; none of them can be resumed. */
export async function removeLeftoverVoiceContainers(): Promise<void> {
  try {
    const names = (await runRuntime(['ps', '-aq', '--filter', `label=${VOICE_LABEL}`], RUNTIME_TIMEOUT_MS))
      .split('\n')
      .filter(Boolean);
    if (names.length > 0) {
      await runRuntime(['rm', '-f', ...names], RUNTIME_TIMEOUT_MS);
      log.info('Removed leftover group call containers', { count: names.length });
    }
  } catch (err) {
    log.warn('Group call: could not remove leftover containers', { err });
  }
}

function requireKeys() {
  if (!keys) throw new Error('The call room server is not running.');
  return keys;
}

const b64u = (value: string) => Buffer.from(value).toString('base64url');

export function mintToken(claims: { sub?: string; name?: string; video: RoomGrant }, ttlSeconds: number): string {
  const { apiKey, apiSecret } = requireKeys();
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: apiKey, nbf: now - 5, exp: now + ttlSeconds, ...claims }));
  const signature = createHmac('sha256', apiSecret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${signature}`;
}

export function verifyToken(token: string | null): TokenClaims & { sub: string } {
  if (!keys) throw new Error('no room server');
  const parts = (token ?? '').split('.');
  if (parts.length !== 3) throw new Error('malformed');
  const head = JSON.parse(Buffer.from(parts[0], 'base64url').toString()) as { alg?: unknown };
  if (head.alg !== 'HS256') throw new Error('algorithm');
  const expected = createHmac('sha256', keys.apiSecret).update(`${parts[0]}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new Error('signature');
  const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString()) as Partial<TokenClaims>;
  const now = Date.now() / 1000;
  if (claims.iss !== keys.apiKey) throw new Error('issuer');
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now + 5) throw new Error('not yet valid');
  if (typeof claims.sub !== 'string' || !claims.video?.room) throw new Error('no identity');
  return claims as TokenClaims & { sub: string };
}

/** A RoomService call; a 404 means the participant or room is already gone, which is what every caller wants. */
async function roomService(method: string, body: Record<string, unknown>, grant: RoomGrant): Promise<void> {
  const token = mintToken({ video: grant }, 60);
  const res = await fetch(`${signalOrigin()}/twirp/livekit.RoomService/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(ROOM_SERVICE_TIMEOUT_MS),
  });
  if (!res.ok && res.status !== 404)
    throw new Error(`${method} failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
}

export const removeParticipant = (room: string, identity: string) =>
  roomService('RemoveParticipant', { room, identity }, { room, roomAdmin: true });

/** LiveKit refuses DeleteRoom without roomCreate; roomAdmin alone answers 401. */
export const deleteRoom = (room: string) => roomService('DeleteRoom', { room }, { room, roomCreate: true });

export const liveKitSignalPort = () => VOICE_GROUP_SIGNAL_PORT;
