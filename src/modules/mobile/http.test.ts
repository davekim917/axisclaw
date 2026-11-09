import { createHash } from 'crypto';
import fs from 'fs';
import http from 'http';
import net, { type AddressInfo } from 'net';
import os from 'os';
import path from 'path';
import vm from 'vm';

import Database from 'better-sqlite3';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  process.env.PREVIEW_ORIGIN_SUFFIX = 'calls.example';
  process.env.VOICE_CALL_PUBLIC_IP = '203.0.113.7';
  process.env.VOICE_CALL_AGENT_GROUPS = 'ag-voice,ag-sibling';
  return {
    // `resolveSession` provisions a session on disk, so a new thread must not reach the checkout's own data dir.
    // The archive path is read once, at import, so this first value is the archive's directory for the whole file.
    dataDir: { path: uniqueTmpRoot('mobile-http-archive') },
    /** Where each agent group's `container.json` is read from. */
    groupsDir: uniqueTmpRoot('mobile-http-groups'),
    walks: 0,
    statements: 0,
    walkTerminated: 0,
    walkInstead: null as ((worker: import('node:events').EventEmitter) => void) | null,
    hiddenChannels: new Set<string>(),
    /** Raw Discord thread ids that are private; every other thread reads as public. */
    privateThreads: new Set<string>(),
    /** Bots that cannot read any thread at all: Discord answers them 404. */
    threadBlindBots: new Set<string>(),
    /** `<raw thread id> <user id>` for a person who is not in that private thread. */
    outOfThread: new Set<string>(),
    /** People whose membership check in a thread fails outright, as a 500 would. */
    memberCheckFails: new Set<string>(),
    /** Bots whose every check in a thread fails outright. */
    threadCheckFailsOn: new Set<string>(),
    kindReads: [] as string[],
    threadChecks: [] as Array<{ threadId: string; channelType: string; userIds: string[]; reads: unknown }>,
    /** The tenant of every scope each walk was given. */
    walkedTenants: [] as string[],
    platformPosts: [] as Array<{ platformId: string; text: string; title?: string }>,
    postFails: false,
    threadFails: false,
    noThreadsOn: new Set<string>(),
    sessionFails: false,
    posts: [] as Array<{ platformId: string; threadId: string | null; text: string }>,
    dmsOpened: [] as string[],
    visible: new Set<string>(),
    seeFails: false,
    seeGate: null as (() => Promise<void> | undefined) | null,
    onTitleRead: null as (() => void) | null,
    seeCalls: 0,
    latestHuman: null as string | null,
    chats: new Map<string, Array<{ kind: string; content: string }>>(),
    deliverFails: null as string | null,
    titleReads: 0,
    checkBatches: new Set<unknown>(),
    failingBots: new Set<string>(),
    callsConfigured: true,
    roomPeople: [] as string[],
    spokenNames: new Map<string, string>(),
    discordBots: new Map<string, { userId: string; username: string; avatarUrl?: string }>(),
    /** Visibility checks run the real whoCanSee, with a bot token for every bot, against whatever `fetch` is stubbed to. */
    realChecks: false,
    /** Every OneCLI control call the code under test made itself, past the faked reads; none leaves the test. */
    onecliCalls: [] as string[],
  };
});

// OneCLI's control API is reached only by `curl` (`src/onecli-secrets.ts`, `src/onecli-secret-writer.ts`). Here it
// never runs: each call is recorded, and fails as an unreachable gateway would.
vi.mock('child_process', async (orig) => {
  const actual = await orig<typeof import('child_process')>();
  const execFile = (
    file: string,
    args: string[],
    options: unknown,
    done: (error: Error | null, out: string) => void,
  ) => {
    if (file !== 'curl') return (actual.execFile as (...a: unknown[]) => unknown)(file, args, options, done);
    H.onecliCalls.push(args.find((arg) => arg.startsWith('http')) ?? 'a request on stdin');
    setImmediate(() => done(Object.assign(new Error('curl was not run'), { code: 7 }), ''));
    return { stdin: { on: () => undefined, end: () => undefined } };
  };
  return { ...actual, execFile };
});

// A complete stub: the real logger installs process-wide exit handlers, and every line must be inspectable here.
vi.mock('../../log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  get DATA_DIR() {
    return H.dataDir.path;
  },
  get GROUPS_DIR() {
    return H.groupsDir;
  },
}));
vi.mock('../../channels/channel-registry.js', async (orig) => {
  const registry = await orig<typeof import('../../channels/channel-registry.js')>();
  const { fallbackChannelDefaults } = registry;
  return {
    ...registry,
    getChannelDefaults: () => fallbackChannelDefaults(true),
    getChannelAdapter: (channelType: string) =>
      H.noThreadsOn.has(channelType)
        ? { supportsThreads: true }
        : {
            supportsThreads: true,
            postParent: async (platformId: string, text: string) => {
              if (H.postFails) throw new Error('the platform refused');
              H.platformPosts.push({ platformId, text });
              return { messageId: `${1700000000 + H.platformPosts.length}.000100` };
            },
            createThread: async (platformId: string, parentId: string, title: string, firstMessage: string) => {
              if (H.threadFails) throw new Error('the platform refused');
              H.platformPosts.push({ platformId, text: firstMessage, title });
              return { threadId: parentId, messageId: `${parentId}-first` };
            },
          },
  };
});
vi.mock('../../channels/discord.js', async (orig) => ({
  ...(await orig<typeof import('../../channels/discord.js')>()),
  getKnownDiscordBots: () => H.discordBots,
}));
vi.mock('../../cli/dispatch.js', async (orig) => ({
  ...(await orig<typeof import('../../cli/dispatch.js')>()),
  dispatch: vi.fn(),
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
// The real walk and the real partition sync on the real archive file, on this thread: a thread of its own would add a
// TypeScript boot to every search. Every statement the walk runs on the archive is counted.
vi.mock('../../host-worker.js', async (orig) => {
  const { EventEmitter } = await import('node:events');
  const { default: Database } = await import('better-sqlite3');
  const { walkArchiveText } = await import('./text-walk.js');
  const { runArchiveSearchMigration } = await import('../../archive-search-index.js');
  const counted = <T>(run: () => T): T => {
    const prepare = Database.prototype.prepare;
    Database.prototype.prepare = function (this: InstanceType<typeof Database>, sql: string) {
      const statement = prepare.call(this, sql);
      for (const method of ['all', 'get', 'iterate', 'run'] as const) {
        const call = (statement[method] as (...args: unknown[]) => unknown).bind(statement);
        Object.assign(statement, {
          [method]: (...args: unknown[]) => {
            H.statements += 1;
            return call(...args);
          },
        });
      }
      return statement;
    } as typeof prepare;
    try {
      return run();
    } finally {
      Database.prototype.prepare = prepare;
    }
  };
  return {
    ...(await orig<typeof import('../../host-worker.js')>()),
    startHostWorker: (entry: string, _url: string, options: { workerData: Record<string, unknown> }) => {
      const worker = Object.assign(new EventEmitter(), {
        unref: () => undefined,
        terminate: async () => {
          H.walkTerminated += 1;
          worker.emit('exit', 1);
          return 1;
        },
      });
      if (entry.includes('archive-search-sync')) {
        setImmediate(() => {
          worker.emit(
            'message',
            runArchiveSearchMigration(options.workerData as unknown as Parameters<typeof runArchiveSearchMigration>[0]),
          );
          worker.emit('exit', 0);
        });
        return worker;
      }
      H.walks += 1;
      setImmediate(() => {
        if (H.walkInstead) return H.walkInstead(worker);
        const request = options.workerData as unknown as Parameters<typeof walkArchiveText>[0];
        H.walkedTenants.push(...request.scopes.map((scope) => scope.tenantKey));
        const complete = counted(() => walkArchiveText(request, (found) => worker.emit('message', { found })));
        worker.emit('message', { finished: true, complete });
        worker.emit('exit', 0);
      });
      return worker;
    },
  };
});
vi.mock('../../env.js', async (orig) => {
  const real = await orig<typeof import('../../env.js')>();
  return {
    ...real,
    readEnvFile: (keys: string[]) => ({
      ...real.readEnvFile(keys),
      ...(H.realChecks
        ? Object.fromEntries(keys.filter((key) => key.includes('BOT_TOKEN')).map((key) => [key, 'bot']))
        : {}),
    }),
  };
});
vi.mock('../voice-call/group/place.js', async (orig) => {
  const real = await orig<typeof import('../voice-call/group/place.js')>();
  return {
    ...real,
    whoCanSee: async (
      place: { channelId: string; threadId?: string | null },
      channelType: string,
      userIds: string[],
      reads?: unknown,
    ) => {
      if (H.realChecks)
        return real.whoCanSee(
          place as Parameters<typeof real.whoCanSee>[0],
          channelType,
          userIds,
          reads as Parameters<typeof real.whoCanSee>[3],
        );
      H.seeCalls += 1;
      H.checkBatches.add(reads);
      await H.seeGate?.();
      if (H.seeFails || H.failingBots.has(channelType)) throw new Error('platform unreachable');
      if (place.threadId) H.threadChecks.push({ threadId: place.threadId, channelType, userIds: [...userIds], reads });
      if (place.threadId && (H.threadCheckFailsOn.has(channelType) || userIds.some((id) => H.memberCheckFails.has(id))))
        throw new Error('Discord channels check failed: 500');
      if (place.threadId && H.threadBlindBots.has(channelType)) return new Set();
      if (H.hiddenChannels.has(place.channelId) || H.hiddenChannels.has(place.threadId ?? '')) return new Set();
      return new Set(
        userIds
          .filter((id) => H.visible.has(id) && !H.outOfThread.has(`${place.threadId} ${id}`))
          .map((id) => id.slice(id.indexOf(':') + 1)),
      );
    },
    discordThreadKind: async (threadId: string, channelType: string) => {
      H.kindReads.push(threadId);
      if (H.failingBots.has(channelType)) throw new Error('platform unreachable');
      if (H.threadBlindBots.has(channelType)) return null;
      return H.privateThreads.has(threadId) ? 'private' : 'public';
    },
  };
});
vi.mock('../voice-call/group/livekit.js', () => ({
  groupCallsConfigured: () => H.callsConfigured,
  ensureLiveKit: async () => undefined,
  stopLiveKit: async () => undefined,
  removeLeftoverVoiceContainers: async () => undefined,
  mintToken: (claims: { sub?: string }) => `token-for-${claims.sub}`,
  verifyToken: () => null,
  removeParticipant: async () => undefined,
  deleteRoom: async () => undefined,
  liveKitSignalPort: () => 7880,
  LIVEKIT_INTERNAL_URL: 'ws://room:7880',
}));
vi.mock('../voice-call/group/bridge-container.js', () => ({
  BridgeBrowser: {
    start: async () => ({
      join: async () => true,
      collect: async () => ({ frames: [], pieces: [], slots: {}, live: 'connecting', people: H.roomPeople }),
      liveOffer: () => new Promise(() => undefined),
      stop: async () => undefined,
    }),
  },
}));
vi.mock('../voice-call/service.js', async (orig) => ({
  ...(await orig<typeof import('../voice-call/service.js')>()),
  spokenName: async (group: { id: string; name: string }) => H.spokenNames.get(group.id) ?? group.name,
  deliverText: async (route: { platformId: string; threadId: string | null }, text: string) => {
    if (H.deliverFails) throw new Error(`${H.deliverFails} while sending: ${text}`);
    H.posts.push({ platformId: route.platformId, threadId: route.threadId, text });
  },
}));
vi.mock('../permissions/user-dm.js', () => ({
  ensureUserDm: async (userId: string) => {
    H.dmsOpened.push(userId);
    return { channel_type: 'slack', platform_id: `dm:${userId}`, instance: 'slack' };
  },
}));
vi.mock('../../caller-identity.js', () => ({
  deriveHumanRequest: async () =>
    H.latestHuman && {
      userId: H.latestHuman,
      route: { channelType: 'slack', platformId: 'slack:C0TEST', threadId: 'slack:C0TEST:1.2' },
    },
}));
vi.mock('../../session-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../session-manager.js')>()),
  resolveSession: async (...args: Parameters<typeof import('../../session-manager.js').resolveSession>) => {
    if (H.sessionFails) throw new Error('disk full');
    return (await orig<typeof import('../../session-manager.js')>()).resolveSession(...args);
  },
  withExistingMailboxSession: async (
    _group: string,
    sessionId: string,
    action: (mailbox: { getEarliestInboundChats: () => unknown }) => unknown,
  ) =>
    action({
      getEarliestInboundChats: () => {
        H.titleReads += 1;
        H.onTitleRead?.();
        return H.chats.get(sessionId) ?? [];
      },
    }),
  writeSessionMessage: vi.fn(async () => undefined),
}));

const { createAgentGroup, createMessagingGroup, getDb, initMigratedTestDb } = await import('../../db/index.js');
const { createSession } = await import('../../db/sessions.js');
const { deleteAgentGroup } = await import('../../db/agent-groups.js');
const { insertAutoThreadTitle, recordThreadPinned, recordThreadRename, storeThreadPlatformName } =
  await import('../../db/thread-titles.js');
const { dispatch } = await import('../../cli/dispatch.js');
const { requestWake } = await import('../../request-wake.js');
const { writeSessionMessage } = await import('../../session-manager.js');
const { registerSlackBot, unregisterSlackBot } = await import('../../channels/slack-mentions.js');
const { addMember } = await import('../permissions/db/agent-group-members.js');
const { upsertUserDm } = await import('../permissions/db/user-dms.js');
const { initSessionFolder } = await import('../../session-manager.js');
const { setTaskThreadAnchor } = await import('../../db/task-thread-anchors.js');
const { findSessionForAgent } = await import('../../db/sessions.js');
const { resolveInboundDbPath } = await import('../mailbox/host-inbound.js');
const { grantRole } = await import('../permissions/db/user-roles.js');
const { createUser } = await import('../permissions/db/users.js');
const { getHostShutdownCallbacks } = await import('../../host-lifecycle.js');
const { log } = await import('../../log.js');
const { __resetArchiveConnectionForTest, archiveMessage, ensureArchiveSchema, recentThreadMessages } =
  await import('../../message-archive.js');
const { buildThreadContextBlock } = await import('../../thread-context.js');
const { claimLink, groupCallLive, groupCallPeople, linkFor } = await import('../voice-call/group/service.js');
const { handleMobileRequest } = await import('./http.js');
const { startChannelVisibilityRefresh } = await import('./threads.js');
const { archiveTenancyOf } = await import('../../archive-tenancy.js');
const { pairFromThread } = await import('./pairing.js');
const { _resetSlackSendForTest, _setCopyWaitForTest, _setSlackSendDepsForTest } = await import('./slack-send.js');
const { _resetReplyForTest, _setClaimWaitForTest } = await import('./reply.js');
const { _resetDiscordSendForTest, _setDiscordSendDepsForTest } = await import('./discord-send.js');
const { _resetRelayPostsForTest, isRelayCopy } = await import('../../discord-relay-posts.js');
const { grantSecret } = await import('../secret-intake/service.js');
const { reservedOwner } = await import('../../reserved-secrets.js');
const { ReservedTokenMayBeLive } = await import('../../reserved-token-store.js');
const { _resetUploadsForTest, _setUploadBaseForTest } = await import('./uploads.js');
const { FILES_NOT_ALLOWED } = await import('../../slack-user-api.js');

const NOW = '2026-10-31T12:00:00.000Z';
const DAY_MS = 24 * 60 * 60_000;
const CHANNEL = 'mg-general';
const PICTURE = 'https://avatars.example/juniper-192.png';
const ARCHIVE_DIR = H.dataDir.path;

let server: http.Server;
let port: number;
let person: string;
let people = 0;
let sessions = 0;
let messages = 0;

function send(
  method: string,
  path: string,
  { key, body, headers }: { key?: string; body?: string | Buffer; headers?: http.OutgoingHttpHeaders } = {},
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        method,
        path,
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...headers },
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => (text += chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

const parsed = <T = Record<string, unknown>>(res: { body: string }) => JSON.parse(res.body) as T;

const UPLOADS = uniqueTmpRoot('mobile-http-uploads');
fs.mkdirSync(UPLOADS, { recursive: true });
_setUploadBaseForTest(UPLOADS);
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('a screenshot')]);
/** Every file the reply uploads hold on the host's disk. */
const uploadsOnDisk = () => fs.readdirSync(UPLOADS).flatMap((dir) => fs.readdirSync(path.join(UPLOADS, dir)));

/** One file sent ahead of the reply that names it, as the app sends it; its id. */
async function uploaded(sendKey: string, bytes = PNG, type = 'image/png', name = 'shot.png'): Promise<string> {
  const res = await send('POST', '/v1/uploads', {
    key: sendKey,
    body: bytes,
    headers: { 'content-type': type, 'x-file-name': encodeURIComponent(name) },
  });
  expect(res.status).toBe(200);
  return parsed<{ uploadId: string }>(res).uploadId;
}
const nameOf = (userId: string) => `Person ${userId.slice('slack:U'.length)}`;

async function newPerson(options: { member?: boolean; visible?: boolean } = {}): Promise<string> {
  const id = `slack:U${(people += 1)}`;
  await createUser({ id, kind: 'slack', display_name: nameOf(id), created_at: NOW });
  if (options.member !== false)
    await addMember({ user_id: id, agent_group_id: 'ag-voice', added_by: null, added_at: NOW });
  if (options.visible !== false) H.visible.add(id);
  return id;
}

async function newSession(
  overrides: Partial<{
    agent_group_id: string;
    messaging_group_id: string | null;
    thread_id: string | null;
    status: 'active' | 'closed';
    last_active: string;
    archived_at: string;
  }> = {},
): Promise<string> {
  const id = `sess-${(sessions += 1)}`;
  await createSession({
    id,
    agent_group_id: 'ag-voice',
    messaging_group_id: CHANNEL,
    thread_id: `slack:C0TEST:${sessions}.0`,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: new Date().toISOString(),
    created_at: NOW,
    ...overrides,
  });
  if (overrides.archived_at)
    await getDb().run('UPDATE sessions SET archived_at = ? WHERE id = ?', overrides.archived_at, id);
  await wire(
    overrides.messaging_group_id === undefined ? CHANNEL : overrides.messaging_group_id,
    overrides.agent_group_id,
  );
  return id;
}

async function wire(messagingGroupId: string | null, agentGroupId = 'ag-voice'): Promise<void> {
  if (!messagingGroupId) return;
  await getDb().run(
    'INSERT OR IGNORE INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at) VALUES (?, ?, ?, ?)',
    `mga-${messagingGroupId}-${agentGroupId}`,
    messagingGroupId,
    agentGroupId,
    NOW,
  );
}

/** Runs the real `ncl mobile pair` path as `userId`, from a session no list shows, and returns the code it DMed. */
async function codeFor(userId: string): Promise<string> {
  H.latestHuman = userId;
  await pairFromThread({ sessionId: await newSession({ messaging_group_id: null }), agentGroupId: 'ag-voice' });
  return /\/pair#(\S+)/.exec(H.posts[H.posts.length - 1].text)![1];
}

async function pairedKey(userId: string, label?: string): Promise<string> {
  const res = await send('POST', '/v1/pair', { body: JSON.stringify({ code: await codeFor(userId), label }) });
  return parsed<{ key: string }>(res).key;
}

interface ThreadRow {
  threadKey: string;
  workgroupId: string;
  platform: string;
  channelKey: string;
  title: string;
  lastActiveAt: string;
  channelName: string | null;
  agents: Array<{ sessionId: string; agentGroupId: string; name: string; avatarUrl: string | null }>;
  dmWith?: string;
  dmCalls?: Array<{ sessionId: string; agentGroupId: string; name: string; avatarUrl: string | null }>;
  call: { sessionId: string; agentName: string; avatarUrl: string | null; people: string[] } | null;
}

interface ChannelRow {
  id: string;
  workgroupId: string;
  name: string | null;
}

async function listing(key: string, query: Record<string, string> = {}) {
  const res = await send('GET', `/v1/threads?${new URLSearchParams(query)}`, { key });
  return parsed<{
    threads: ThreadRow[];
    workgroups: Array<{ id: string; name: string }>;
    channels: ChannelRow[];
    textCutShort?: boolean;
    pending?: number;
  }>(res);
}

const listThreads = async (key: string, query?: Record<string, string>) => (await listing(key, query)).threads;

const linkIn = (url: string) => /^https:\/\/([0-9a-f]{32})\.calls\.example$/.exec(url)![1];

const sessionIds = (threads: ThreadRow[]) => threads.flatMap((t) => t.agents.map((a) => a.sessionId));

/** Archives a message in a thread of the default channel, on whatever `overrides` move it to. */
async function said(
  text: string,
  overrides: Partial<{
    agent: string;
    channelType: string;
    platformId: string;
    threadId: string | null;
    role: 'user' | 'assistant' | 'system';
    senderId: string;
    senderName: string;
    sentAt: string;
    messagingGroupId: string | null;
  }> = {},
): Promise<string> {
  const agentGroupId = overrides.agent ?? 'ag-voice';
  const id = `message-${(messages += 1)}`;
  archiveMessage(
    {
      id,
      agentGroupId,
      messagingGroupId: overrides.messagingGroupId ?? null,
      channelType: overrides.channelType ?? 'slack',
      channelName: null,
      platformId: overrides.platformId ?? 'slack:C0TEST',
      threadId: overrides.threadId === undefined ? 'slack:C0TEST:7.0' : overrides.threadId,
      role: overrides.role ?? 'user',
      senderId: overrides.senderId ?? 'slack:U0EXAMPLE',
      senderName: overrides.senderName ?? 'Ana Example',
      text,
      sentAt: overrides.sentAt ?? new Date().toISOString(),
    },
    await archiveTenancyOf(agentGroupId),
  );
  return id;
}

async function taskPosting(
  series: string,
  where: TaskChannel,
  anchor: string,
  posts: string[],
  anchoredAt = new Date().toISOString(),
): Promise<string> {
  const agent = where.agent ?? 'ag-voice';
  const sessionId = await newSession({
    agent_group_id: agent,
    messaging_group_id: null,
    thread_id: `system:tasks:${series}`,
  });
  initSessionFolder(agent, sessionId);
  await taskFire(sessionId, where, anchor, posts, anchoredAt);
  return sessionId;
}

interface TaskChannel {
  channelType: string;
  platformId: string;
  agent?: string;
}

async function taskFire(
  sessionId: string,
  where: TaskChannel,
  anchor: string,
  [first, ...rest]: string[],
  at = new Date().toISOString(),
): Promise<void> {
  const agent = where.agent ?? 'ag-voice';
  await setTaskThreadAnchor(sessionId, where.channelType, where.platformId, anchor, at);
  const post = (text: string, threadId: string | null) =>
    said(text, { ...where, agent, threadId, role: 'assistant', senderId: agent, senderName: 'assistant', sentAt: at });
  const firstId = await post(first, null);
  const inbound = new Database(resolveInboundDbPath(path.join(H.dataDir.path, 'v2-sessions', agent, sessionId)));
  inbound
    .prepare(
      `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, ?, 'delivered', ?)`,
    )
    .run(firstId, anchor, at);
  inbound.close();
  for (const text of rest) await post(text, `${where.platformId}:${anchor}`);
}

const listPlacesFor = (key: string) => send('GET', '/v1/places', { key });

const setTitle = (sessionId: string, title: string, at: string) =>
  getDb().run('UPDATE sessions SET title = ?, title_generated_at = ? WHERE id = ?', title, at, sessionId);

const setThreadTitle = (threadId: string, title: string) =>
  getDb().run(
    `INSERT INTO thread_titles (thread_id, channel_type, first_message, attempts, created_at, title)
     VALUES (?, 'discord', 'ignored', 0, ?, ?)`,
    threadId,
    NOW,
    title,
  );

async function inWorkgroup(agentGroupId: string, id: string, name: string): Promise<void> {
  await getDb().run('INSERT OR IGNORE INTO workgroups (id, display_name, created_at) VALUES (?, ?, ?)', id, name, NOW);
  await getDb().run('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?', id, agentGroupId);
}

/** Siblings: an agent group with no workgroup is its own, so without this their sessions never share a row. */
async function shareWorkgroup(): Promise<void> {
  for (const group of ['ag-voice', 'ag-sibling', 'ag-quiet']) await inWorkgroup(group, 'acme', 'Acme');
}

/** What the sweep has done by the time someone searches: their channels checked. */
async function searchable(): Promise<void> {
  await startChannelVisibilityRefresh();
}

const makeOwner = (userId = person) =>
  grantRole({ user_id: userId, role: 'owner', agent_group_id: null, granted_by: null, granted_at: NOW });

const memberOf = (agentGroupId: string, userId = person) =>
  addMember({ user_id: userId, agent_group_id: agentGroupId, added_by: null, added_at: NOW });

const channel = (id: string, platformId: string, channelType = 'slack', name: string | null = 'other') =>
  createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: platformId,
    name,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: NOW,
  });

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

function withSiblingBots(): void {
  const TEAM = 'T-MOBILE-TEST';
  const bots: Array<[string, { userId: string; username: string; teamId: string; imageUrl?: string }]> = [
    ['slack', { userId: 'U-BOT-A', username: 'a', teamId: TEAM, imageUrl: PICTURE }],
    ['slack-sibling', { userId: 'U-BOT-B', username: 'b', teamId: TEAM }],
    ['slack-foreign', { userId: 'U-BOT-C', username: 'c', teamId: 'T-OTHER-TEST' }],
  ];
  beforeEach(() => {
    for (const [channelType, identity] of bots) registerSlackBot(channelType, identity);
  });
  afterEach(() => {
    for (const [channelType, identity] of bots) unregisterSlackBot(channelType, identity);
  });
}

/** Every argument of every log call, as text. */
const loggedText = () =>
  JSON.stringify(
    (['debug', 'info', 'warn', 'error', 'fatal'] as const).flatMap((level) =>
      vi
        .mocked(log[level])
        .mock.calls.map((args) =>
          args.map((arg) => (arg && typeof arg === 'object' && 'err' in arg ? { ...arg, err: String(arg.err) } : arg)),
        ),
    ),
  );

beforeAll(async () => {
  server = http.createServer(handleMobileRequest);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(async () => {
  vi.clearAllMocks();
  H.dataDir.path = fs.mkdtempSync(path.join(os.tmpdir(), 'mobile-http-'));
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  ensureArchiveSchema();
  await initMigratedTestDb();
  await createAgentGroup({ id: 'ag-voice', name: 'Juniper', folder: 'juniper', agent_provider: null, created_at: NOW });
  await createAgentGroup({ id: 'ag-quiet', name: 'Quiet', folder: 'quiet', agent_provider: null, created_at: NOW });
  await createAgentGroup({ id: 'ag-sibling', name: 'Aster', folder: 'aster', agent_provider: null, created_at: NOW });
  await createMessagingGroup({
    id: CHANNEL,
    channel_type: 'slack',
    platform_id: 'slack:C0TEST',
    name: 'general',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: NOW,
  });
  person = await newPerson();
});

afterEach(async () => {
  vi.useRealTimers();
  for (const shutdown of getHostShutdownCallbacks()) await shutdown();
  fs.rmSync(H.dataDir.path, { recursive: true, force: true });
  __resetArchiveConnectionForTest();
  fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true });
  H.walks = 0;
  H.statements = 0;
  H.walkTerminated = 0;
  H.walkInstead = null;
  H.hiddenChannels.clear();
  H.privateThreads.clear();
  H.threadBlindBots.clear();
  H.outOfThread.clear();
  H.memberCheckFails.clear();
  H.threadCheckFailsOn.clear();
  H.walkedTenants.length = 0;
  H.kindReads.length = 0;
  H.threadChecks.length = 0;
  H.platformPosts.length = 0;
  H.postFails = false;
  H.threadFails = false;
  H.noThreadsOn.clear();
  H.sessionFails = false;
  H.posts.length = 0;
  H.dmsOpened.length = 0;
  H.visible.clear();
  H.seeFails = false;
  H.seeGate = null;
  H.onTitleRead = null;
  H.seeCalls = 0;
  H.latestHuman = null;
  H.chats.clear();
  H.deliverFails = null;
  H.titleReads = 0;
  H.checkBatches.clear();
  H.failingBots.clear();
  H.callsConfigured = true;
  H.roomPeople = [];
  H.spokenNames.clear();
  H.discordBots.clear();
  H.realChecks = false;
  vi.unstubAllGlobals();
});

describe('device keys', () => {
  it.each([
    ['GET', '/v1/threads'],
    ['DELETE', '/v1/device'],
    ['POST', '/v1/threads/sess-any/call'],
    ['POST', '/v1/threads/sess-any/dm-call'],
    ['POST', '/v1/threads'],
    ['GET', '/v1/places'],
    ['GET', '/v1/threads/AAAAAAAAAAAAAAAAAAAAAA/messages'],
    ['POST', '/v1/slack/connect'],
    ['POST', '/v1/slack/claim'],
  ])('%s %s answers 401 with no key, an unknown key, or a key in the wrong scheme', async (method, path) => {
    const key = await pairedKey(person);
    expect((await send(method, path)).status).toBe(401);
    expect((await send(method, path, { key: 'nca_notarealkey' })).status).toBe(401);
    expect((await send(method, path, { key: `${key}x` })).status).toBe(401);
    expect((await send(method, path, { headers: { authorization: `Basic ${key}` } })).status).toBe(401);
  });

  it('stops a device that was deleted on its very next request', async () => {
    const key = await pairedKey(person);
    expect((await send('GET', '/v1/threads', { key })).status).toBe(200);

    const deleted = await send('DELETE', '/v1/device', { key });

    expect([deleted.status, parsed(deleted)]).toEqual([200, { ok: true }]);
    expect((await send('GET', '/v1/threads', { key })).status).toBe(401);
    expect((await send('DELETE', '/v1/device', { key })).status).toBe(401);
  });

  it('deletes only the calling device', async () => {
    const [kept, gone] = [await pairedKey(person), await pairedKey(person)];
    await send('DELETE', '/v1/device', { key: gone });
    expect((await send('GET', '/v1/threads', { key: kept })).status).toBe(200);
  });

  it('stops a device whose user no longer exists', async () => {
    const key = await pairedKey(person);
    await getDb().run('DELETE FROM agent_group_members WHERE user_id = ?', person);
    await getDb().run('DELETE FROM users WHERE id = ?', person);
    expect((await send('GET', '/v1/threads', { key })).status).toBe(401);
  });
});

describe('pairing', () => {
  it('turns a code into a key for that person, and keeps only the hash of the key', async () => {
    const res = await send('POST', '/v1/pair', {
      body: JSON.stringify({ code: await codeFor(person), label: '  Example Phone  ' }),
    });

    expect(res.status).toBe(200);
    const body = parsed<{ key: string; deviceId: string }>(res);
    expect(body).toEqual({
      key: expect.stringMatching(/^nca_[A-Za-z0-9_-]{43}$/),
      deviceId: expect.any(String),
      userName: nameOf(person),
      platform: 'slack',
    });
    const rows = await getDb().all('SELECT * FROM mobile_devices');
    expect(rows).toEqual([
      {
        id: body.deviceId,
        user_id: person,
        key_hash: createHash('sha256').update(body.key).digest('hex'),
        label: 'Example Phone',
        created_at: expect.any(String),
        send_key_hash: null,
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain(body.key);
    expect(JSON.stringify(rows)).not.toContain(body.key.slice('nca_'.length));
  });

  it('tells the person in their DM that a phone paired, with neither the code nor the key', async () => {
    const code = await codeFor(person);
    const { key } = parsed<{ key: string }>(
      await send('POST', '/v1/pair', { body: JSON.stringify({ code, label: 'Example Phone' }) }),
    );
    const notice = H.posts[H.posts.length - 1];
    expect(notice).toMatchObject({ platformId: `dm:${person}`, threadId: null });
    expect(notice.text).toContain('Example Phone');
    expect(notice.text).toContain('revoke');
    for (const secret of [code, key]) expect(notice.text).not.toContain(secret);
  });

  it('still pairs when that notice cannot be sent', async () => {
    const code = await codeFor(person);
    H.deliverFails = 'platform down';
    expect((await send('POST', '/v1/pair', { body: JSON.stringify({ code }) })).status).toBe(200);
  });

  it('replaces control and format characters in a label, so it cannot forge a row or drive a terminal', async () => {
    await pairedKey(person, 'Phone\n\u001b[2J\u202eslack:U9');
    const row = await getDb().get<{ label: string }>('SELECT label FROM mobile_devices');
    expect(row?.label).toBe('Phone  [2J slack:U9');
  });

  it('caps a long label instead of refusing the pairing', async () => {
    await pairedKey(person, 'x'.repeat(200));
    expect(await getDb().get('SELECT label FROM mobile_devices')).toEqual({ label: 'x'.repeat(64) });
  });

  it('honours a code once', async () => {
    const body = JSON.stringify({ code: await codeFor(person) });
    expect((await send('POST', '/v1/pair', { body })).status).toBe(200);
    expect((await send('POST', '/v1/pair', { body })).status).toBe(410);
    expect(await getDb().all('SELECT id FROM mobile_devices')).toHaveLength(1);
  });

  it('refuses a code once ten minutes have passed, and accepts it just before', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const [fresh, stale] = [await codeFor(person), await codeFor(await newPerson())];
    vi.setSystemTime(Date.now() + 10 * 60_000);
    expect((await send('POST', '/v1/pair', { body: JSON.stringify({ code: fresh }) })).status).toBe(200);
    vi.setSystemTime(Date.now() + 1);
    expect((await send('POST', '/v1/pair', { body: JSON.stringify({ code: stale }) })).status).toBe(410);
  });

  it('replaces a person’s pending code with a new one, and leaves other people’s alone', async () => {
    const other = await codeFor(await newPerson());
    const old = await codeFor(person);
    const current = await codeFor(person);

    expect((await send('POST', '/v1/pair', { body: JSON.stringify({ code: old }) })).status).toBe(410);
    expect((await send('POST', '/v1/pair', { body: JSON.stringify({ code: current }) })).status).toBe(200);
    expect((await send('POST', '/v1/pair', { body: JSON.stringify({ code: other }) })).status).toBe(200);
  });

  it('answers 410 for a code it never issued', async () => {
    const res = await send('POST', '/v1/pair', { body: JSON.stringify({ code: 'never-issued' }) });
    expect(res.status).toBe(410);
    expect(parsed(res)).toEqual({ error: expect.any(String) });
  });

  it('keeps the code and the key out of every log line, on the paths that log and the ones that fail', async () => {
    const replaced = await codeFor(person);
    const code = await codeFor(person);
    await send('POST', '/v1/pair', { body: `{"code": "${code}"` });
    const { key } = parsed<{ key: string }>(await send('POST', '/v1/pair', { body: JSON.stringify({ code }) }));
    await send('POST', '/v1/pair', { body: JSON.stringify({ code: replaced }) });
    await send('GET', '/v1/threads', { key });
    await send('DELETE', '/v1/device', { key: `${key}x` });
    await newSession();
    await getDb().run('DROP TABLE thread_titles');
    await send('GET', '/v1/threads', { key });

    expect(vi.mocked(log.info).mock.calls.length).toBeGreaterThan(0);
    expect(vi.mocked(log.warn).mock.calls.length).toBeGreaterThan(0);
    for (const secret of [replaced, code, key]) expect(loggedText()).not.toContain(secret);
  });

  it('tells neither the agent nor the log what a failed send quoted, and retires that code', async () => {
    H.deliverFails = 'adapter refused';
    H.latestHuman = person;
    const session = await newSession({ messaging_group_id: null });

    const failed = pairFromThread({ sessionId: session, agentGroupId: 'ag-voice' });

    await expect(failed).rejects.toThrow(/^Could not send the pairing link\.$/);
    expect(vi.mocked(log.warn).mock.calls.length).toBeGreaterThan(0);
    expect(loggedText()).not.toContain('/pair#');
  });

  it('sends the agent nothing it could pair with, and the person a link they alone receive', async () => {
    H.latestHuman = person;
    const sent = await pairFromThread({
      sessionId: await newSession({ messaging_group_id: null }),
      agentGroupId: 'ag-voice',
    });

    expect(Object.keys(sent).sort()).toEqual(['expiresAt', 'sentTo']);
    expect(H.dmsOpened).toEqual([person]);
    expect(H.posts).toEqual([
      expect.objectContaining({
        platformId: `dm:${person}`,
        threadId: null,
        text: expect.stringMatching(/https:\/\/app\.calls\.example\/pair#[A-Za-z0-9_-]{43}\n/),
      }),
    ]);
  });

  it('pairs a Discord identity as discord', async () => {
    const id = 'discord:1234567890';
    await createUser({ id, kind: 'discord', display_name: null, created_at: NOW });
    await addMember({ user_id: id, agent_group_id: 'ag-voice', added_by: null, added_at: NOW });
    const res = await send('POST', '/v1/pair', { body: JSON.stringify({ code: await codeFor(id) }) });
    expect(parsed(res)).toMatchObject({ platform: 'discord', userName: 'Someone' });
  });
});

describe('GET /v1/threads', () => {
  it('lists a thread the person can use, in the contract’s shape', async () => {
    await inWorkgroup('ag-voice', 'acme', 'Acme');
    await setThreadTitle('slack:C0TEST:9.9', 'Why did the nightly fail?');
    const lastActive = new Date().toISOString();
    const sessionId = await newSession({ last_active: lastActive, thread_id: 'slack:C0TEST:9.9' });

    expect(await listing(await pairedKey(person))).toEqual({
      threads: [
        {
          threadKey: expect.stringMatching(/^[\w-]{22}$/),
          workgroupId: 'acme',
          workgroupName: 'Acme',
          platform: 'slack',
          channelKey: expect.stringMatching(/^[\w-]{22}$/),
          channelName: '#general',
          title: 'Why did the nightly fail?',
          lastActiveAt: lastActive,
          agents: [{ sessionId, agentGroupId: 'ag-voice', name: 'Juniper', avatarUrl: null }],
          call: null,
        },
      ],
      workgroups: [{ id: 'acme', name: 'Acme' }],
      channels: [
        { id: expect.stringMatching(/^[\w-]{22}$/), workgroupId: 'acme', platform: 'slack', name: '#general' },
      ],
    });
  });

  it('names a workgroup with no display name by its id, and a group with no workgroup by its folder', async () => {
    const key = await pairedKey(person);
    await newSession();
    expect(await listThreads(key)).toEqual([
      expect.objectContaining({ workgroupId: '_agent-group:ag-voice', workgroupName: 'juniper' }),
    ]);
  });

  it.each<[string, () => Promise<unknown>]>([
    ['a group the person fails mayCall for', () => newSession({ agent_group_id: 'ag-sibling' })],
    [
      'an agent not enabled for calls',
      async () => {
        await memberOf('ag-quiet');
        return newSession({ agent_group_id: 'ag-quiet' });
      },
    ],
    ['a closed session', () => newSession({ status: 'closed' })],
    ['an archived session', () => newSession({ archived_at: NOW })],
    ['a task thread', () => newSession({ thread_id: 'system:tasks:series-1' })],
    ['a system thread', () => newSession({ thread_id: 'system:checks' })],
    ['a session with no channel', () => newSession({ messaging_group_id: null })],
    ['a thread idle past 7 days', () => newSession({ last_active: ago(7 * DAY_MS + 60_000) })],
  ])('omits %s, beside a thread it shows', async (_name, arrange) => {
    const key = await pairedKey(person);
    await arrange();
    const shown = await newSession({ last_active: ago(7 * DAY_MS - 60_000) });
    expect(sessionIds(await listThreads(key))).toEqual([shown]);
  });

  it.each([
    ['a Slack DM recorded as nobody’s', { id: 'mg-dm', channel_type: 'slack', platform_id: 'slack:D0DM' }],
    ['a Discord DM recorded as nobody’s', { id: 'mg-ddm', channel_type: 'discord', platform_id: 'discord:@me:555' }],
    ['a platform calls do not support', { id: 'mg-tg', channel_type: 'telegram', platform_id: 'telegram:1' }],
    ['a channel on another platform', { id: 'mg-dc', channel_type: 'discord', platform_id: 'discord:1:2' }],
  ])('omits %s, without asking any platform', async (_name, mg) => {
    await createMessagingGroup({
      ...mg,
      name: 'elsewhere',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: NOW,
    });
    await newSession({ messaging_group_id: mg.id, thread_id: null });
    expect(await listThreads(await pairedKey(person))).toEqual([]);
    expect(H.seeCalls).toBe(0);
  });

  it('shows a thread only to the people whoCanSee includes', async () => {
    const outsider = await newPerson({ visible: false });
    await newSession();
    expect(await listThreads(await pairedKey(outsider))).toEqual([]);
    expect(await listThreads(await pairedKey(person))).toHaveLength(1);
  });

  it('omits the rows without failing the list when whoCanSee throws, and asks again a minute later', async () => {
    const key = await pairedKey(person);
    const id = await newSession();
    H.seeFails = true;
    const res = await send('GET', '/v1/threads', { key });
    expect([res.status, parsed(res)]).toEqual([
      200,
      { threads: [], workgroups: [{ id: '_agent-group:ag-voice', name: 'juniper' }], channels: [] },
    ]);

    H.seeFails = false;
    expect(await listThreads(key)).toEqual([]);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 61_000 });
    expect(sessionIds(await listThreads(key))).toEqual([id]);
  });

  it('finishes a scheduled refresh whose platform read never answers, so the next one still runs', async () => {
    await pairedKey(person);
    await newSession();
    H.realChecks = true;
    const reads: string[] = [];
    vi.stubGlobal('fetch', (url: string) => {
      reads.push(String(url));
      return new Promise(() => {});
    });
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    let finished = 0;
    const refresh = async (round: number) => {
      void startChannelVisibilityRefresh().then(() => (finished += 1));
      for (let turn = 0; turn < 200 && reads.length === round; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(20_000);
      for (let turn = 0; turn < 200 && finished === round; turn += 1)
        await new Promise((resolve) => setImmediate(resolve));
    };

    await refresh(0);
    vi.setSystemTime(Date.now() + 15 * 60_000);
    await refresh(1);
    expect([reads.length, finished]).toEqual([2, 2]);
  });

  it('keeps the list’s answer and the channel picker when the scheduled refresh cannot check a channel', async () => {
    const key = await pairedKey(person);
    const id = await newSession();
    const before = await listing(key);
    H.seeFails = true;

    await searchable();
    const after = await listing(key);

    expect(sessionIds(after.threads)).toEqual([id]);
    expect(after.channels).toEqual(before.channels);
    expect(after.channels).not.toEqual([]);
  });

  it('keeps a channel the refresh passed in the picker when a later refresh cannot check it, and searches nothing there', async () => {
    const key = await pairedKey(person);
    await wire(CHANNEL);
    await said('the zeppelin landed');
    vi.useFakeTimers({ toFake: ['Date'] });
    await searchable();
    const before = await listing(key);
    const walks = H.walks;
    await listing(key, { q: 'zeppelin' });
    expect(H.walks).toBe(walks + 1);

    vi.setSystemTime(Date.now() + 15 * 60_000);
    H.seeFails = true;
    await searchable();
    const after = await listing(key);
    await listing(key, { q: 'zeppelin' });

    expect(before.channels).not.toEqual([]);
    expect(after.channels).toEqual(before.channels);
    expect(H.walks).toBe(walks + 1);
  });

  const hanging = () => {
    let land = () => {};
    const hung = new Promise<void>((resolve) => (land = resolve));
    return { hung, land };
  };

  describe('when a platform check outlasts the wait', () => {
    async function discordThreads(count: number): Promise<{ key: string; ids: string[] }> {
      const id = 'discord:7654321098';
      await createUser({ id, kind: 'discord', display_name: 'Someone Else', created_at: NOW });
      await addMember({ user_id: id, agent_group_id: 'ag-voice', added_by: null, added_at: NOW });
      H.visible.add(id);
      await createMessagingGroup({
        id: 'mg-discord',
        channel_type: 'discord',
        platform_id: 'discord:111:222',
        name: 'general',
        is_group: 1,
        unknown_sender_policy: 'strict',
        created_at: NOW,
      });
      const ids: string[] = [];
      for (let i = 0; i < count; i += 1) ids.push(await discordThread(i, i));
      return { key: await pairedKey(id), ids };
    }

    const discordThread = (thread: number, minutesAgo: number) =>
      newSession({
        messaging_group_id: 'mg-discord',
        thread_id: `discord:111:222:${thread}`,
        last_active: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
      });

    it('answers after a second with the threads that passed, holding back the one still out and any not reached', async () => {
      const { key, ids } = await discordThreads(10);
      const { hung, land } = hanging();
      H.seeGate = () => (H.seeCalls === 1 ? hung : undefined);
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

      const pending = listing(key);
      while (H.seeCalls < 8) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(1_000);
      const answered = await pending;
      expect([sessionIds(answered.threads), answered.pending]).toEqual([ids.slice(1, 8), 3]);

      land();
      H.seeGate = null;
      const complete = await listing(key);
      expect([sessionIds(complete.threads), complete.pending]).toEqual([ids, undefined]);
    });

    it('reaches a thread never checked before it asks again about checks that failed', async () => {
      const { key } = await discordThreads(0);
      for (let thread = 600; thread < 640; thread += 1) await discordThread(thread, thread - 600);
      const root = await newSession({
        messaging_group_id: 'mg-discord',
        thread_id: null,
        last_active: new Date(Date.now() - 60 * 60_000).toISOString(),
      });
      H.threadCheckFailsOn.add('discord');
      vi.useFakeTimers({ toFake: ['Date'] });
      const first = await listing(key);
      expect([first.threads, first.pending]).toEqual([[], 1]);

      vi.setSystemTime(Date.now() + 61_000);
      const second = await listing(key);
      expect([sessionIds(second.threads), second.pending]).toEqual([[root], undefined]);
    });

    it('starts one check per thread however many lists ask while it is out', async () => {
      const { key } = await discordThreads(0);
      const ids = [await discordThread(400, 0), await discordThread(401, 1), await discordThread(402, 2)];
      const before = H.seeCalls;
      const { hung, land } = hanging();
      H.seeGate = () => hung;

      const lists = await Promise.all(Array.from({ length: 5 }, () => listing(key)));
      expect(lists.map((list) => [list.threads, list.pending])).toEqual(Array(5).fill([[], 3]));
      expect(H.seeCalls).toBe(before + 3);

      land();
      H.seeGate = null;
      expect(sessionIds(await listThreads(key))).toEqual(ids);
      expect(H.seeCalls).toBe(before + 3);
    });

    it('starts no new check once the budget is spent, and still lists what is already known', async () => {
      const { key, ids } = await discordThreads(10);
      expect(sessionIds(await listThreads(key))).toEqual(ids);
      const before = H.seeCalls;
      await discordThread(100, -1);
      await discordThread(101, 100);
      const { hung, land } = hanging();
      H.seeGate = () => hung;
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

      const pending = listing(key);
      while (H.seeCalls === before) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sessionIds((await pending).threads)).toEqual(ids);
      await vi.advanceTimersByTimeAsync(7_000);
      expect(H.seeCalls).toBe(before + 1);
      land();
      H.seeGate = null;
    });

    it('never waits past a second on a check still out, and asks again a minute after whoCanSee gives up on it', async () => {
      const { key, ids } = await discordThreads(10);
      expect(sessionIds(await listThreads(key))).toEqual(ids);
      const before = H.seeCalls;
      const stuck = await discordThread(300, -1);
      const givesUp = () =>
        new Promise<void>((_, reject) => setTimeout(() => reject(new Error('No answer in 20000 ms')), 20_000));
      H.seeGate = () => (H.seeCalls === before + 1 ? givesUp() : undefined);
      vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });

      const first = listing(key);
      while (H.seeCalls === before) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sessionIds((await first).threads)).toEqual(ids);

      const late = await discordThread(301, -2);
      const second = listing(key);
      while (H.seeCalls === before + 1) await new Promise((resolve) => setImmediate(resolve));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sessionIds((await second).threads)).toEqual([late, ...ids]);

      await vi.advanceTimersByTimeAsync(18_000 + 61_000);
      const third = listing(key);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sessionIds((await third).threads)).toEqual([late, stuck, ...ids]);
      expect(H.seeCalls).toBe(before + 3);
    });
  });

  describe('renewing a passed check before it runs out', () => {
    it('drops a thread within ten minutes of its last passed check once the person leaves, though the app keeps polling', async () => {
      const key = await pairedKey(person);
      await newSession();
      vi.useFakeTimers({ toFake: ['Date'] });
      const checkedAt = Date.now();
      expect(await listThreads(key)).toHaveLength(1);
      H.visible.delete(person);

      let droppedAfterMs: number | null = null;
      for (let at = 15_000; at <= 12 * 60_000 && droppedAfterMs === null; at += 15_000) {
        vi.setSystemTime(checkedAt + at);
        if ((await listThreads(key)).length === 0) droppedAfterMs = at;
      }
      expect(droppedAfterMs).not.toBeNull();
      expect(droppedAfterMs!).toBeLessThanOrEqual(10 * 60_000);
    });

    it('keeps the thread listed past the old check’s ten minutes', async () => {
      const key = await pairedKey(person);
      const id = await newSession();
      vi.useFakeTimers({ toFake: ['Date'] });
      expect(sessionIds(await listThreads(key))).toEqual([id]);
      vi.setSystemTime(Date.now() + 9 * 60_000);
      expect(sessionIds(await listThreads(key))).toEqual([id]);
      expect(H.seeCalls).toBe(2);

      vi.setSystemTime(Date.now() + 60_000 + 1);
      H.seeGate = () => new Promise<void>(() => {});
      expect(sessionIds(await listThreads(key))).toEqual([id]);
      expect(H.seeCalls).toBe(2);
    });

    it('never lets a renewal that answers late undo a denial the scheduled refresh wrote meanwhile', async () => {
      const key = await pairedKey(person);
      const id = await newSession();
      vi.useFakeTimers({ toFake: ['Date'] });
      expect(sessionIds(await listThreads(key))).toEqual([id]);
      vi.setSystemTime(Date.now() + 9 * 60_000);
      const { hung, land } = hanging();
      H.seeGate = () => (H.seeCalls === 2 ? hung : undefined);
      expect(sessionIds(await listThreads(key))).toEqual([id]);

      H.visible.delete(person);
      await searchable();
      // The held renewal read the platform before the person left.
      H.visible.add(person);
      land();
      expect(await listThreads(key)).toEqual([]);
    });

    it('lets the old answer lapse while the renewal is still out, without starting a second check', async () => {
      const key = await pairedKey(person);
      const id = await newSession();
      vi.useFakeTimers({ toFake: ['Date'] });
      expect(sessionIds(await listThreads(key))).toEqual([id]);
      vi.setSystemTime(Date.now() + 9 * 60_000);
      H.seeGate = () => new Promise<void>(() => {});
      expect(sessionIds(await listThreads(key))).toEqual([id]);

      vi.setSystemTime(Date.now() + 60_000 + 1);
      expect(await listThreads(key)).toEqual([]);
      expect(H.seeCalls).toBe(2);
    });
  });

  it('lists newest first, keeps a channel root, and asks the platform once per place per ten minutes', async () => {
    const key = await pairedKey(person);
    const older = await newSession({ last_active: new Date(Date.now() - 60_000).toISOString() });
    const root = await newSession({ thread_id: null });

    expect(sessionIds(await listThreads(key))).toEqual([root, older]);
    expect(H.seeCalls).toBe(1);
    await listThreads(key);
    expect(H.seeCalls).toBe(1);
    H.visible.delete(person);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60_000 + 1 });
    expect(await listThreads(key)).toEqual([]);
    expect(H.seeCalls).toBe(2);
  });

  it('caps at the newest 100 counted after access is checked, so unusable threads take no slots', async () => {
    const key = await pairedKey(person);
    const stamp = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    for (let i = 0; i < 30; i += 1) await newSession({ agent_group_id: 'ag-sibling', last_active: stamp(i) });
    const usable: string[] = [];
    for (let i = 0; i < 101; i += 1) usable.push(await newSession({ last_active: stamp(100 + i) }));

    expect(sessionIds(await listThreads(key))).toEqual(usable.slice(0, 100));
  });

  it('asks the platform only as far down the list as it needs', async () => {
    await createMessagingGroup({
      id: 'mg-other',
      channel_type: 'slack',
      platform_id: 'slack:C0OTHER',
      name: 'other',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: NOW,
    });
    const key = await pairedKey(person);
    const stamp = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000).toISOString();
    for (let i = 0; i < 104; i += 1) await newSession({ last_active: stamp(i) });
    for (let i = 0; i < 20; i += 1) await newSession({ messaging_group_id: 'mg-other', last_active: stamp(200 + i) });

    await listThreads(key);
    expect(H.seeCalls).toBe(1);
  });

  it('omits a thread whose agent was unwired from the channel, and will not call into it', async () => {
    const key = await pairedKey(person);
    const sessionId = await newSession();
    await getDb().run('DELETE FROM messaging_group_agents');

    expect(await listThreads(key)).toEqual([]);
    expect((await send('POST', `/v1/threads/${sessionId}/call`, { key })).status).toBe(404);
    expect(H.posts.filter((post) => post.platformId === 'slack:C0TEST')).toEqual([]);
  });

  describe('one person behind several bots', () => {
    withSiblingBots();

    it.each<[string, string, string]>([
      ['an underscore', 'discord:76543210_8', 'discord-sibling:7654321098'],
      ['a percent sign', 'discord:7654%', 'discord-sibling:7654321098'],
      ['another case', 'discord:abc123', 'discord-sibling:ABC123'],
    ])(
      'lends a Discord id with %s none of the access of an id it would match as a pattern',
      async (_name, id, other) => {
        await createUser({ id, kind: 'discord', display_name: 'Someone Else', created_at: NOW });
        await createUser({ id: other, kind: 'discord', display_name: 'A Member', created_at: NOW });
        await memberOf('ag-voice', id);
        await memberOf('ag-sibling', other);
        H.visible.add(id);
        await channel('mg-discord', 'discord:111:222', 'discord', 'general');
        await newSession({
          agent_group_id: 'ag-sibling',
          messaging_group_id: 'mg-discord',
          thread_id: 'discord:111:222:7',
        });

        expect(await listThreads(await pairedKey(id))).toEqual([]);
      },
    );

    /** Access only through `id`, a sibling of the paired identity, on a channel served by that bot. */
    async function accessOnlyAs(id: string, kind: string, channelType: string, platformId: string, threadId: string) {
      await getDb().run('DELETE FROM agent_group_members');
      await createUser({ id, kind, display_name: 'Same Person', created_at: NOW });
      await addMember({ user_id: id, agent_group_id: 'ag-voice', added_by: null, added_at: NOW });
      H.visible.add(id);
      await createMessagingGroup({
        id: `mg-${channelType}`,
        channel_type: channelType,
        platform_id: platformId,
        name: 'sibling',
        is_group: 1,
        unknown_sender_policy: 'strict',
        created_at: NOW,
      });
      return newSession({ messaging_group_id: `mg-${channelType}`, thread_id: threadId });
    }

    it('lists and calls a sibling bot’s thread in the same workspace, joining as the id that has access', async () => {
      const key = await pairedKey(person);
      const sibling = `slack-sibling:${person.slice('slack:'.length)}`;
      const sessionId = await accessOnlyAs(sibling, 'slack', 'slack-sibling', 'slack:C0SIB', 'slack:C0SIB:1.0');

      expect(sessionIds(await listThreads(key))).toEqual([sessionId]);
      const { url } = parsed<{ url: string }>(await send('POST', `/v1/threads/${sessionId}/call`, { key }));
      expect(linkFor(new URL(url).hostname.split('.')[0])?.person.userId).toBe(sibling);
    });

    it('does not reach the same raw id on a bot in another workspace', async () => {
      const key = await pairedKey(person);
      const foreign = `slack-foreign:${person.slice('slack:'.length)}`;
      const sessionId = await accessOnlyAs(foreign, 'slack', 'slack-foreign', 'slack:C0FOR', 'slack:C0FOR:1.0');

      expect(await listThreads(key)).toEqual([]);
      expect((await send('POST', `/v1/threads/${sessionId}/call`, { key })).status).toBe(404);
    });

    it('never lists or calls a thread in another workspace, even when the raw id is a member there', async () => {
      const key = await pairedKey(person);
      await createMessagingGroup({
        id: 'mg-foreign',
        channel_type: 'slack-foreign',
        platform_id: 'slack:C0FOR',
        name: 'elsewhere',
        is_group: 1,
        unknown_sender_policy: 'strict',
        created_at: NOW,
      });
      const sessionId = await newSession({ messaging_group_id: 'mg-foreign', thread_id: 'slack:C0FOR:1.0' });

      expect(await listThreads(key)).toEqual([]);
      expect((await send('POST', `/v1/threads/${sessionId}/call`, { key })).status).toBe(404);
      expect(H.seeCalls).toBe(0);
    });

    it('covers a Discord id across bots, where the id is global', async () => {
      const paired = 'discord:7654321';
      await createUser({ id: paired, kind: 'discord', display_name: 'Same Person', created_at: NOW });
      await addMember({ user_id: paired, agent_group_id: 'ag-voice', added_by: null, added_at: NOW });
      const key = await pairedKey(paired);
      const sessionId = await accessOnlyAs(
        'discord-sibling:7654321',
        'discord',
        'discord-sibling',
        'discord:111:222',
        'discord:111:222:333',
      );

      expect(await listThreads(key)).toEqual([]);
      H.visible.add(paired);
      expect(await listThreads(key)).toEqual([]);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 60_000 * 11);
      await getDb().run('UPDATE sessions SET last_active = ? WHERE id = ?', new Date().toISOString(), sessionId);
      expect(sessionIds(await listThreads(key))).toEqual([sessionId]);
    });

    it('pools a channel root across sibling bots, which share its platform id, each with its own bot’s picture', async () => {
      await memberOf('ag-sibling');
      await shareWorkgroup();
      await channel('mg-sib', 'slack:C0TEST', 'slack-sibling', 'general');
      const key = await pairedKey(person);
      const sibling = await newSession({
        agent_group_id: 'ag-sibling',
        messaging_group_id: 'mg-sib',
        thread_id: null,
        last_active: ago(60_000),
      });
      const own = await newSession({ thread_id: null });

      expect(await listThreads(key)).toEqual([
        expect.objectContaining({
          agents: [
            { sessionId: sibling, agentGroupId: 'ag-sibling', name: 'Aster', avatarUrl: null },
            { sessionId: own, agentGroupId: 'ag-voice', name: 'Juniper', avatarUrl: PICTURE },
          ],
        }),
      ]);
    });

    it('drops only the agent whose visibility check fails', async () => {
      await memberOf('ag-sibling');
      await shareWorkgroup();
      await channel('mg-sib', 'slack:C0TEST', 'slack-sibling', 'general');
      const key = await pairedKey(person);
      const own = await newSession({ thread_id: 'slack:C0TEST:1.0' });
      await newSession({
        agent_group_id: 'ag-sibling',
        messaging_group_id: 'mg-sib',
        thread_id: 'slack:C0TEST:1.0',
      });
      H.failingBots.add('slack-sibling');

      expect(sessionIds(await listThreads(key))).toEqual([own]);
    });

    it('names the channel from whichever sibling bot knows its name', async () => {
      await channel('mg-sib', 'slack:C0TEST', 'slack-sibling', null);
      const key = await pairedKey(person);
      await newSession({ thread_id: 'slack:C0TEST:1.0', last_active: ago(60_000) });
      await newSession({ messaging_group_id: 'mg-sib', thread_id: 'slack:C0TEST:1.0' });

      expect(await listThreads(key)).toEqual([expect.objectContaining({ channelName: '#general' })]);
    });

    it('keys a row by the channel filter’s id, even when sibling bots disagree on the channel’s name', async () => {
      await channel('mg-sib', 'slack:C0TEST', 'slack-sibling', 'general-renamed');
      const key = await pairedKey(person);
      await newSession({ thread_id: 'slack:C0TEST:1.0', last_active: ago(60_000) });
      await newSession({ messaging_group_id: 'mg-sib', thread_id: 'slack:C0TEST:1.0' });

      const { threads, channels } = await listing(key);

      expect(channels).toHaveLength(1);
      expect(threads.map((row) => row.channelKey)).toEqual([channels[0].id]);
    });

    it('lists an agent once, on its freshest session, when it holds two in one thread', async () => {
      await channel('mg-sib', 'slack:C0TEST', 'slack-sibling', 'general');
      const key = await pairedKey(person);
      await newSession({ thread_id: 'slack:C0TEST:1.0', last_active: ago(60_000) });
      const fresh = await newSession({ messaging_group_id: 'mg-sib', thread_id: 'slack:C0TEST:1.0' });

      expect(sessionIds(await listThreads(key))).toEqual([fresh]);
    });
  });

  it('starts at most 40 new checks per list, then fills in on later polls, sharing reads within one list', async () => {
    const id = 'discord:1234567890';
    await createUser({ id, kind: 'discord', display_name: 'Someone Else', created_at: NOW });
    await addMember({ user_id: id, agent_group_id: 'ag-voice', added_by: null, added_at: NOW });
    H.visible.add(id);
    await createMessagingGroup({
      id: 'mg-discord',
      channel_type: 'discord',
      platform_id: 'discord:111:222',
      name: 'general',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: NOW,
    });
    for (let thread = 0; thread < 60; thread += 1)
      await newSession({ messaging_group_id: 'mg-discord', thread_id: `discord:111:222:${thread}` });
    const key = await pairedKey(id);

    expect(await listThreads(key)).toHaveLength(40);
    expect(H.seeCalls).toBe(40);
    expect(H.checkBatches.size).toBe(1);
    expect(await listThreads(key)).toHaveLength(60);
    expect(H.seeCalls).toBe(60);
    expect(H.checkBatches.size).toBe(2);
  });

  it('lists a Discord thread, its channel and its place as Discord for a Discord identity', async () => {
    const id = 'discord:1234567890';
    await createUser({ id, kind: 'discord', display_name: 'Someone Else', created_at: NOW });
    await addMember({ user_id: id, agent_group_id: 'ag-voice', added_by: null, added_at: NOW });
    H.visible.add(id);
    await createMessagingGroup({
      id: 'mg-discord',
      channel_type: 'discord',
      platform_id: 'discord:111:222',
      name: 'general',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: NOW,
    });
    const sessionId = await newSession({ messaging_group_id: 'mg-discord', thread_id: 'discord:111:222:333' });
    const key = await pairedKey(id);
    const list = await listing(key);
    expect(list.threads).toEqual([
      expect.objectContaining({
        platform: 'discord',
        agents: [expect.objectContaining({ sessionId })],
      }),
    ]);
    expect(list.channels).toEqual([expect.objectContaining({ name: '#general', platform: 'discord' })]);
    expect(parsed<{ places: unknown[] }>(await listPlacesFor(key)).places).toEqual([
      expect.objectContaining({ messagingGroupId: 'mg-discord', platform: 'discord' }),
    ]);
  });

  describe('title', () => {
    const human = (text: string) => ({ kind: 'chat-sdk', content: JSON.stringify({ text, author: { isBot: false } }) });

    it('times each stage of a slow list, including a title read no timer can interrupt', async () => {
      const key = await pairedKey(person);
      const tookTooLong = () =>
        vi.mocked(log.warn).mock.calls.filter(([message]) => message === 'Mobile: thread list took too long');
      vi.useFakeTimers({ toFake: ['Date'] });

      await listThreads(key);
      expect(tookTooLong()).toEqual([]);

      H.chats.set(await newSession(), [human('why is the sync late?')]);
      H.onTitleRead = () => vi.setSystemTime(Date.now() + 6_000);
      await listThreads(key);
      expect(tookTooLong()).toEqual([
        [
          'Mobile: thread list took too long',
          { ms: 6_000, stages: { access: 0, rows: 0, visibility: 0, summaries: 6_000 }, platform: 'slack' },
        ],
      ]);
    });
    const bot = (text: string) => ({ kind: 'chat-sdk', content: JSON.stringify({ text, author: { isBot: true } }) });

    const titleOf = async (sessionId: string, key: string) =>
      (await listThreads(key)).find((t) => t.agents.some((a) => a.sessionId === sessionId))?.title;

    it('falls back to the earliest human message, past bots, with platform mentions stripped', async () => {
      const key = await pairedKey(person);
      const id = await newSession();
      H.chats.set(id, [
        bot('Deploy finished'),
        human('<@U0AGENT> @Juniper  why did\n<#C0TEST|general> the <!here> nightly fail? ask me@example.test'),
        human('a later question'),
      ]);
      expect(await titleOf(id, key)).toBe('why did the nightly fail? ask me@example.test');
    });

    it('skips a first message that was only a mention', async () => {
      const key = await pairedKey(person);
      const id = await newSession();
      H.chats.set(id, [human('<@U0AGENT>'), human('what changed overnight?')]);
      expect(await titleOf(id, key)).toBe('what changed overnight?');
    });

    it('reads each session once, and trims to 120 characters without splitting one', async () => {
      const key = await pairedKey(person);
      const id = await newSession();
      H.chats.set(id, [human(`${'😀'.repeat(120)} and the rest`)]);
      const title = await titleOf(id, key);
      H.chats.set(id, [human('a different first message')]);

      expect(title).toBe('😀'.repeat(120));
      expect(await titleOf(id, key)).toBe(title);
    });

    it('leaves no trailing space where the trim lands between words', async () => {
      const key = await pairedKey(person);
      const id = await newSession();
      H.chats.set(id, [human(`${'a'.repeat(119)} tail`)]);
      expect(await titleOf(id, key)).toBe('a'.repeat(119));
    });

    it('picks up a person’s first words on a later list when a session had none yet', async () => {
      const key = await pairedKey(person);
      const id = await newSession();
      expect(await titleOf(id, key)).toBe('#general');
      H.chats.set(id, [human('now someone asked')]);
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.now() + 5 * 60_000 + 1);
      await getDb().run('UPDATE sessions SET last_active = ? WHERE id = ?', new Date().toISOString(), id);
      expect(await titleOf(id, key)).toBe('now someone asked');
    });

    it('opens a session with no human words once per five minutes, not once per poll', async () => {
      const key = await pairedKey(person);
      const id = await newSession();
      await titleOf(id, key);
      await titleOf(id, key);
      expect(H.titleReads).toBe(1);
    });

    it('takes the thread’s row first, then a generated title, then the first human words', async () => {
      const key = await pairedKey(person);
      const id = await newSession({ thread_id: 'slack:C0TEST:8.0' });
      H.chats.set(id, [human('the first human words')]);
      await setThreadTitle('slack:C0TEST:8.0', 'Renamed thread');
      await setTitle(id, 'Generated title', NOW);

      expect(await titleOf(id, key)).toBe('Renamed thread');
      await getDb().run('DELETE FROM thread_titles');
      expect(await titleOf(id, key)).toBe('Generated title');
      expect(H.titleReads).toBe(0);
      await getDb().run('UPDATE sessions SET title = NULL, title_generated_at = NULL WHERE id = ?', id);
      expect(await titleOf(id, key)).toBe('the first human words');
    });

    it('shows a name someone asked for, over any generated title', async () => {
      const key = await pairedKey(person);
      const thread = 'slack:C0TEST:8.6';
      const id = await newSession({ thread_id: thread });
      await setTitle(id, 'Generated title', NOW);
      await recordThreadPinned(thread, 'slack', 'Asked for');

      expect(await titleOf(id, key)).toBe('Asked for');
    });

    it('never shows the name a platform gave a thread, which is not a title', async () => {
      const key = await pairedKey(person);
      const thread = 'slack:C0TEST:8.5';
      const id = await newSession({ thread_id: thread });
      H.chats.set(id, [human('the first human words')]);
      await insertAutoThreadTitle(thread, 'discord', 'the first human words', null);
      await storeThreadPlatformName(thread, 'Thread 10/1/2026, 12:00:00 PM');

      expect(await titleOf(id, key)).toBe('the first human words');
    });

    it('takes the title generated last, not the one on the session active last', async () => {
      await memberOf('ag-sibling');
      await shareWorkgroup();
      const key = await pairedKey(person);
      const thread = { thread_id: 'slack:C0TEST:8.0' };
      const active = await newSession(thread);
      const idle = await newSession({ ...thread, agent_group_id: 'ag-sibling', last_active: ago(DAY_MS) });
      await setTitle(active, 'Title from an hour ago', ago(60 * 60_000));
      await setTitle(idle, 'Title from a minute ago', ago(60_000));

      expect(await titleOf(active, key)).toBe('Title from a minute ago');
    });

    it.each<[string, (id: string) => Promise<unknown>]>([
      [
        'of an agent not enabled for calls',
        () => newSession({ agent_group_id: 'ag-quiet', thread_id: 'slack:C0TEST:8.0' }),
      ],
      [
        'that was closed',
        () => newSession({ agent_group_id: 'ag-sibling', thread_id: 'slack:C0TEST:8.0', status: 'closed' }),
      ],
      [
        'that was archived',
        () => newSession({ agent_group_id: 'ag-sibling', thread_id: 'slack:C0TEST:8.0', archived_at: NOW }),
      ],
    ])('pools the title of a session %s, which the row does not list', async (_name, arrange) => {
      await shareWorkgroup();
      const key = await pairedKey(person);
      const listed = await newSession({ thread_id: 'slack:C0TEST:8.0' });
      await setTitle(listed, 'Older title', ago(60 * 60_000));
      const unlisted = (await arrange(listed)) as string;
      await setTitle(unlisted, 'Fresher title', ago(60_000));

      expect(await listThreads(key)).toEqual([
        expect.objectContaining({
          title: 'Fresher title',
          agents: [expect.objectContaining({ sessionId: listed })],
        }),
      ]);
    });

    it('takes the first human words from a sibling when the newest session has none', async () => {
      await memberOf('ag-sibling');
      await shareWorkgroup();
      const key = await pairedKey(person);
      const thread = { thread_id: 'slack:C0TEST:8.0' };
      const botsOnly = await newSession(thread);
      const asked = await newSession({ ...thread, agent_group_id: 'ag-sibling', last_active: ago(60_000) });
      H.chats.set(asked, [human('why is the sync late?')]);

      expect(await titleOf(botsOnly, key)).toBe('why is the sync late?');
    });

    it('skips a replayed thread history when it looks for the first human words', async () => {
      const key = await pairedKey(person);
      const id = await newSession();
      const block = await buildThreadContextBlock({
        session: { id, engaged_at: null, last_outbound_at: null } as never,
        adapter: { fetchThreadHistory: async () => [{ sender: 'Someone', text: 'earlier talk', timestamp: NOW }] },
        threadId: 'slack:C0TEST:1.0',
      });
      H.chats.set(id, [human(`${block}\n[Latest message]\nrun it`), human('what changed overnight?')]);

      expect(await titleOf(id, key)).toBe('what changed overnight?');
    });

    it('falls back to the channel, then to "Thread"', async () => {
      const key = await pairedKey(person);
      const id = await newSession();
      expect(await titleOf(id, key)).toBe('#general');

      await getDb().run('UPDATE messaging_groups SET name = NULL WHERE id = ?', CHANNEL);
      expect(await listThreads(key)).toContainEqual(expect.objectContaining({ title: 'Thread', channelName: null }));
    });
  });

  it('names who is in the room, reads an empty room as no call, and still lets POST join it', async () => {
    const key = await pairedKey(person);
    const sessionId = await newSession();
    const { url } = parsed<{ url: string }>(await send('POST', `/v1/threads/${sessionId}/call`, { key }));
    expect((await listThreads(key))[0].call).toBeNull();

    H.roomPeople = [linkFor(new URL(url).hostname.split('.')[0])!.person.identity];
    await vi.waitFor(
      async () =>
        expect((await listThreads(key))[0].call).toEqual({
          sessionId,
          agentName: 'Juniper',
          avatarUrl: null,
          people: [nameOf(person)],
        }),
      { timeout: 5000 },
    );

    H.roomPeople = [];
    await vi.waitFor(async () => expect((await listThreads(key))[0].call).toBeNull(), { timeout: 5000 });
    const next = await send('POST', `/v1/threads/${sessionId}/call`, { key: await pairedKey(await newPerson()) });
    expect(parsed(next)).toMatchObject({ joined: true });
  });

  it('lists a thread with someone in the room for everyone, however old it is and however full the list', async () => {
    const key = await pairedKey(person);
    const sessionId = await newSession({ last_active: new Date(Date.now() - 30 * 24 * 60 * 60_000).toISOString() });
    for (let i = 0; i < 100; i += 1) await newSession();
    const { url } = parsed<{ url: string }>(await send('POST', `/v1/threads/${sessionId}/call`, { key }));
    const colleague = await pairedKey(await newPerson());
    expect(sessionIds(await listThreads(colleague))).not.toContain(sessionId);

    H.roomPeople = [linkFor(new URL(url).hostname.split('.')[0])!.person.identity];
    await vi.waitFor(async () => expect(sessionIds(await listThreads(colleague))).toContain(sessionId), {
      timeout: 5000,
    });
    expect((await listThreads(colleague))[0].call?.sessionId).toBe(sessionId);
  });

  it('offers a call only on an agent this person can reach, so Join never lands on a 404', async () => {
    await memberOf('ag-sibling');
    await shareWorkgroup();
    const key = await pairedKey(person);
    const thread = { thread_id: 'slack:C0TEST:1.0' };
    const listed = await newSession(thread);
    const gone = await newSession({ ...thread, agent_group_id: 'ag-sibling' });
    const { url } = parsed<{ url: string }>(await send('POST', `/v1/threads/${gone}/call`, { key }));
    H.roomPeople = [linkFor(new URL(url).hostname.split('.')[0])!.person.identity];
    await vi.waitFor(async () => expect((await listThreads(key))[0].call?.sessionId).toBe(gone), { timeout: 5000 });

    await getDb().run(`DELETE FROM agent_group_members WHERE agent_group_id = 'ag-sibling'`);

    expect(await listThreads(key)).toEqual([
      expect.objectContaining({ agents: [expect.objectContaining({ sessionId: listed })], call: null }),
    ]);
  });

  describe('one row per thread', () => {
    const thread = { thread_id: 'slack:C0TEST:5.0' };

    beforeEach(async () => {
      await memberOf('ag-sibling');
      await shareWorkgroup();
    });

    it('pools a thread’s sessions, with its agents by name and its newest activity', async () => {
      const key = await pairedKey(person);
      const newest = ago(60_000);
      const juniper = await newSession({ ...thread, last_active: newest });
      const aster = await newSession({ ...thread, agent_group_id: 'ag-sibling', last_active: ago(60 * 60_000) });

      expect(await listThreads(key)).toEqual([
        expect.objectContaining({
          lastActiveAt: newest,
          agents: [
            { sessionId: aster, agentGroupId: 'ag-sibling', name: 'Aster', avatarUrl: null },
            { sessionId: juniper, agentGroupId: 'ag-voice', name: 'Juniper', avatarUrl: null },
          ],
        }),
      ]);
    });

    it('keeps a quiet agent on a thread its sibling keeps busy', async () => {
      const key = await pairedKey(person);
      const quiet = await newSession({ ...thread, last_active: ago(30 * DAY_MS) });
      const busy = await newSession({ ...thread, agent_group_id: 'ag-sibling' });

      expect(sessionIds(await listThreads(key)).sort()).toEqual([busy, quiet].sort());
    });

    it('ages a thread by any live session, listed or not', async () => {
      const key = await pairedKey(person);
      const fresh = ago(60_000);
      const idle = await newSession({ ...thread, last_active: ago(30 * DAY_MS) });
      await newSession({ ...thread, agent_group_id: 'ag-quiet', last_active: fresh });

      expect(await listThreads(key)).toEqual([
        expect.objectContaining({ lastActiveAt: fresh, agents: [expect.objectContaining({ sessionId: idle })] }),
      ]);
    });

    it('does not let a closed session keep a thread in the window', async () => {
      const key = await pairedKey(person);
      await newSession({ ...thread, last_active: ago(30 * DAY_MS) });
      await newSession({ ...thread, agent_group_id: 'ag-sibling', status: 'closed' });

      expect(await listThreads(key)).toEqual([]);
    });

    it('sorts threads by their newest session', async () => {
      const key = await pairedKey(person);
      const quietThread = await newSession({ last_active: ago(60_000) });
      const busyThread = await newSession({ ...thread, last_active: ago(60 * 60_000) });
      await newSession({ ...thread, agent_group_id: 'ag-quiet' });

      expect(sessionIds(await listThreads(key))).toEqual([busyThread, quietThread]);
    });

    it('keeps two workgroups in one channel as two rows, and neither borrows the other’s title', async () => {
      await inWorkgroup('ag-voice', 'acme', 'Acme');
      await inWorkgroup('ag-sibling', 'globex', 'Globex');
      const key = await pairedKey(person);
      const acme = await newSession(thread);
      const globex = await newSession({ ...thread, agent_group_id: 'ag-sibling' });
      await setTitle(globex, 'Globex title', NOW);

      const threads = await listThreads(key);

      expect(threads.map((t) => [t.workgroupId, sessionIds([t]), t.title]).sort()).toEqual([
        ['acme', [acme], '#general'],
        ['globex', [globex], 'Globex title'],
      ]);
      expect(new Set(threads.map((t) => t.threadKey)).size).toBe(2);
    });

    it('counts threads against the limit, not sessions', async () => {
      const key = await pairedKey(person);
      for (let i = 0; i < 101; i += 1) {
        const pair = { thread_id: `slack:C0TEST:${i}.5`, last_active: ago(i * 60_000) };
        await newSession(pair);
        await newSession({ ...pair, agent_group_id: 'ag-sibling' });
      }

      const threads = await listThreads(key);

      expect(threads).toHaveLength(100);
      expect(threads.every((t) => t.agents.length === 2)).toBe(true);
    });

    it('gives a thread the same opaque key however its sessions change', async () => {
      const key = await pairedKey(person);
      await newSession(thread);
      const [before] = await listThreads(key);
      await newSession({ ...thread, agent_group_id: 'ag-sibling' });
      const [after] = await listThreads(key);

      expect(after.threadKey).toBe(before.threadKey);
      expect(after.threadKey).not.toContain('C0TEST');
    });
  });

  it('takes a Discord agent’s picture from its Discord bot', async () => {
    const id = 'discord:1234567890';
    await createUser({ id, kind: 'discord', display_name: 'Someone Else', created_at: NOW });
    await memberOf('ag-voice', id);
    H.visible.add(id);
    await channel('mg-discord', 'discord:111:222', 'discord', 'general');
    const sessionId = await newSession({ messaging_group_id: 'mg-discord', thread_id: 'discord:111:222:7' });
    const cdn = 'https://cdn.discordapp.com/avatars/1111111111/abc123.png?size=256';
    H.discordBots.set('discord', { userId: '1111111111', username: 'Juniper', avatarUrl: cdn });

    expect((await listThreads(await pairedKey(id))).map((t) => t.agents)).toEqual([
      [{ sessionId, agentGroupId: 'ag-voice', name: 'Juniper', avatarUrl: cdn }],
    ]);
  });

  describe('workgroup filter', () => {
    beforeEach(async () => {
      await memberOf('ag-sibling');
      await inWorkgroup('ag-voice', 'acme', 'Acme');
      await inWorkgroup('ag-sibling', 'globex', 'Globex');
    });

    it('lists only that workgroup’s threads, and leaves the picker whole', async () => {
      const key = await pairedKey(person);
      const shown = await newSession();
      await newSession({ agent_group_id: 'ag-sibling' });

      const { threads, workgroups } = await listing(key, { workgroup: 'acme' });

      expect(sessionIds(threads)).toEqual([shown]);
      expect(workgroups.map((w) => w.id)).toEqual(['acme', 'globex']);
    });

    it.each<[string, string]>([
      ['an unknown id', 'no-such-workgroup'],
      ['a workgroup this person has no access to', 'initech'],
    ])('answers %s with no threads and no error, and never widens', async (_name, workgroup) => {
      await inWorkgroup('ag-quiet', 'initech', 'Initech');
      await getDb().run(`DELETE FROM agent_group_members WHERE agent_group_id = 'ag-quiet'`);
      const key = await pairedKey(person);
      await newSession();
      await newSession({ agent_group_id: 'ag-quiet' });

      const res = await send('GET', `/v1/threads?workgroup=${workgroup}`, { key });

      expect(res.status).toBe(200);
      expect(parsed<{ threads: unknown[] }>(res).threads).toEqual([]);
    });

    it('spends no list slots on another workgroup, so a quiet one is not starved', async () => {
      const key = await pairedKey(person);
      for (let i = 0; i < 101; i += 1) await newSession({ last_active: ago(i * 60_000) });
      const quiet = await newSession({ agent_group_id: 'ag-sibling', last_active: ago(6 * DAY_MS) });

      expect(sessionIds(await listThreads(key, { workgroup: 'globex' }))).toEqual([quiet]);
    });
  });

  describe('the workgroups picker', () => {
    it('names every workgroup the person can call in by name, with a thread in the window or not', async () => {
      await memberOf('ag-sibling');
      await inWorkgroup('ag-voice', 'zed', 'Zebra');
      await inWorkgroup('ag-sibling', 'ant', 'Antelope');
      await channel('mg-other', 'slack:C0OTHER');
      await wire(CHANNEL);
      await wire('mg-other', 'ag-sibling');

      expect((await listing(await pairedKey(person))).workgroups).toEqual([
        { id: 'ant', name: 'Antelope' },
        { id: 'zed', name: 'Zebra' },
      ]);
    });

    it.each<[string, () => Promise<unknown>]>([
      ['a group the person fails mayCall for', () => wire(CHANNEL, 'ag-sibling')],
      [
        'an agent not enabled for calls',
        async () => {
          await memberOf('ag-quiet');
          await wire(CHANNEL, 'ag-quiet');
        },
      ],
      [
        'a DM recorded as nobody’s',
        async () => {
          await memberOf('ag-sibling');
          await channel('mg-dm', 'slack:D0DM');
          await wire('mg-dm', 'ag-sibling');
        },
      ],
      [
        'another workspace',
        async () => {
          await memberOf('ag-sibling');
          await channel('mg-far', 'slack:C0FAR', 'slack-foreign');
          await wire('mg-far', 'ag-sibling');
        },
      ],
    ])('leaves out a workgroup reachable only through %s', async (_name, arrange) => {
      await inWorkgroup('ag-sibling', 'other', 'Other');
      await inWorkgroup('ag-quiet', 'other', 'Other');
      await wire(CHANNEL);
      await arrange();

      expect((await listing(await pairedKey(person))).workgroups).toEqual([
        { id: '_agent-group:ag-voice', name: 'juniper' },
      ]);
    });

    it('leaves out another platform’s workgroups', async () => {
      const id = 'discord:5550001';
      await createUser({ id, kind: 'discord', display_name: 'Someone Else', created_at: NOW });
      await memberOf('ag-voice', id);
      await wire(CHANNEL);

      expect((await listing(await pairedKey(id))).workgroups).toEqual([]);
    });

    it('ignores the filters, opens no session DB and makes no platform read', async () => {
      await newSession();

      const { threads, workgroups } = await listing(await pairedKey(person), { workgroup: 'none', q: 'nothing' });

      expect(threads).toEqual([]);
      expect(workgroups).toEqual([{ id: '_agent-group:ag-voice', name: 'juniper' }]);
      expect(H.seeCalls).toBe(0);
      expect(H.titleReads).toBe(0);
    });

    it('is empty with the list when group calls are not configured on this host', async () => {
      await newSession();
      H.callsConfigured = false;

      expect(await listing(await pairedKey(person))).toEqual({ threads: [], workgroups: [], channels: [] });
    });
  });

  describe('the channel filter', () => {
    const SECOND = 'mg-second';
    const channelNamed = (list: { channels: ChannelRow[] }, name: string) =>
      list.channels.find((row) => row.name === name)?.id ?? 'not-listed';

    /** A workgroup with threads in two channels, and a key that has listed both. */
    async function twoChannels(): Promise<{
      key: string;
      first: string;
      second: string;
      general: string;
      other: string;
    }> {
      const key = await pairedKey(person);
      await inWorkgroup('ag-voice', 'acme', 'Acme');
      await channel(SECOND, 'slack:C0SECOND', 'slack', 'second');
      const first = await newSession();
      const second = await newSession({ messaging_group_id: SECOND, thread_id: 'slack:C0SECOND:1.0' });
      const list = await listing(key);
      return { key, first, second, general: channelNamed(list, '#general'), other: channelNamed(list, '#second') };
    }

    it('lists one channel per workgroup and platform channel, by name, across sibling bots', async () => {
      const { key } = await twoChannels();
      await memberOf('ag-sibling');
      await inWorkgroup('ag-sibling', 'acme', 'Acme');
      await newSession({ agent_group_id: 'ag-sibling' });

      expect((await listing(key)).channels).toEqual([
        { id: expect.any(String), workgroupId: 'acme', platform: 'slack', name: '#general' },
        { id: expect.any(String), workgroupId: 'acme', platform: 'slack', name: '#second' },
      ]);
    });

    it('narrows to that channel and leaves both pickers whole', async () => {
      const { key, first, general } = await twoChannels();

      const { threads, workgroups, channels } = await listing(key, { channel: general });

      expect(sessionIds(threads)).toEqual([first]);
      expect(workgroups).toEqual([{ id: 'acme', name: 'Acme' }]);
      expect(channels.map((row) => row.name)).toEqual(['#general', '#second']);
    });

    it.each<[string, Record<string, string>]>([
      ['an unknown channel', { channel: 'no-such-channel' }],
      ['an unknown channel with a workgroup', { channel: 'no-such-channel', workgroup: 'acme' }],
      ['an unknown channel with a search', { channel: 'no-such-channel', q: 'general' }],
    ])('answers %s with no threads and no error, and never widens', async (_name, query) => {
      const { key } = await twoChannels();

      const res = await send('GET', `/v1/threads?${new URLSearchParams(query)}`, { key });

      expect(res.status).toBe(200);
      expect(parsed<{ threads: unknown[] }>(res).threads).toEqual([]);
    });

    it('never crosses workgroups: one channel in two workgroups has a key for each', async () => {
      const key = await pairedKey(person);
      await memberOf('ag-sibling');
      await inWorkgroup('ag-voice', 'acme', 'Acme');
      await inWorkgroup('ag-sibling', 'globex', 'Globex');
      const thread = { thread_id: 'slack:C0TEST:7.0' };
      const acme = await newSession(thread);
      const globex = await newSession({ ...thread, agent_group_id: 'ag-sibling' });
      const { channels } = await listing(key);
      const of = (workgroup: string) => channels.find((row) => row.workgroupId === workgroup)!.id;

      expect(sessionIds(await listThreads(key, { channel: of('acme') }))).toEqual([acme]);
      expect(sessionIds(await listThreads(key, { channel: of('globex') }))).toEqual([globex]);
      expect(await listThreads(key, { channel: of('acme'), workgroup: 'globex' })).toEqual([]);
    });

    it('combines with a title search and with a search of message text', async () => {
      const { key, first, second, general, other } = await twoChannels();
      await setTitle(first, 'Rollout plan', NOW);
      await setTitle(second, 'Rollout plan', NOW);
      await said('the zeppelin landed', { threadId: 'slack:C0SECOND:1.0', platformId: 'slack:C0SECOND' });
      await searchable();

      expect(sessionIds(await listThreads(key, { channel: general, q: 'rollout' }))).toEqual([first]);
      expect(sessionIds(await listThreads(key, { channel: other, q: 'zeppelin' }))).toEqual([second]);
      expect(await listThreads(key, { channel: general, q: 'zeppelin' })).toEqual([]);
    });

    it('spends no list slots on another channel, so a quiet one is not starved', async () => {
      const key = await pairedKey(person);
      await channel(SECOND, 'slack:C0SECOND', 'slack', 'second');
      const quiet = await newSession({ messaging_group_id: SECOND, last_active: ago(6 * DAY_MS) });
      for (let i = 0; i < 100; i += 1) await newSession({ last_active: ago(i * 60_000) });
      await listPlacesFor(key);
      const id = channelNamed(await listing(key), '#second');

      expect(sessionIds(await listThreads(key, { channel: id }))).toEqual([quiet]);
    });

    it('names no channel the person has not passed a check for, private or unused', async () => {
      const key = await pairedKey(person);
      await channel('mg-private', 'slack:C0HIDDEN', 'slack', 'leadership-pay');
      await channel(SECOND, 'slack:C0SECOND', 'slack', 'second');
      H.hiddenChannels.add('C0HIDDEN');
      await newSession({ messaging_group_id: 'mg-private', thread_id: 'slack:C0HIDDEN:1.0' });
      await wire(SECOND);
      await newSession();

      const res = await send('GET', '/v1/threads', { key });

      expect(parsed<{ channels: ChannelRow[] }>(res).channels.map((row) => row.name)).toEqual(['#general']);
      expect(res.body).not.toContain('leadership-pay');
    });

    it('lists a channel with nothing on the thread list once the New call picker has checked it', async () => {
      const key = await pairedKey(person);
      await channel(SECOND, 'slack:C0SECOND', 'slack', 'second');
      await wire(SECOND);
      await newSession();
      expect((await listing(key)).channels.map((row) => row.name)).toEqual(['#general']);

      await listPlacesFor(key);

      expect((await listing(key)).channels.map((row) => row.name)).toEqual(['#general', '#second']);
    });

    it('lists a quiet channel, and finds text in it, once the scheduled check has passed it', async () => {
      const key = await pairedKey(person);
      await channel('mg-quiet', 'slack:C0QUIET', 'slack', 'quiet');
      await newSession();
      const quiet = await newSession({
        messaging_group_id: 'mg-quiet',
        thread_id: 'slack:C0QUIET:1.0',
        last_active: ago(8 * DAY_MS),
      });
      await said('the zeppelin landed', { platformId: 'slack:C0QUIET', threadId: 'slack:C0QUIET:1.0' });
      expect((await listing(key)).channels.map((row) => row.name)).toEqual(['#general']);

      await searchable();

      expect((await listing(key)).channels.map((row) => row.name)).toEqual(['#general', '#quiet']);
      expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([quiet]);
    });

    it('asks the platform nothing to build the list, and keeps a name through an outage', async () => {
      const { key } = await twoChannels();
      const before = H.seeCalls;
      H.seeFails = true;

      const { threads, channels } = await listing(key);

      expect(H.seeCalls).toBe(before);
      expect(threads).toHaveLength(2);
      expect(channels.map((row) => row.name)).toEqual(['#general', '#second']);
    });

    it('forgets a channel a day after the person last passed a check there', async () => {
      const { key } = await twoChannels();
      H.hiddenChannels.add('C0SECOND');
      vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 23 * 60 * 60_000 });
      expect((await listing(key)).channels.map((row) => row.name)).toEqual(['#general', '#second']);

      vi.setSystemTime(Date.now() + 60 * 60_000 + 1);

      expect((await listing(key)).channels.map((row) => row.name)).toEqual(['#general']);
    });
  });

  describe('search', () => {
    /** Listed with no search, beside whatever a test arranges, and matching none of the terms below. */
    async function bystander(): Promise<string> {
      await memberOf('ag-sibling');
      await channel('mg-other', 'slack:C0OTHER', 'slack', 'unrelated');
      return newSession({
        agent_group_id: 'ag-sibling',
        messaging_group_id: 'mg-other',
        thread_id: 'slack:C0OTHER:1.0',
      });
    }

    it.each<[string, string, (id: string) => Promise<unknown>]>([
      ['the generated title', 'SNOWFLAKE audit', (id) => setTitle(id, 'Snowflake audit notes', NOW)],
      ['the Discord thread title', 'nightly', () => setThreadTitle('slack:C0TEST:7.0', 'The NIGHTLY failed')],
      ['the channel name', 'GENER', async () => undefined],
      ['the channel name as shown', '#general', async () => undefined],
      ['the agent name', 'junip', async () => undefined],
      [
        'the agent name as shown',
        'anderton',
        async () => {
          H.spokenNames.set('ag-voice', 'Anderton');
        },
      ],
    ])('finds a thread by %s, in any case', async (_name, q, arrange) => {
      const key = await pairedKey(person);
      const other = await bystander();
      const id = await newSession({ thread_id: 'slack:C0TEST:7.0' });
      await arrange(id);

      expect(sessionIds(await listThreads(key)).sort()).toEqual([id, other].sort());
      expect(sessionIds(await listThreads(key, { q }))).toEqual([id]);
    });

    it('does not find a thread by the name of an agent whose session there is closed', async () => {
      const key = await pairedKey(person);
      await memberOf('ag-sibling');
      await shareWorkgroup();
      const thread = { thread_id: 'slack:C0TEST:7.0' };
      await newSession(thread);
      await newSession({ ...thread, agent_group_id: 'ag-sibling', status: 'closed' });

      expect(await listThreads(key, { q: 'aster' })).toEqual([]);
    });

    it('keeps the whole thread when one session matches', async () => {
      const key = await pairedKey(person);
      await memberOf('ag-sibling');
      await shareWorkgroup();
      const thread = { thread_id: 'slack:C0TEST:7.0' };
      const juniper = await newSession(thread);
      const aster = await newSession({ ...thread, agent_group_id: 'ag-sibling' });
      await setTitle(aster, 'Rollout plan', NOW);

      expect(sessionIds(await listThreads(key, { q: 'rollout' })).sort()).toEqual([aster, juniper].sort());
    });

    it('finds a thread by a title on a session it does not list', async () => {
      const key = await pairedKey(person);
      await shareWorkgroup();
      const thread = { thread_id: 'slack:C0TEST:7.0' };
      const listed = await newSession(thread);
      await setTitle(await newSession({ ...thread, agent_group_id: 'ag-quiet' }), 'Rollout plan', NOW);

      expect(sessionIds(await listThreads(key, { q: 'rollout' }))).toEqual([listed]);
    });

    it('does not find a thread by the name of an agent this person cannot call there', async () => {
      const key = await pairedKey(person);
      await shareWorkgroup();
      const thread = { thread_id: 'slack:C0TEST:7.0' };
      await newSession(thread);
      await newSession({ ...thread, agent_group_id: 'ag-quiet' });

      expect(await listThreads(key, { q: 'quiet' })).toEqual([]);
    });

    it.each([
      ['%', 'ship 100% of it'],
      ['_', 'snake_case names'],
      ['\\', 'a C:\\path'],
      ["'; DROP TABLE sessions; --", "note '; DROP TABLE sessions; -- here"],
    ])('takes %j literally, as text and never as a pattern or as SQL', async (q, title) => {
      const key = await pairedKey(person);
      await setTitle(await bystander(), 'plain words', NOW);
      const id = await newSession();
      await setTitle(id, title, NOW);

      expect(sessionIds(await listThreads(key, { q }))).toEqual([id]);
      expect(sessionIds(await listThreads(key))).toHaveLength(2);
    });

    it('trims the text, and caps it at 100 characters', async () => {
      const key = await pairedKey(person);
      const hundred = `${'x'.repeat(99)}b`;
      const id = await newSession();
      await setTitle(id, hundred, NOW);
      await setTitle(await newSession(), `${'x'.repeat(99)}c`, NOW);

      expect(sessionIds(await listThreads(key, { q: `  ${hundred}  ` }))).toEqual([id]);
      expect(sessionIds(await listThreads(key, { q: `${hundred}zzz` }))).toEqual([id]);
    });

    it('treats blank text as no search, on the default window', async () => {
      const key = await pairedKey(person);
      await newSession({ last_active: ago(30 * DAY_MS) });
      const recent = await newSession();

      expect(sessionIds(await listThreads(key, { q: '   ' }))).toEqual([recent]);
    });

    it.each([
      ['finds', 89, true],
      ['does not find', 91, false],
    ])('%s a thread idle %i days', async (_verb, days, found) => {
      const key = await pairedKey(person);
      const id = await newSession({ last_active: ago(days * DAY_MS) });
      await setTitle(id, 'Rollout plan', NOW);

      expect(sessionIds(await listThreads(key, { q: 'rollout' }))).toEqual(found ? [id] : []);
    });

    it('stops at the newest 30 threads, counted after access is checked', async () => {
      const key = await pairedKey(person);
      const shown: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const id = await newSession({ agent_group_id: 'ag-sibling', last_active: ago(i * 60_000) });
        await setTitle(id, 'Rollout plan', NOW);
      }
      for (let i = 0; i < 31; i += 1) {
        const id = await newSession({ last_active: ago((10 + i) * 60_000) });
        await setTitle(id, 'Rollout plan', NOW);
        shown.push(id);
      }

      expect(sessionIds(await listThreads(key, { q: 'rollout' }))).toEqual(shown.slice(0, 30));
    });

    it('combines with the workgroup filter', async () => {
      const key = await pairedKey(person);
      await inWorkgroup('ag-sibling', 'globex', 'Globex');
      await inWorkgroup('ag-voice', 'acme', 'Acme');
      await setTitle(await bystander(), 'Rollout plan', NOW);
      const id = await newSession();
      await setTitle(id, 'Rollout plan', NOW);

      expect(sessionIds(await listThreads(key, { workgroup: 'acme', q: 'rollout' }))).toEqual([id]);
    });

    describe('as a tenant of its workgroups', () => {
      const own = 'slack:C0TEST:7.0';
      const elsewhere = 'slack:C0OTHER:1.0';

      /** Lists `q` and an absent word under the same filters: the response, the checks and the archive reads. */
      async function costOf(key: string, filters: Record<string, string>, q: string) {
        const [checks, statements, walks] = [H.seeCalls, H.statements, H.walks];
        const res = await send('GET', `/v1/threads?${new URLSearchParams({ ...filters, q })}`, { key });
        return {
          body: res.body,
          checks: H.seeCalls - checks,
          statements: H.statements - statements,
          walks: H.walks - walks,
        };
      }

      it.each<[string, () => Promise<unknown>]>([
        [
          'in a thread of another workgroup',
          async () => {
            await inWorkgroup('ag-sibling', 'globex', 'Globex');
            await channel('mg-other', 'slack:C0OTHER');
            await newSession({ agent_group_id: 'ag-sibling', messaging_group_id: 'mg-other', thread_id: elsewhere });
            await said('the zeppelin landed', {
              agent: 'ag-sibling',
              platformId: 'slack:C0OTHER',
              threadId: elsewhere,
            });
          },
        ],
        [
          'in another workgroup’s copy of a thread in their own channel',
          async () => {
            await inWorkgroup('ag-sibling', 'globex', 'Globex');
            await newSession({ thread_id: 'slack:C0TEST:8.0' });
            await newSession({ agent_group_id: 'ag-sibling', thread_id: 'slack:C0TEST:8.0' });
            await said('the zeppelin landed', { agent: 'ag-sibling', threadId: 'slack:C0TEST:8.0' });
          },
        ],
        [
          'held by an agent of no workgroup of theirs',
          async () => {
            await channel('mg-other', 'slack:C0OTHER');
            await newSession({ agent_group_id: 'ag-sibling', messaging_group_id: 'mg-other', thread_id: elsewhere });
            await said('the zeppelin landed', {
              agent: 'ag-sibling',
              platformId: 'slack:C0OTHER',
              threadId: elsewhere,
            });
          },
        ],
        [
          'in a private channel of their own workgroup they are not in',
          async () => {
            await channel('mg-other', 'slack:C0OTHER');
            H.hiddenChannels.add('C0OTHER');
            await newSession({ messaging_group_id: 'mg-other', thread_id: elsewhere });
            await said('the zeppelin landed', { platformId: 'slack:C0OTHER', threadId: elsewhere });
          },
        ],
        [
          'in a separate employer’s workgroup, in a Slack workspace of its own',
          async () => {
            await memberOf('ag-sibling');
            await inWorkgroup('ag-sibling', 'northwind', 'Northwind Bank');
            await channel('mg-foreign', 'slack:C0FOR', 'slack-foreign');
            await newSession({
              agent_group_id: 'ag-sibling',
              messaging_group_id: 'mg-foreign',
              thread_id: 'slack:C0FOR:1.0',
            });
            await said('the zeppelin landed', {
              agent: 'ag-sibling',
              channelType: 'slack-foreign',
              platformId: 'slack:C0FOR',
              threadId: 'slack:C0FOR:1.0',
            });
          },
        ],
      ])('answers a word that sits only %s exactly as a word held nowhere', async (_name, arrange) => {
        await inWorkgroup('ag-voice', 'acme', 'Acme');
        const key = await pairedKey(person);
        await newSession({ thread_id: own });
        await said('a quiet afternoon', { threadId: own });
        vi.useFakeTimers({ toFake: ['Date'] });
        await searchable();
        const before = await costOf(key, {}, 'absentword');

        await arrange();
        vi.setSystemTime(Date.now() + 15 * 60_000);
        await searchable();
        const held = await costOf(key, {}, 'zeppelin');
        const absent = await costOf(key, {}, 'absentword');

        expect(held).toEqual(absent);
        expect(absent.statements).toBe(before.statements);
        expect(held.walks).toBe(1);
        expect(held.statements).toBeGreaterThan(0);
        expect(parsed<{ threads: unknown[] }>({ body: held.body }).threads).toEqual([]);
      });

      it.each<[string, boolean]>([
        ['someone', false],
        ['an owner', true],
      ])(
        'answers %s filtered to one workgroup exactly the same for a word only another holds',
        async (_name, owner) => {
          await inWorkgroup('ag-voice', 'acme', 'Acme');
          await inWorkgroup('ag-sibling', 'globex', 'Globex');
          await channel('mg-other', 'slack:C0OTHER');
          const key = await pairedKey(person);
          await newSession({ thread_id: own });
          await said('a quiet afternoon', { threadId: own });
          vi.useFakeTimers({ toFake: ['Date'] });
          await searchable();
          const acmeOnly = await costOf(key, { workgroup: 'acme' }, 'absentword');

          if (owner) await makeOwner();
          else await memberOf('ag-sibling');
          const theirs = await newSession({
            agent_group_id: 'ag-sibling',
            messaging_group_id: 'mg-other',
            thread_id: elsewhere,
          });
          await said('the zeppelin landed', { agent: 'ag-sibling', platformId: 'slack:C0OTHER', threadId: elsewhere });
          vi.setSystemTime(Date.now() + 15 * 60_000);
          await searchable();
          expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([theirs]);
          const held = await costOf(key, { workgroup: 'acme' }, 'zeppelin');
          const absent = await costOf(key, { workgroup: 'acme' }, 'absentword');

          expect(held).toEqual(absent);
          expect([absent.statements, absent.checks, absent.walks]).toEqual([
            acmeOnly.statements,
            acmeOnly.checks,
            acmeOnly.walks,
          ]);
          expect(held.walks).toBe(1);
          expect(held.statements).toBeGreaterThan(0);
        },
      );

      it('lets an owner under All find a word in every workgroup, and on one chip only in that one', async () => {
        await makeOwner();
        await inWorkgroup('ag-voice', 'acme', 'Acme');
        await inWorkgroup('ag-sibling', 'globex', 'Globex');
        await channel('mg-other', 'slack:C0OTHER');
        const key = await pairedKey(person);
        const mine = await newSession({ thread_id: own });
        const theirs = await newSession({
          agent_group_id: 'ag-sibling',
          messaging_group_id: 'mg-other',
          thread_id: elsewhere,
        });
        await said('the zeppelin landed', { threadId: own });
        await said('the zeppelin landed', { agent: 'ag-sibling', platformId: 'slack:C0OTHER', threadId: elsewhere });
        await searchable();

        expect(sessionIds(await listThreads(key, { q: 'zeppelin' })).sort()).toEqual([mine, theirs].sort());
        expect(sessionIds(await listThreads(key, { workgroup: 'globex', q: 'zeppelin' }))).toEqual([theirs]);
      });

      it('finds an agent group’s words in the workgroup it was in when it said them, before and after a move', async () => {
        await inWorkgroup('ag-voice', 'acme', 'Acme');
        await inWorkgroup('ag-sibling', 'acme', 'Acme');
        await memberOf('ag-sibling');
        const key = await pairedKey(person);
        const [first, second] = ['slack:C0TEST:8.0', 'slack:C0TEST:9.0'];
        const mine = await newSession({ thread_id: first });
        await newSession({ agent_group_id: 'ag-sibling', thread_id: first });
        await said('the zeppelin landed', { agent: 'ag-sibling', threadId: first });
        await inWorkgroup('ag-sibling', 'globex', 'Globex');
        const theirs = await newSession({ agent_group_id: 'ag-sibling', thread_id: second });
        await said('the zeppelin left', { agent: 'ag-sibling', threadId: second });
        await searchable();

        expect(sessionIds(await listThreads(key, { workgroup: 'acme', q: 'zeppelin' }))).toEqual([mine]);
        expect(sessionIds(await listThreads(key, { workgroup: 'globex', q: 'zeppelin' }))).toEqual([theirs]);
      });

      it('answers a word a since-deleted agent group said in another workgroup exactly as a word held nowhere', async () => {
        await inWorkgroup('ag-voice', 'acme', 'Acme');
        await createAgentGroup({ id: 'ag-gone', name: 'Gone', folder: 'gone', agent_provider: null, created_at: NOW });
        await inWorkgroup('ag-gone', 'globex', 'Globex');
        const key = await pairedKey(person);
        await newSession({ thread_id: own });
        vi.useFakeTimers({ toFake: ['Date'] });
        await searchable();
        const before = await costOf(key, {}, 'absentword');

        await said('the zeppelin landed', { agent: 'ag-gone', threadId: own });
        await deleteAgentGroup('ag-gone');
        vi.setSystemTime(Date.now() + 15 * 60_000);
        await searchable();
        const held = await costOf(key, {}, 'zeppelin');
        const absent = await costOf(key, {}, 'absentword');

        expect(held).toEqual(absent);
        expect(absent.statements).toBe(before.statements);
        expect(held.walks).toBe(1);
        expect(parsed<{ threads: unknown[] }>({ body: held.body }).threads).toEqual([]);
      });

      it.each(['juniper', 'agent-group:ag-voice'])(
        'keeps an agent group of no workgroup apart from a workgroup with the id %s',
        async (workgroup) => {
          await inWorkgroup('ag-sibling', workgroup, 'Juniper Team');
          await memberOf('ag-sibling');
          const key = await pairedKey(person);
          const [loose, resident] = ['slack:C0TEST:8.0', 'slack:C0TEST:9.0'];
          const looseSession = await newSession({ thread_id: loose });
          const residentSession = await newSession({ agent_group_id: 'ag-sibling', thread_id: resident });
          await said('the zeppelin landed', { threadId: loose });
          await said('the airship landed', { agent: 'ag-sibling', threadId: resident });
          await searchable();

          const filtered = await listing(key, { workgroup, q: 'zeppelin' });

          expect(filtered.threads).toEqual([]);
          expect(H.walkedTenants).toEqual([`workgroup:${workgroup}`]);
          expect(sessionIds(await listThreads(key, { workgroup, q: 'airship' }))).toEqual([residentSession]);
          expect(sessionIds(await listThreads(key, { workgroup: '_agent-group:ag-voice', q: 'zeppelin' }))).toEqual([
            looseSession,
          ]);
          expect(filtered.workgroups).toEqual([
            { id: '_agent-group:ag-voice', name: 'juniper' },
            { id: workgroup, name: 'Juniper Team' },
          ]);
          await expect(
            getDb().run(
              'INSERT INTO workgroups (id, display_name, created_at) VALUES (?, ?, ?)',
              '_agent-group:ag-voice',
              'Impostor',
              NOW,
            ),
          ).rejects.toThrow('CHECK constraint failed');
        },
      );

      it('answers every text alike, cut short and with no walk, until the boot migration has completed', async () => {
        const key = await pairedKey(person);
        await newSession({ thread_id: own });
        await said('the zeppelin landed', { threadId: own });
        await searchable();
        const archive = new Database(path.join(ARCHIVE_DIR, 'archive.db'));
        archive.prepare(`UPDATE archive_search_state SET value = '0' WHERE key = 'partitions_ready'`).run();
        archive.close();

        const held = await costOf(key, {}, 'zeppelin');
        const stopWordsOnly = await costOf(key, {}, 'the');

        expect(held).toEqual(stopWordsOnly);
        expect(held.walks).toBe(0);
        expect(parsed({ body: held.body })).toMatchObject({ threads: [], textCutShort: true });
      });

      describe('in Discord threads', () => {
        const discordPerson = async (id: string, member = 'ag-voice') => {
          await createUser({ id, kind: 'discord', display_name: 'Someone Else', created_at: NOW });
          await addMember({ user_id: id, agent_group_id: member, added_by: null, added_at: NOW });
          H.visible.add(id);
          return pairedKey(id);
        };
        const inThread = (thread: string, agent = 'ag-voice') => ({
          agent,
          channelType: 'discord',
          platformId: 'discord:111:222',
          threadId: `discord:111:222:${thread}`,
        });
        const threadSession = (
          thread: string,
          agent = 'ag-voice',
          messagingGroup = 'mg-discord',
          last_active?: string,
        ) =>
          newSession({
            agent_group_id: agent,
            messaging_group_id: messagingGroup,
            thread_id: `discord:111:222:${thread}`,
            ...(last_active ? { last_active } : {}),
          });

        beforeEach(() => channel('mg-discord', 'discord:111:222', 'discord', 'general'));

        it('answers a word held only in a private thread the person is not in as a word held nowhere, and finds a public thread’s words through its channel', async () => {
          const key = await discordPerson('discord:1234567890');
          const open = await threadSession('1001');
          await threadSession('1002');
          H.privateThreads.add('1002');
          H.hiddenChannels.add('1002');
          await said('the zeppelin landed', inThread('1002'));
          await said('the airship landed', inThread('1001'));
          await searchable();

          const held = await costOf(key, {}, 'zeppelin');
          const absent = await costOf(key, {}, 'absentword');

          expect(held).toEqual(absent);
          expect(held.walks).toBe(1);
          expect(parsed<{ threads: unknown[] }>({ body: held.body }).threads).toEqual([]);
          expect(sessionIds(await listThreads(key, { q: 'airship' }))).toEqual([open]);
        });

        it('reads each thread’s kind once, and checks each person in a private thread once a refresh, on shared reads', async () => {
          const [first, second] = ['discord:2234567801', 'discord:2234567802'];
          const firstKey = await discordPerson(first);
          const secondKey = await discordPerson(second);
          await threadSession('1101');
          const privateOne = await threadSession('1102');
          H.privateThreads.add('1102');
          H.outOfThread.add(`1102 ${second}`);
          await said('the zeppelin landed', inThread('1102'));
          vi.useFakeTimers({ toFake: ['Date'] });

          await searchable();
          vi.setSystemTime(Date.now() + 15 * 60_000);
          await searchable();

          const checks = H.threadChecks.filter((check) => check.threadId === '1102');
          expect(H.kindReads.sort()).toEqual(['1101', '1102']);
          expect(H.threadChecks.filter((check) => check.threadId === '1101')).toEqual([]);
          expect(checks.map((check) => check.userIds)).toEqual([[first], [second], [first], [second]]);
          expect(checks[0]!.reads).toBe(checks[1]!.reads);
          expect(checks[2]!.reads).toBe(checks[3]!.reads);
          expect(checks[0]!.reads).not.toBe(checks[2]!.reads);
          expect(sessionIds(await listThreads(firstKey, { q: 'zeppelin' }))).toEqual([privateOne]);
          expect(sessionIds(await listThreads(secondKey, { q: 'zeppelin' }))).toEqual([]);
        });

        it('finds a thread a quiet callable session holds while an agent the person cannot call keeps it recent', async () => {
          await shareWorkgroup();
          const key = await discordPerson('discord:3234567890');
          const quietOne = await threadSession('1201', 'ag-voice', 'mg-discord', ago(100 * DAY_MS));
          await threadSession('1201', 'ag-quiet');
          await said('the zeppelin landed', inThread('1201', 'ag-quiet'));
          await searchable();

          expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([quietOne]);
        });

        it('leaves out a thread whose kind no bot can read, and asks again at the next refresh', async () => {
          const key = await discordPerson('discord:5234567890');
          await threadSession('1401');
          H.threadBlindBots.add('discord');
          await said('the zeppelin landed', inThread('1401'));
          vi.useFakeTimers({ toFake: ['Date'] });
          await searchable();

          const held = await costOf(key, {}, 'zeppelin');
          const absent = await costOf(key, {}, 'absentword');
          vi.setSystemTime(Date.now() + 15 * 60_000);
          await searchable();

          expect(H.kindReads).toEqual(['1401', '1401']);
          expect(held).toEqual(absent);
          expect(parsed<{ threads: unknown[] }>({ body: held.body }).threads).toEqual([]);
        });

        it.each([0, 1])(
          'keeps a private thread searchable for everyone else when person %i’s membership check fails',
          async (failing) => {
            const people = [`discord:22345678${failing}1`, `discord:22345678${failing}2`];
            const keys = [await discordPerson(people[0]!), await discordPerson(people[1]!)];
            const privateOne = await threadSession('1501');
            H.privateThreads.add('1501');
            H.memberCheckFails.add(people[failing]!);
            await said('the zeppelin landed', inThread('1501'));
            await searchable();

            expect(sessionIds(await listThreads(keys[1 - failing]!, { q: 'zeppelin' }))).toEqual([privateOne]);
            expect(sessionIds(await listThreads(keys[failing]!, { q: 'zeppelin' }))).toEqual([]);
          },
        );

        /** A private thread both sibling bots hold, with each of `ids` able to call either bot's agent. */
        async function onSiblingBots(thread: string, ids: string[]) {
          await shareWorkgroup();
          await createMessagingGroup({
            id: 'mg-discord-codex',
            channel_type: 'discord-codex',
            platform_id: 'discord:111:222',
            name: 'general',
            is_group: 1,
            unknown_sender_policy: 'strict',
            created_at: NOW,
          });
          const keys: string[] = [];
          for (const id of ids) {
            keys.push(await discordPerson(id, 'ag-voice'));
            await addMember({ user_id: id, agent_group_id: 'ag-sibling', added_by: null, added_at: NOW });
          }
          const first = await threadSession(thread);
          const reachable = await threadSession(thread, 'ag-sibling', 'mg-discord-codex');
          H.privateThreads.add(thread);
          await said('the zeppelin landed', inThread(thread));
          return { keys, first, reachable };
        }

        it('checks a private thread through each sibling bot in turn until one can read it', async () => {
          const {
            keys: [key],
            reachable,
          } = await onSiblingBots('1301', ['discord:4234567890']);
          H.threadBlindBots.add('discord');
          await searchable();

          expect(H.kindReads).toEqual(['1301', '1301']);
          expect(sessionIds(await listThreads(key!, { q: 'zeppelin' }))).toContain(reachable);
        });

        it.each(['discord', 'discord-codex'])(
          'checks a channel and its private thread through the other bot when %s cannot read either',
          async (failing) => {
            const {
              keys: [key],
              first,
              reachable,
            } = await onSiblingBots('1701', [`discord:42345678${failing.length}1`]);
            H.failingBots.add(failing);
            await searchable();

            expect(sessionIds(await listThreads(key!, { q: 'zeppelin' }))).toEqual([
              failing === 'discord' ? reachable : first,
            ]);
          },
        );

        it('moves everyone on to the sibling bot when one bot’s checks in a private thread all fail', async () => {
          const { keys, reachable } = await onSiblingBots('1601', ['discord:4234567801', 'discord:4234567802']);
          H.threadCheckFailsOn.add('discord');
          await searchable();

          for (const key of keys) expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toContain(reachable);
        });
      });

      it('refreshes everyone else when one person’s refresh fails', async () => {
        const failing = 'discord:2234567890';
        await createUser({ id: failing, kind: 'discord', display_name: 'Someone Else', created_at: NOW });
        await addMember({ user_id: failing, agent_group_id: 'ag-voice', added_by: null, added_at: NOW });
        await pairedKey(failing);
        const key = await pairedKey(person);
        const id = await newSession({ thread_id: own });
        await said('the zeppelin landed', { threadId: own });
        const db = getDb();
        const all = db.all.bind(db);
        const spy = vi.spyOn(db, 'all').mockImplementation(async (sql: string, ...params: unknown[]) => {
          if (params.includes('2234567890')) throw new Error('central read failed');
          return all(sql, ...params);
        });
        try {
          await searchable();
        } finally {
          spy.mockRestore();
        }

        expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([id]);
        expect(vi.mocked(log.warn)).toHaveBeenCalledWith('Mobile: channel visibility refresh failed for one person', {
          err: expect.any(Error),
        });
      });

      it('searches no text on a check two refreshes old, while the refresh that would replace it hangs', async () => {
        const key = await pairedKey(person);
        const id = await newSession({ thread_id: own });
        await said('the zeppelin landed', { threadId: own });
        vi.useFakeTimers({ toFake: ['Date'] });
        await searchable();
        expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([id]);

        let release!: () => void;
        const hung = new Promise<void>((resolve) => (release = resolve));
        H.seeGate = () => hung;
        vi.setSystemTime(Date.now() + 30 * 60_000);
        const refresh = startChannelVisibilityRefresh();
        const overdue = await costOf(key, {}, 'zeppelin');

        expect(parsed({ body: overdue.body })).toMatchObject({ threads: [], textCutShort: true });
        expect(overdue.walks).toBe(0);
        release();
        await refresh;
        expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([id]);
      });

      it('finds a word in a checked channel of their own workgroup that has been quiet for over a week', async () => {
        await inWorkgroup('ag-voice', 'acme', 'Acme');
        await channel('mg-quiet', 'slack:C0QUIET', 'slack', 'quiet');
        const key = await pairedKey(person);
        await newSession();
        const quiet = await newSession({
          messaging_group_id: 'mg-quiet',
          thread_id: 'slack:C0QUIET:1.0',
          last_active: ago(8 * DAY_MS),
        });
        await said('the zeppelin landed', { platformId: 'slack:C0QUIET', threadId: 'slack:C0QUIET:1.0' });
        await searchable();

        expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([quiet]);
      });

      it('finds a workgroup’s message through any of its agents, in a channel the person can see', async () => {
        await inWorkgroup('ag-voice', 'acme', 'Acme');
        await inWorkgroup('ag-quiet', 'acme', 'Acme');
        const key = await pairedKey(person);
        const thread = 'slack:C0TEST:8.0';
        const id = await newSession({ thread_id: thread });
        await newSession({ agent_group_id: 'ag-quiet', thread_id: thread });
        await said('the zeppelin landed', { agent: 'ag-quiet', threadId: thread });
        await searchable();

        expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([id]);
      });

      it('reads no channel before its scheduled check, and a hit after it starts no check of its own', async () => {
        const key = await pairedKey(person);
        const id = await newSession({ thread_id: own });
        await said('the zeppelin landed', { threadId: own });

        const before = await costOf(key, {}, 'zeppelin');
        expect(parsed<{ threads: unknown[] }>({ body: before.body }).threads).toEqual([]);
        expect(before.walks).toBe(0);
        expect(before.checks).toBe(0);

        await startChannelVisibilityRefresh();
        const checks = H.seeCalls;

        expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([id]);
        expect(H.seeCalls).toBe(checks);
      });

      it('checks every paired person’s channels once per refresh, and again only fifteen minutes on', async () => {
        await pairedKey(person);
        await newSession();
        vi.useFakeTimers({ toFake: ['Date'] });

        await startChannelVisibilityRefresh();
        const first = H.seeCalls;
        await startChannelVisibilityRefresh();
        expect(H.seeCalls).toBe(first);

        vi.setSystemTime(Date.now() + 15 * 60_000);
        await startChannelVisibilityRefresh();
        expect(H.seeCalls).toBe(first * 2);
      });

      it('stops searching a channel the person has left, at the next refresh', async () => {
        const key = await pairedKey(person);
        const id = await newSession({ thread_id: own });
        await said('the zeppelin landed', { threadId: own });
        vi.useFakeTimers({ toFake: ['Date'] });
        await searchable();
        expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([id]);

        H.hiddenChannels.add('C0TEST');
        vi.setSystemTime(Date.now() + 15 * 60_000);
        await startChannelVisibilityRefresh();

        const after = await costOf(key, {}, 'zeppelin');
        expect(parsed<{ threads: ThreadRow[] }>(after).threads).toEqual([]);
        expect(after.walks).toBe(0);
      });
    });

    describe('of message text', () => {
      const own = 'slack:C0TEST:7.0';

      it('finds a thread by a word only its messages hold, and the answer says nothing about the match', async () => {
        const key = await pairedKey(person);
        await bystander();
        const id = await newSession({ thread_id: own });
        await said('the zeppelin branches landed at noon', { threadId: own });

        await searchable();
        const res = await send('GET', '/v1/threads?q=zeppelin', { key });

        const { threads } = parsed<{ threads: ThreadRow[] }>(res);
        expect(sessionIds(threads)).toEqual([id]);
        expect(Object.keys(parsed(res)).sort()).toEqual(['channels', 'threads', 'workgroups']);
        expect(Object.keys(threads[0]).sort()).toEqual(
          [
            'agents',
            'call',
            'channelKey',
            'channelName',
            'lastActiveAt',
            'platform',
            'threadKey',
            'title',
            'workgroupId',
            'workgroupName',
          ].sort(),
        );
        expect(res.body).not.toContain('landed at noon');
        expect(H.walks).toBe(1);
      });

      it.each<[string, string, boolean]>([
        ['the start of a longer word, in the last term', 'branch', true],
        ['the start of a longer word, in an earlier term', 'branch landed', false],
        ['two terms in one message', 'zeppelin landed', true],
        ['terms in two different messages', 'zeppelin harbour', false],
        ['fewer than three letters of a word', 'ze', false],
      ])('%s: %s', async (_name, q, found) => {
        const key = await pairedKey(person);
        const id = await newSession({ thread_id: own });
        await said('the zeppelin branches landed at noon', { threadId: own });
        await said('the harbour was quiet', { threadId: own });

        await searchable();
        expect(sessionIds(await listThreads(key, { q }))).toEqual(found ? [id] : []);
      });

      it('finds a word under All in every workgroup the person can call in', async () => {
        await memberOf('ag-sibling');
        await inWorkgroup('ag-voice', 'acme', 'Acme');
        await inWorkgroup('ag-sibling', 'globex', 'Globex');
        await channel('mg-other', 'slack:C0OTHER');
        const key = await pairedKey(person);
        const mine = await newSession({ thread_id: own });
        const theirs = await newSession({
          agent_group_id: 'ag-sibling',
          messaging_group_id: 'mg-other',
          thread_id: 'slack:C0OTHER:1.0',
        });
        await said('the zeppelin landed', { threadId: own });
        await said('the zeppelin landed', {
          agent: 'ag-sibling',
          platformId: 'slack:C0OTHER',
          threadId: 'slack:C0OTHER:1.0',
        });

        await searchable();
        expect(sessionIds(await listThreads(key, { q: 'zeppelin' })).sort()).toEqual([mine, theirs].sort());
      });

      it('finds a channel-level session by a message with no thread, of either stored shape', async () => {
        const key = await pairedKey(person);
        const id = await newSession({ thread_id: null });
        await said('the zeppelin landed', { threadId: null });
        await said('the harbour was quiet', { threadId: '' });

        await searchable();
        expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([id]);
        expect(sessionIds(await listThreads(key, { q: 'harbour' }))).toEqual([id]);
      });

      it('ranks text matches after title matches, newest first within each', async () => {
        const key = await pairedKey(person);
        const titleOld = await newSession({ last_active: ago(5 * 60_000) });
        const textNew = await newSession({ last_active: ago(60_000), thread_id: 'slack:C0TEST:8.0' });
        const textOld = await newSession({ last_active: ago(3 * 60_000), thread_id: 'slack:C0TEST:9.0' });
        await setTitle(titleOld, 'Zeppelin notes', NOW);
        await said('the zeppelin landed', { threadId: 'slack:C0TEST:9.0' });
        await said('the zeppelin left', { threadId: 'slack:C0TEST:8.0' });

        await searchable();
        expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([titleOld, textNew, textOld]);
      });

      it('ranks text matches by age alone, whatever titles they carry', async () => {
        const key = await pairedKey(person);
        const titledOld = await newSession({ last_active: ago(5 * 60_000), thread_id: 'slack:C0TEST:8.0' });
        await setTitle(titledOld, 'Quarterly notes', NOW);
        await setThreadTitle('slack:C0TEST:8.0', 'Named thread');
        const plainNew = await newSession({ last_active: ago(60_000), thread_id: 'slack:C0TEST:9.0' });
        await said('the zeppelin landed', { threadId: 'slack:C0TEST:8.0' });
        await said('the zeppelin left', { threadId: 'slack:C0TEST:9.0' });

        await searchable();
        expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([plainNew, titledOld]);
      });

      it('does not find a live thread by a message older than the window', async () => {
        const key = await pairedKey(person);
        await newSession({ thread_id: own });
        await said('the zeppelin landed', { threadId: own, sentAt: '2020-01-01T00:00:00.000Z' });

        await searchable();
        expect(await listThreads(key, { q: 'zeppelin' })).toEqual([]);
      });

      it('finds a thread when the word sits in an agent’s reply, and not in a system row', async () => {
        const key = await pairedKey(person);
        const id = await newSession({ thread_id: own });
        await said('the zeppelin landed', { threadId: own, role: 'assistant' });
        await said('the harbour was quiet', { threadId: own, role: 'system' });

        await searchable();
        expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([id]);
        expect(await listThreads(key, { q: 'harbour' })).toEqual([]);
      });

      it('skips the walk when nothing in the text can be searched', async () => {
        const key = await pairedKey(person);
        await newSession();

        await searchable();
        for (const q of ['the', 'a', 's-s-s-s', 's_s_s_s', 's.s.s.s', 's/s/s/s', "s's's's", 's:s:s:s']) {
          await listThreads(key, { q });
        }

        expect(H.walks).toBe(0);
      });

      it('does not count a thread with no live session in the window', async () => {
        const key = await pairedKey(person);
        await newSession({ thread_id: own, last_active: ago(91 * DAY_MS) });
        await said('the zeppelin landed', { threadId: own });

        await searchable();
        expect(await listThreads(key, { q: 'zeppelin' })).toEqual([]);
      });

      describe('never surfaces a thread the person cannot see', () => {
        const elsewhere = 'slack:C0OTHER:1.0';

        /** Each row beside a thread of the person's own that holds the same word, so a miss proves the access path. */
        it.each<[string, () => Promise<unknown>]>([
          [
            'a separate employer’s workgroup in a Slack workspace of its own, with a membership there',
            async () => {
              await memberOf('ag-sibling');
              await inWorkgroup('ag-sibling', 'northwind', 'Northwind Bank');
              await channel('mg-foreign', 'slack:C0FOR', 'slack-foreign');
              const thread = 'slack:C0FOR:1.0';
              await newSession({ agent_group_id: 'ag-sibling', messaging_group_id: 'mg-foreign', thread_id: thread });
              await said('the zeppelin landed', {
                agent: 'ag-sibling',
                channelType: 'slack-foreign',
                platformId: 'slack:C0FOR',
                threadId: thread,
              });
            },
          ],
          [
            'a private channel of the person’s own agent they are not in',
            async () => {
              await channel('mg-other', 'slack:C0OTHER');
              H.hiddenChannels.add('C0OTHER');
              await newSession({ messaging_group_id: 'mg-other', thread_id: elsewhere });
              await said('the zeppelin landed', { platformId: 'slack:C0OTHER', threadId: elsewhere });
            },
          ],
          [
            'an agent not enabled for calls',
            async () => {
              await memberOf('ag-quiet');
              await channel('mg-other', 'slack:C0OTHER');
              await newSession({ agent_group_id: 'ag-quiet', messaging_group_id: 'mg-other', thread_id: elsewhere });
              await said('the zeppelin landed', {
                agent: 'ag-quiet',
                platformId: 'slack:C0OTHER',
                threadId: elsewhere,
              });
            },
          ],
          [
            'a channel the agent has been unwired from',
            async () => {
              await memberOf('ag-sibling');
              await channel('mg-other', 'slack:C0OTHER');
              await wire('mg-other', 'ag-sibling');
              await newSession({ agent_group_id: 'ag-sibling', messaging_group_id: 'mg-other', thread_id: elsewhere });
              await said('the zeppelin landed', {
                agent: 'ag-sibling',
                platformId: 'slack:C0OTHER',
                threadId: elsewhere,
              });
              await getDb().run(`DELETE FROM messaging_group_agents WHERE messaging_group_id = 'mg-other'`);
            },
          ],
          [
            'a closed session',
            async () => {
              await newSession({ thread_id: 'slack:C0TEST:8.0', status: 'closed' });
              await said('the zeppelin landed', { threadId: 'slack:C0TEST:8.0' });
            },
          ],
          [
            'a DM recorded as nobody’s',
            async () => {
              await channel('mg-dm', 'slack:D0DM');
              await newSession({ messaging_group_id: 'mg-dm', thread_id: null });
              await said('the zeppelin landed', { platformId: 'slack:D0DM', threadId: null });
            },
          ],
        ])('%s', async (_name, arrange) => {
          const key = await pairedKey(person);
          await arrange();
          const mine = await newSession({ thread_id: own });
          await said('the zeppelin left', { threadId: own });

          await searchable();
          const res = await send('GET', '/v1/threads?q=zeppelin', { key });

          expect(sessionIds(parsed<{ threads: ThreadRow[] }>(res).threads)).toEqual([mine]);
        });

        it('leaves a thread out when a workgroup the person cannot call in is asked for', async () => {
          await inWorkgroup('ag-quiet', 'globex', 'Globex');
          const key = await pairedKey(person);
          await newSession({ agent_group_id: 'ag-quiet', thread_id: own });
          await said('the zeppelin landed', { agent: 'ag-quiet', threadId: own });

          await searchable();
          expect(await listThreads(key, { workgroup: 'globex', q: 'zeppelin' })).toEqual([]);
        });
      });

      describe('with search syntax in the text', () => {
        const FIRST = 'slack:C0TEST:7.0';
        const SECOND_THREAD = 'slack:C0TEST:8.0';

        /** Two threads whose words never share a message, so anything that ORs the terms lists both. */
        async function twoThreads(): Promise<{ key: string; first: string; second: string }> {
          const key = await pairedKey(person);
          const first = await newSession({ thread_id: FIRST, last_active: ago(60_000) });
          const second = await newSession({ thread_id: SECOND_THREAD, last_active: ago(120_000) });
          await said('zeppelin harbour', { threadId: FIRST, senderName: 'Quincy Example' });
          await said('walrus quarry', { threadId: SECOND_THREAD, senderName: 'Quincy Example' });
          return { key, first, second };
        }

        it.each<[string, 'first' | 'none']>([
          ['"', 'none'],
          ['""', 'none'],
          ['"zeppelin', 'first'],
          ['zeppelin"', 'first'],
          ['"zeppelin" "walrus"', 'none'],
          ['*', 'none'],
          ['zep*', 'first'],
          ['z*', 'none'],
          ['^zeppelin', 'first'],
          ['(zeppelin', 'first'],
          ['zeppelin)', 'first'],
          ['+zeppelin', 'first'],
          ['-zeppelin', 'first'],
          ['--', 'none'],
          ['-_-', 'none'],
          ["'", 'none'],
          ['zeppelin\u0000', 'first'],
          ['zeppelin OR walrus', 'none'],
          ['zeppelin AND walrus', 'none'],
          ['zeppelin NOT walrus', 'none'],
          ['NOT walrus', 'none'],
          ['NEAR(zeppelin walrus)', 'none'],
          ['NEAR(zeppelin walrus, 100)', 'none'],
          ['zeppelin NEAR walrus', 'none'],
          ['text:zeppelin', 'none'],
          ['text : walrus', 'none'],
          ['{text}:zeppelin', 'none'],
          ['{text sender_name}:quincy', 'none'],
          ['sender_name:quincy', 'none'],
          ['quincy', 'none'],
          ['- text : zeppelin', 'none'],
        ])('takes %j as words, so it neither fails nor widens', async (q, expected) => {
          const { key, first } = await twoThreads();

          await searchable();
          const res = await send('GET', `/v1/threads?${new URLSearchParams({ q })}`, { key });

          expect(res.status).toBe(200);
          expect(sessionIds(parsed<{ threads: ThreadRow[] }>(res).threads)).toEqual(
            expected === 'first' ? [first] : [],
          );
          expect(vi.mocked(log.warn).mock.calls.flat()).not.toContain('Mobile: text search failed');
        });
      });

      describe('when the walk does not finish', () => {
        const hang = () => {
          H.walkInstead = () => undefined;
        };

        it('answers with the title matches at the limit, says so, and stops the worker', async () => {
          const key = await pairedKey(person);
          const titled = await newSession();
          await setTitle(titled, 'Zeppelin notes', NOW);
          hang();

          await searchable();
          const startedAt = Date.now();
          const list = await listing(key, { q: 'zeppelin' });

          expect(Date.now() - startedAt).toBeGreaterThanOrEqual(1_400);
          expect(sessionIds(list.threads)).toEqual([titled]);
          expect(list.textCutShort).toBe(true);
          expect(H.walkTerminated).toBe(1);
        });

        it('keeps what the walk had found by the limit', async () => {
          const key = await pairedKey(person);
          const id = await newSession({ thread_id: own });
          H.walkInstead = (worker) =>
            worker.emit('message', { found: [{ workgroupId: '_agent-group:ag-voice', threadRef: own }] });

          await searchable();
          const list = await listing(key, { q: 'zeppelin' });

          expect(sessionIds(list.threads)).toEqual([id]);
          expect(list.textCutShort).toBe(true);
        });

        it('answers at once with no walk when too many are running, and walks again once they stop', async () => {
          const key = await pairedKey(person);
          const id = await newSession({ thread_id: own });
          await said('the zeppelin landed', { threadId: own });
          hang();
          await searchable();
          const running = [1, 2, 3, 4].map(() => listing(key, { q: 'zeppelin' }));
          while (H.walks < 4) await new Promise((resolve) => setImmediate(resolve));

          const over = await listing(key, { q: 'zeppelin' });

          expect(over.textCutShort).toBe(true);
          expect(H.walkTerminated).toBe(0);
          await Promise.all(running);
          expect(H.walks).toBe(4);
          H.walkInstead = null;
          expect(sessionIds(await listThreads(key, { q: 'zeppelin' }))).toEqual([id]);
        });

        it('skips the walk past 60 a minute for a device, and answers with the title matches', async () => {
          const key = await pairedKey(person);
          const titled = await newSession();
          await setTitle(titled, 'Zeppelin notes', NOW);
          vi.useFakeTimers({ toFake: ['Date'] });
          await searchable();
          for (let i = 0; i < 60; i += 1) expect((await listing(key, { q: 'zeppelin' })).textCutShort).toBeUndefined();

          const res = await send('GET', '/v1/threads?q=zeppelin', { key });

          expect(res.status).toBe(200);
          const list = parsed<{ threads: ThreadRow[]; textCutShort?: boolean }>(res);
          expect(sessionIds(list.threads)).toEqual([titled]);
          expect(list.textCutShort).toBe(true);
          expect(H.walks).toBe(60);

          vi.setSystemTime(Date.now() + 60_001);
          expect((await listing(key, { q: 'zeppelin' })).textCutShort).toBeUndefined();
          expect(H.walks).toBe(61);
        });

        it('counts that limit per device, and only for a list that walks', async () => {
          const [busy, other] = [await pairedKey(person), await pairedKey(person)];
          await newSession();
          await searchable();
          for (let i = 0; i < 70; i += 1) await listThreads(busy, { q: 'the' });
          expect(H.walks).toBe(0);
          for (let i = 0; i < 61; i += 1) await listThreads(busy, { q: 'zeppelin' });
          expect(H.walks).toBe(60);

          expect((await listing(other, { q: 'zeppelin' })).textCutShort).toBeUndefined();
          expect(H.walks).toBe(61);
        });

        it('treats a walk that dies as cut short and keeps the error out of the log', async () => {
          const key = await pairedKey(person);
          const titled = await newSession();
          await setTitle(titled, 'Zeppelin notes', NOW);
          H.walkInstead = (worker) => {
            worker.emit(
              'error',
              Object.assign(new Error('fts5: syntax error near "zeppelin"'), { code: 'SQLITE_ERROR' }),
            );
            worker.emit('exit', 1);
          };

          await searchable();
          const list = await listing(key, { q: 'zeppelin' });

          expect(sessionIds(list.threads)).toEqual([titled]);
          expect(list.textCutShort).toBe(true);
          expect(vi.mocked(log.warn)).toHaveBeenCalledWith('Mobile: text search failed', { code: 'SQLITE_ERROR' });
          expect(loggedText()).not.toContain('zeppelin');
        });

        it('sends the text only as the match, and logs it on no path', async () => {
          const key = await pairedKey(person);
          await newSession({ thread_id: own });
          await said('the zeppelin landed', { threadId: own });
          await searchable();
          await listThreads(key, { q: 'zeppelin' });
          hang();
          await listThreads(key, { q: 'zeppelin' });
          H.walkInstead = (worker) => worker.emit('error', new Error('zeppelin'));
          await listThreads(key, { q: 'zeppelin' });

          expect(vi.mocked(log.warn).mock.calls.length).toBeGreaterThan(0);
          expect(loggedText()).not.toContain('zeppelin');
        });
      });
    });

    it('keeps the text out of every log line, when the list fails and when a check does', async () => {
      const key = await pairedKey(person);
      const q = 'a-very-private-search-term';
      await setTitle(await newSession(), q, NOW);
      H.seeFails = true;
      await listThreads(key, { q });
      await getDb().run('DROP TABLE thread_titles');
      const failed = await send('GET', `/v1/threads?q=${q}`, { key });

      expect(failed.status).toBe(500);
      expect(vi.mocked(log.warn).mock.calls.length).toBeGreaterThan(1);
      expect(loggedText()).not.toContain(q);
    });
  });
});

describe('per-device limits on requests that ask the platform', () => {
  it.each<[string, string, string, number]>([
    ['six calls', 'POST', '/v1/threads/nope/call', 6],
    ['thirty thread reads', 'GET', '/v1/threads/AAAAAAAAAAAAAAAAAAAAAA/messages', 30],
  ])(
    'answers 429 past %s a minute from one device, leaves other devices alone, and recovers',
    async (_n, method, path, max) => {
      const key = await pairedKey(person);
      const other = await pairedKey(await newPerson());
      vi.useFakeTimers({ toFake: ['Date'] });
      for (let request = 0; request < max; request += 1) expect((await send(method, path, { key })).status).toBe(404);

      const refused = await send(method, path, { key });
      expect(refused.status).toBe(429);
      expect(parsed(refused)).toEqual({ error: expect.stringContaining('Wait a minute') });
      expect((await send(method, path, { key: other })).status).toBe(404);

      vi.setSystemTime(Date.now() + 60_001);
      expect((await send(method, path, { key })).status).toBe(404);
    },
  );
});

describe('POST /v1/threads', () => {
  const place = { agentGroupId: 'ag-voice', messagingGroupId: CHANNEL };
  const open = (key: string, body: object = place) => send('POST', '/v1/threads', { key, body: JSON.stringify(body) });
  const threadOf = (index = 0) => `slack:C0TEST:${1700000000 + 2 * index + 1}.000100`;

  it('posts a thread in the host’s words and comes back with a link to a call in it', async () => {
    await wire(CHANNEL);
    const res = await open(await pairedKey(person));

    expect(res.status).toBe(200);
    expect(parsed(res)).toEqual({
      url: expect.stringMatching(/^https:\/\/[0-9a-f]{32}\.calls\.example$/),
      agentName: 'Juniper',
      joined: false,
      expiresAt: expect.any(String),
    });
    const who = nameOf(person);
    expect(H.platformPosts).toEqual([
      { platformId: 'slack:C0TEST', text: `📞 ${who} opened a call with Juniper. It continues in this thread.` },
      {
        platformId: 'slack:C0TEST',
        text: `${who} opened this thread for a call with Juniper.`,
        title: 'Call with Juniper',
      },
    ]);
    expect(H.posts.filter((post) => post.threadId === threadOf())).toEqual([
      expect.objectContaining({ text: expect.stringContaining(`${who} started a call with Juniper`) }),
    ]);
    // Unstamped and uncounted: the first title must not wait out a cooldown or spend a rename nothing earned.
    expect(await getDb().get('SELECT title, title_source, titled_at, attempts FROM thread_titles')).toEqual({
      title: 'Call with Juniper',
      title_source: 'auto',
      titled_at: null,
      attempts: 0,
    });
  });

  it('stores the name as it was posted, so a long agent name never reads as a person’s rename', async () => {
    await wire(CHANNEL);
    await getDb().run('UPDATE agent_groups SET name = ? WHERE id = ?', 'J'.repeat(100), 'ag-voice');

    await open(await pairedKey(person));

    const posted = H.platformPosts.at(-1)!.title!;
    expect(posted).toHaveLength(80);
    expect(await getDb().get('SELECT title FROM thread_titles')).toEqual({ title: posted });
  });

  it('cannot ping a channel through a person’s display name', async () => {
    await wire(CHANNEL);
    const someone = await newPerson();
    await getDb().run('UPDATE users SET display_name = ? WHERE id = ?', '@everyone <!channel> <@&123>', someone);

    expect((await open(await pairedKey(someone))).status).toBe(200);

    const posted = [...H.platformPosts, ...H.posts].map((post) => post.text);
    expect(posted.filter((text) => text.includes('everyone'))).toHaveLength(3);
    for (const text of posted) expect(text).not.toMatch(/@everyone|<!channel>|<@&123>/);
  });

  it.each([
    ['threads turned off', { threads: 0 }, 1],
    ['agent-shared', { session_mode: 'agent-shared' }, 1],
    ['a shared wiring outside a group', { session_mode: 'shared' }, 0],
  ])('does not offer or open a channel where typed replies would miss the call: %s', async (_name, wiring, isGroup) => {
    await wire(CHANNEL);
    for (const [column, value] of Object.entries(wiring))
      await getDb().run(`UPDATE messaging_group_agents SET ${column} = ? WHERE messaging_group_id = ?`, value, CHANNEL);
    await getDb().run('UPDATE messaging_groups SET is_group = ? WHERE id = ?', isGroup, CHANNEL);
    const key = await pairedKey(person);

    expect(parsed(await send('GET', '/v1/places', { key }))).toEqual({ places: [] });
    const res = await open(key);
    expect(res.status).toBe(404);
    expect(parsed(res)).toEqual({ error: 'That channel is not available.' });
    expect(H.platformPosts).toEqual([]);
  });

  it('lets nothing the device sent reach a post', async () => {
    await wire(CHANNEL);
    const words = 'typed-on-the-device';
    const res = await open(await pairedKey(person), {
      ...place,
      title: words,
      text: words,
      brief: words,
      announcement: words,
      firstMessage: words,
      displayName: words,
    });

    expect(res.status).toBe(200);
    expect(JSON.stringify([H.platformPosts, H.posts])).not.toContain(words);
  });

  it('creates the thread’s session unprompted: no task, no message, no wake', async () => {
    await wire(CHANNEL);
    await open(await pairedKey(person));

    const rows = await getDb().all<{ id: string; messaging_group_id: string; thread_id: string; engaged_at: string }>(
      'SELECT id, messaging_group_id, thread_id, engaged_at FROM sessions WHERE thread_id = ?',
      threadOf(),
    );
    expect(rows).toEqual([
      { id: expect.any(String), messaging_group_id: CHANNEL, thread_id: threadOf(), engaged_at: expect.any(String) },
    ]);
    expect(vi.mocked(dispatch)).not.toHaveBeenCalled();
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
    expect(vi.mocked(requestWake)).not.toHaveBeenCalled();
  });

  it('keeps the thread its own session on a wiring that shares sessions across the channel', async () => {
    await wire(CHANNEL);
    await newSession({ thread_id: null });
    await getDb().run("UPDATE messaging_group_agents SET session_mode = 'shared'");
    await open(await pairedKey(person));
    expect(await getDb().get('SELECT 1 AS one FROM sessions WHERE thread_id = ?', threadOf())).toEqual({ one: 1 });
  });

  it('lands in the list under its fixed name, and a teammate joins from there', async () => {
    await wire(CHANNEL);
    await open(await pairedKey(person));

    const teammate = await newPerson();
    const teammateKey = await pairedKey(teammate);
    const [row] = await listThreads(teammateKey);
    expect(row).toMatchObject({
      title: 'Call with Juniper',
      channelName: '#general',
      lastActiveAt: expect.stringMatching(/Z$/),
      call: null,
    });
    const joined = await send('POST', `/v1/threads/${row.agents[0].sessionId}/call`, { key: teammateKey });
    expect([joined.status, parsed(joined).joined]).toEqual([200, true]);
  });

  it('gives way to a generated title once the sweep writes one to the thread’s row', async () => {
    await wire(CHANNEL);
    const key = await pairedKey(person);
    await open(key);
    const [row] = await listThreads(key);

    await setTitle(row.agents[0].sessionId, 'A session title only', new Date().toISOString());
    expect((await listThreads(key))[0].title).toBe('Call with Juniper');

    await recordThreadRename(threadOf(), 'Nightly export review');
    expect((await listThreads(key))[0].title).toBe('Nightly export review');
  });

  it('opens in the channel named by id when two workspaces both have a #general', async () => {
    await wire(CHANNEL);
    await channel('mg-general-2', 'slack:C0SECOND', 'slack', 'general');
    await wire('mg-general-2');
    await open(await pairedKey(person), { ...place, messagingGroupId: 'mg-general-2' });
    expect(H.platformPosts.map((post) => post.platformId)).toEqual(['slack:C0SECOND', 'slack:C0SECOND']);
  });

  describe('refuses before anything is posted', () => {
    const refused = { error: 'That channel is not available.' };
    const refusedUnposted = (res: { status: number; body: string }, status: number, body: object) => {
      expect([res.status, parsed(res)]).toEqual([status, body]);
      expect(H.platformPosts).toEqual([]);
      expect(H.posts.filter((post) => post.text.includes('started a call'))).toEqual([]);
    };

    it('a person removed from the agent, on the request right after the list showed it', async () => {
      await wire(CHANNEL);
      const key = await pairedKey(person);
      expect(parsed<{ places: unknown[] }>(await send('GET', '/v1/places', { key })).places).toHaveLength(1);

      await getDb().run('DELETE FROM agent_group_members WHERE user_id = ?', person);

      const res = await open(key);
      refusedUnposted(res, 404, refused);
    });

    it('a person whose user is gone, as unauthenticated', async () => {
      await wire(CHANNEL);
      const key = await pairedKey(person);
      await getDb().run('DELETE FROM agent_group_members WHERE user_id = ?', person);
      await getDb().run('DELETE FROM users WHERE id = ?', person);
      refusedUnposted(await open(key), 401, { error: 'This device is not paired.' });
    });

    it('a person the platform no longer shows the channel, whatever the list’s cache says', async () => {
      await wire(CHANNEL);
      const key = await pairedKey(person);
      await send('GET', '/v1/places', { key });
      H.visible.delete(person);
      expect(parsed<{ places: unknown[] }>(await send('GET', '/v1/places', { key })).places).toHaveLength(1);

      const res = await open(key);
      refusedUnposted(res, 404, refused);
    });

    it('a channel when the platform check fails', async () => {
      await wire(CHANNEL);
      H.seeFails = true;
      refusedUnposted(await open(await pairedKey(person)), 404, refused);
    });

    it('an agent not wired to that channel', async () => {
      const res = await open(await pairedKey(person));
      refusedUnposted(res, 404, refused);
    });

    it('a channel that does not exist, in the same words', async () => {
      const res = await open(await pairedKey(person), { ...place, messagingGroupId: 'mg-nothing' });
      refusedUnposted(res, 404, refused);
    });

    it('another workspace, even when the raw id is a member there', async () => {
      const bots = [
        ['slack', { userId: 'U-BOT-A', username: 'a', teamId: 'T-OURS-TEST' }],
        ['slack-foreign', { userId: 'U-BOT-C', username: 'c', teamId: 'T-OTHER-TEST' }],
      ] as const;
      for (const [channelType, identity] of bots) registerSlackBot(channelType, identity);
      try {
        const key = await pairedKey(person);
        const foreign = `slack-foreign:${person.slice('slack:'.length)}`;
        await createUser({ id: foreign, kind: 'slack', display_name: 'Same Raw Id', created_at: NOW });
        await memberOf('ag-voice', foreign);
        H.visible.add(foreign);
        await channel('mg-foreign', 'slack:C0FOR', 'slack-foreign', 'general');
        await wire('mg-foreign');

        const res = await open(key, { ...place, messagingGroupId: 'mg-foreign' });

        refusedUnposted(res, 404, refused);
      } finally {
        for (const [channelType, identity] of bots) unregisterSlackBot(channelType, identity);
      }
    });

    it('a DM', async () => {
      await channel('mg-dm', 'slack:D0DIRECT', 'slack', 'dm');
      await wire('mg-dm');
      const res = await open(await pairedKey(person), { ...place, messagingGroupId: 'mg-dm' });
      refusedUnposted(res, 404, refused);
    });

    it('an agent with voice calls off, with a sentence', async () => {
      await wire(CHANNEL, 'ag-quiet');
      await memberOf('ag-quiet');
      const res = await open(await pairedKey(person), { ...place, agentGroupId: 'ag-quiet' });
      refusedUnposted(res, 409, { error: 'Group calls are not enabled for this agent.' });
    });

    it('a host where group calls are not configured', async () => {
      await wire(CHANNEL);
      H.callsConfigured = false;
      const res = await open(await pairedKey(person));
      refusedUnposted(res, 409, { error: 'Group calls are not enabled for this agent.' });
    });

    it('a body that does not name both ids', async () => {
      const res = await open(await pairedKey(person), { agentGroupId: 'ag-voice' });
      refusedUnposted(res, 400, { error: 'That request could not be read.' });
    });
  });

  it('refuses a full host before posting, so no thread is stranded', async () => {
    const key = await pairedKey(person);
    await send('POST', `/v1/threads/${await newSession()}/call`, { key });
    await send('POST', `/v1/threads/${await newSession()}/call`, { key });

    const res = await open(key);

    expect([res.status, parsed(res)]).toEqual([
      409,
      { error: 'Too many group calls are live on this host right now.' },
    ]);
    expect(H.platformPosts).toEqual([]);
  });

  it.each<[string, () => void, number, RegExp]>([
    ['the parent post fails', () => (H.postFails = true), 503, /could not be posted/],
    ['the thread cannot be created', () => (H.threadFails = true), 503, /could not be posted/],
    ['the channel cannot open threads', () => H.noThreadsOn.add('slack'), 409, /cannot open threads/],
  ])('answers with a sentence and makes no session when %s', async (_name, breakIt, status, sentence) => {
    await wire(CHANNEL);
    const key = await pairedKey(person);
    breakIt();
    const res = await open(key);
    expect([res.status, parsed<{ error: string }>(res).error]).toEqual([status, expect.stringMatching(sentence)]);
    expect(await getDb().all('SELECT id FROM sessions WHERE thread_id LIKE ?', 'slack:C0TEST:17%')).toEqual([]);
  });

  describe('when the call fails after the thread was posted', () => {
    it('says the thread stays, logs what is left, and leaves it findable when the host filled up meanwhile', async () => {
      await wire(CHANNEL);
      const key = await pairedKey(person);
      const [first, second] = [await newSession(), await newSession()];
      let filled = false;
      H.seeGate = async () => {
        if (H.platformPosts.length === 2 && !filled) {
          filled = true;
          await send('POST', `/v1/threads/${first}/call`, { key });
          await send('POST', `/v1/threads/${second}/call`, { key });
        }
      };

      const res = await open(key);

      expect(res.status).toBe(409);
      expect(parsed(res)).toEqual({
        error:
          'The thread stays in the channel, but the call did not start. Too many group calls are live on this host right now.',
      });
      expect(H.platformPosts).toHaveLength(2);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        'Mobile: a new thread was posted but its call did not start',
        expect.objectContaining({ agentGroupId: 'ag-voice', messagingGroupId: CHANNEL, threadId: threadOf() }),
      );
      expect((await listThreads(key)).map((thread) => thread.title)).toContain('Call with Juniper');
    });

    it('says the same, without a refusal to quote, when the session could not be made', async () => {
      await wire(CHANNEL);
      const key = await pairedKey(person);
      H.sessionFails = true;

      const res = await open(key);

      expect([res.status, parsed(res)]).toEqual([
        503,
        { error: 'The thread stays in the channel, but the call did not start.' },
      ]);
      expect(H.platformPosts).toHaveLength(2);
      expect(vi.mocked(log.warn)).toHaveBeenCalledWith(
        'Mobile: a new thread was posted but its call did not start',
        expect.objectContaining({ threadId: threadOf(), err: expect.any(Error) }),
      );
    });
  });
});

describe('POST /v1/threads limit', () => {
  const place = JSON.stringify({ agentGroupId: 'ag-voice', messagingGroupId: CHANNEL });
  const open = (key: string) => send('POST', '/v1/threads', { key, body: place });
  const endCalls = async () => {
    for (const shutdown of getHostShutdownCallbacks()) await shutdown();
  };

  it('allows one new thread a minute per device, in the usual error shape, and recovers', async () => {
    await wire(CHANNEL);
    const key = await pairedKey(person);
    const other = await pairedKey(await newPerson());
    vi.useFakeTimers({ toFake: ['Date'] });
    expect((await open(key)).status).toBe(200);
    await endCalls();

    const refused = await open(key);
    expect([refused.status, parsed(refused)]).toEqual([
      429,
      { error: 'You opened a new thread recently. Wait a little and try again.' },
    ]);
    expect(H.platformPosts).toHaveLength(2);
    expect((await open(other)).status).toBe(200);
    await endCalls();

    vi.setSystemTime(Date.now() + 60_001);
    expect((await open(key)).status).toBe(200);
  });

  it('allows twenty a day per device, and recovers a day after the first', async () => {
    await wire(CHANNEL);
    const key = await pairedKey(person);
    vi.useFakeTimers({ toFake: ['Date'] });
    const start = Date.now();
    for (let thread = 0; thread < 20; thread += 1) {
      vi.setSystemTime(start + thread * 60_001);
      expect((await open(key)).status).toBe(200);
      await endCalls();
    }

    vi.setSystemTime(start + 20 * 60_001);
    expect((await open(key)).status).toBe(429);

    vi.setSystemTime(start + 24 * 60 * 60_000 + 1);
    expect((await open(key)).status).toBe(200);
  });

  it('spends nothing on a refusal, so a stale picker row costs no wait', async () => {
    await wire(CHANNEL);
    const key = await pairedKey(person);
    const stale = await send('POST', '/v1/threads', {
      key,
      body: JSON.stringify({ agentGroupId: 'ag-voice', messagingGroupId: 'mg-nothing' }),
    });
    expect(stale.status).toBe(404);
    expect((await open(key)).status).toBe(200);
  });

  it('lets one of two requests at once through', async () => {
    await wire(CHANNEL);
    const key = await pairedKey(person);
    const answers = await Promise.all([open(key), open(key)]);
    expect(answers.map((res) => res.status).sort()).toEqual([200, 429]);
    expect(H.platformPosts).toHaveLength(2);
  });

  it('shares the six-a-minute call limit, so refusals cannot page the platform without end', async () => {
    const key = await pairedKey(person);
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let request = 0; request < 6; request += 1) expect((await open(key)).status).toBe(404);
    const seen = H.seeCalls;
    expect((await open(key)).status).toBe(429);
    expect(H.seeCalls).toBe(seen);
  });
});

describe('GET /v1/places', () => {
  const placesFor = async (key: string) =>
    parsed<{ places: Array<Record<string, unknown>> }>(await send('GET', '/v1/places', { key })).places;

  it('names each agent and channel the person can call, in the contract’s shape', async () => {
    await wire(CHANNEL);
    await shareWorkgroup();
    expect(await placesFor(await pairedKey(person))).toEqual([
      {
        channelKey: expect.stringMatching(/^[\w-]{22}$/),
        agentGroupId: 'ag-voice',
        agentName: 'Juniper',
        avatarUrl: null,
        messagingGroupId: CHANNEL,
        platform: 'slack',
        channelName: '#general',
        workgroupName: 'Acme',
        lastActiveAt: null,
      },
    ]);
  });

  it('lists most recently active first, with a channel never used last', async () => {
    await channel('mg-a-quiet', 'slack:C0QUIET', 'slack', 'quiet');
    await channel('mg-z-busy', 'slack:C0BUSY', 'slack', 'busy');
    await wire('mg-a-quiet');
    await newSession({ last_active: ago(DAY_MS) });
    await newSession({ messaging_group_id: 'mg-z-busy', last_active: ago(1000) });
    await newSession({ messaging_group_id: 'mg-z-busy', last_active: ago(2 * DAY_MS), status: 'closed' });

    const places = await placesFor(await pairedKey(person));

    expect(places.map((place) => place.channelName)).toEqual(['#busy', '#general', '#quiet']);
    expect(places[2].lastActiveAt).toBeNull();
  });

  it('gives sibling bots in one channel one key and each its own bot’s picture, and two workgroups in it two', async () => {
    const bots = [
      ['slack', { userId: 'U-BOT-A', username: 'a', teamId: 'T-OURS-TEST', imageUrl: PICTURE }],
      ['slack-sibling', { userId: 'U-BOT-B', username: 'b', teamId: 'T-OURS-TEST' }],
    ] as const;
    for (const [channelType, identity] of bots) registerSlackBot(channelType, identity);
    try {
      await channel('mg-sibling', 'slack:C0TEST', 'slack-sibling', 'general');
      await wire(CHANNEL);
      await wire('mg-sibling', 'ag-sibling');
      await memberOf('ag-sibling');
      const key = await pairedKey(person);
      await shareWorkgroup();
      const shared = await placesFor(key);
      expect(shared).toHaveLength(2);
      expect(new Set(shared.map((place) => place.channelKey)).size).toBe(1);
      expect(shared.map((place) => [place.agentGroupId, place.avatarUrl]).sort()).toEqual([
        ['ag-sibling', null],
        ['ag-voice', PICTURE],
      ]);

      await inWorkgroup('ag-sibling', 'beta', 'Beta');
      expect(new Set((await placesFor(key)).map((place) => place.channelKey)).size).toBe(2);
    } finally {
      for (const [channelType, identity] of bots) unregisterSlackBot(channelType, identity);
    }
  });

  it('checks a channel through the list’s cache, once, however many threads it holds', async () => {
    await newSession();
    await newSession();
    const key = await pairedKey(person);
    await placesFor(key);
    const seen = H.seeCalls;
    expect(await placesFor(key)).toHaveLength(1);
    expect(H.seeCalls).toBe(seen);
    expect(seen).toBe(1);
  });

  it.each<[string, () => Promise<unknown>]>([
    ['the person cannot see the channel', async () => H.visible.delete(person)],
    ['the person lost access', () => getDb().run('DELETE FROM agent_group_members WHERE user_id = ?', person)],
    ['the agent is not wired anywhere', () => getDb().run('DELETE FROM messaging_group_agents')],
    [
      'voice calls are off for the agent',
      () => getDb().run("UPDATE messaging_group_agents SET agent_group_id = 'ag-quiet'"),
    ],
  ])('leaves a place out when %s', async (_name, change) => {
    await wire(CHANNEL);
    await memberOf('ag-quiet');
    const key = await pairedKey(person);
    await change();
    expect(await placesFor(key)).toEqual([]);
  });
});

describe('POST /v1/threads/:id/call', () => {
  it('answers 404 identically for a session that does not exist and every session the person cannot see', async () => {
    const key = await pairedKey(person);
    vi.useFakeTimers({ toFake: ['Date'] });
    const answer = async (id: string) => {
      vi.setSystemTime(Date.now() + 15_000);
      const res = await send('POST', `/v1/threads/${id}/call`, { key });
      return { status: res.status, body: res.body };
    };
    const missing = await answer('sess-does-not-exist');
    expect(missing.status).toBe(404);

    expect(await answer(await newSession({ agent_group_id: 'ag-quiet' }))).toEqual(missing);
    expect(await answer(await newSession({ thread_id: 'system:tasks:series-1' }))).toEqual(missing);
    expect(await answer(await newSession({ status: 'closed' }))).toEqual(missing);
    expect(await answer(await newSession({ archived_at: NOW }))).toEqual(missing);
    expect(await answer(await newSession({ messaging_group_id: null }))).toEqual(missing);
    await createMessagingGroup({
      id: 'mg-dm',
      channel_type: 'slack',
      platform_id: 'slack:D0DM',
      name: null,
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: NOW,
    });
    expect(await answer(await newSession({ messaging_group_id: 'mg-dm', thread_id: null }))).toEqual(missing);

    const channel = await newSession();
    H.seeFails = true;
    expect(await answer(channel)).toEqual(missing);
    H.seeFails = false;
    H.visible.delete(person);
    expect(await answer(channel)).toEqual(missing);
    expect(H.posts.filter((post) => post.text.includes('started a call'))).toEqual([]);
  });

  it('re-checks visibility live, whichever way the list’s cached answer went', async () => {
    const key = await pairedKey(person);
    const id = await newSession();
    expect(sessionIds(await listThreads(key))).toContain(id);

    H.visible.delete(person);
    expect(sessionIds(await listThreads(key))).toContain(id);
    expect((await send('POST', `/v1/threads/${id}/call`, { key })).status).toBe(404);

    const other = await newPerson({ visible: false });
    const otherKey = await pairedKey(other);
    expect(await listThreads(otherKey)).toEqual([]);
    H.visible.add(other);
    expect((await send('POST', `/v1/threads/${id}/call`, { key: otherKey })).status).toBe(200);
  });

  it('re-checks membership live', async () => {
    const key = await pairedKey(person);
    const id = await newSession();
    await listThreads(key);
    await getDb().run('DELETE FROM agent_group_members WHERE user_id = ?', person);
    expect((await send('POST', `/v1/threads/${id}/call`, { key })).status).toBe(404);
  });

  it('adds the person the key belongs to, not the thread’s latest human, and sends no DM', async () => {
    const key = await pairedKey(person);
    const id = await newSession({ thread_id: 'slack:C0TEST:7.0' });
    H.latestHuman = await newPerson();
    H.dmsOpened.length = 0;
    H.posts.length = 0;

    const res = await send('POST', `/v1/threads/${id}/call`, { key });

    expect(res.status).toBe(200);
    const body = parsed<{ url: string; expiresAt: string }>(res);
    expect(body).toEqual({
      url: expect.stringMatching(/^https:\/\/[0-9a-f]{32}\.calls\.example$/),
      agentName: 'Juniper',
      joined: false,
      expiresAt: expect.any(String),
    });
    expect(linkFor(linkIn(body.url))!.person.userId).toBe(person);
    expect(H.dmsOpened).toEqual([]);
    expect(H.posts).toEqual([
      {
        platformId: 'slack:C0TEST',
        threadId: 'slack:C0TEST:7.0',
        text: expect.stringContaining(`${nameOf(person)} started a call with Juniper`),
      },
    ]);
  });

  it('hands back a link that claims like any other, and joins the live call for the next person', async () => {
    const key = await pairedKey(person);
    const id = await newSession();
    const first = parsed<{ url: string }>(await send('POST', `/v1/threads/${id}/call`, { key }));
    expect(await claimLink(linkIn(first.url))).toMatchObject({ token: expect.any(String) });

    const second = await send('POST', `/v1/threads/${id}/call`, { key: await pairedKey(await newPerson()) });

    expect(parsed(second)).toMatchObject({ joined: true, agentName: 'Juniper' });
    expect(linkFor(linkIn(parsed<{ url: string }>(second).url))!.call).toBe(linkFor(linkIn(first.url))!.call);
  });

  it('answers 409 with a sentence when calls are not enabled for the agent', async () => {
    await addMember({ user_id: person, agent_group_id: 'ag-quiet', added_by: null, added_at: NOW });
    const res = await send('POST', `/v1/threads/${await newSession({ agent_group_id: 'ag-quiet' })}/call`, {
      key: await pairedKey(person),
    });
    expect([res.status, parsed(res)]).toEqual([409, { error: 'Group calls are not enabled for this agent.' }]);
  });

  it('answers 409 when the host is at its call limit, with no direct-call fallback', async () => {
    const key = await pairedKey(person);
    await send('POST', `/v1/threads/${await newSession()}/call`, { key });
    await send('POST', `/v1/threads/${await newSession()}/call`, { key });
    const res = await send('POST', `/v1/threads/${await newSession()}/call`, { key });
    expect([res.status, parsed(res)]).toEqual([
      409,
      { error: 'Too many group calls are live on this host right now.' },
    ]);
  });
});

describe('GET /v1/threads/:threadKey/messages', () => {
  const read = (key: string, threadKey: string) => send('GET', `/v1/threads/${threadKey}/messages`, { key });
  const answer = (res: { status: number; body: string }) => ({ status: res.status, body: res.body });
  const THREAD = 'slack:C0TEST:7.0';

  it('answers a key no thread has as a call answers a session that does not exist', async () => {
    const key = await pairedKey(person);
    await newSession({ thread_id: THREAD });

    const refused = answer(await read(key, 'AAAAAAAAAAAAAAAAAAAAAA'));

    expect(refused).toEqual(answer(await send('POST', '/v1/threads/sess-does-not-exist/call', { key })));
    expect(refused.status).toBe(404);
  });

  it.each<[string, (sessionId: string) => unknown]>([
    ['loses the agent', () => getDb().run('DELETE FROM agent_group_members WHERE user_id = ?', person)],
    ['finds the session closed', (id) => getDb().run("UPDATE sessions SET status = 'closed' WHERE id = ?", id)],
    ['finds the session archived', (id) => getDb().run('UPDATE sessions SET archived_at = ? WHERE id = ?', NOW, id)],
    ['finds the agent unwired from the channel', () => getDb().run('DELETE FROM messaging_group_agents')],
  ])('refuses a person who %s, exactly as a call is refused', async (_case, lose) => {
    const key = await pairedKey(person);
    const sessionId = await newSession({ thread_id: THREAD });
    await said('Is the nightly green?');
    const [{ threadKey }] = await listThreads(key);
    expect(parsed<{ messages: unknown[] }>(await read(key, threadKey)).messages).toHaveLength(1);

    await lose(sessionId);
    const refused = answer(await read(key, threadKey));

    expect(refused).toEqual(answer(await send('POST', `/v1/threads/${sessionId}/call`, { key })));
    expect(refused.status).toBe(404);
  });

  it.each<[string, () => void]>([
    ['is no longer shown the channel', () => H.visible.delete(person)],
    ['cannot be checked, because the platform fails', () => void (H.seeFails = true)],
  ])(
    'reads by the list’s answer while it is fresh when the person %s, then refuses as a call refuses at once',
    async (_case, lose) => {
      const key = await pairedKey(person);
      const sessionId = await newSession({ thread_id: THREAD });
      await said('Is the nightly green?');
      const [{ threadKey }] = await listThreads(key);
      vi.useFakeTimers({ toFake: ['Date'] });

      lose();
      const call = answer(await send('POST', `/v1/threads/${sessionId}/call`, { key }));
      const fresh = await read(key, threadKey);
      vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
      const lapsed = answer(await read(key, threadKey));

      expect(call.status).toBe(404);
      expect(parsed<{ messages: unknown[] }>(fresh).messages).toHaveLength(1);
      expect(lapsed).toEqual(call);
    },
  );

  it('renews the list’s answer as the list does, so an open thread keeps reading past ten minutes on one check', async () => {
    const key = await pairedKey(person);
    await newSession({ thread_id: THREAD });
    await said('Is the nightly green?');
    const [{ threadKey }] = await listThreads(key);
    vi.useFakeTimers({ toFake: ['Date'] });

    vi.setSystemTime(Date.now() + 9 * 60_000);
    const renewing = await read(key, threadKey);
    const checks = H.seeCalls;
    vi.setSystemTime(Date.now() + 2 * 60_000);
    const renewed = await read(key, threadKey);

    expect([renewing.status, renewed.status, checks, H.seeCalls]).toEqual([200, 200, 2, 2]);
  });

  describe('mentions', () => {
    const own = { userId: 'U0BOTEXAMPLE', username: 'quill-bot', displayName: 'Quill', teamId: 'T-NAMES-TEST' };
    const far = { userId: 'U0BOTOTHER1', username: 'far-bot', displayName: 'Faraway', teamId: 'T-OTHER-TEST' };
    beforeEach(() => {
      registerSlackBot('slack', own);
      registerSlackBot('slack-foreign', far);
    });
    afterEach(() => {
      unregisterSlackBot('slack', own);
      unregisterSlackBot('slack-foreign', far);
    });
    const textOf = async (key: string) => {
      const [{ threadKey }] = await listThreads(key);
      return parsed<{ messages: Array<{ text: string }> }>(await read(key, threadKey)).messages.map((m) => m.text);
    };

    it('names agents and people from the thread’s own workspace, and nobody from another', async () => {
      await createUser({ id: 'slack:U0USEREXAMPLE1', kind: 'slack', display_name: 'Carol Friend', created_at: NOW });
      const elsewhere = { kind: 'slack', created_at: NOW };
      await createUser({ ...elsewhere, id: 'slack-foreign:U0USEREXAMPLE1', display_name: 'Same Id Elsewhere' });
      await createUser({ ...elsewhere, id: 'slack-foreign:U0USEREXAMPLE2', display_name: 'Only Elsewhere' });
      const key = await pairedKey(person);
      await newSession({ thread_id: THREAD });
      await said('<@U0BOTEXAMPLE>, ask <@U0USEREXAMPLE1>, not <@U0BOTOTHER1>, <@U0USEREXAMPLE2> or <@U0UNKNOWN1>');

      expect(await textOf(key)).toEqual([
        '@Quill, ask @Carol Friend, not <@U0BOTOTHER1>, <@U0USEREXAMPLE2> or <@U0UNKNOWN1>',
      ]);
    });

    /** A Discord thread a Discord person can read, holding one message. */
    async function discordThreadSaying(text: string): Promise<string> {
      const id = 'discord:1234567890';
      await createUser({ id, kind: 'discord', display_name: 'Someone Else', created_at: NOW });
      await memberOf('ag-voice', id);
      H.visible.add(id);
      await createUser({ id: 'discord:1234567890123456780', kind: 'discord', display_name: 'Sky', created_at: NOW });
      await channel('mg-discord', 'discord:111:222', 'discord', 'general');
      await newSession({ messaging_group_id: 'mg-discord', thread_id: 'discord:111:222:333' });
      await said(text, { channelType: 'discord', platformId: 'discord:111:222', threadId: 'discord:111:222:333' });
      return pairedKey(id);
    }

    it('names a Discord agent and person in a Discord thread', async () => {
      H.discordBots.set('discord', { userId: '1234567890123456789', username: 'Wren' });
      const key = await discordThreadSaying('ask @1234567890123456789 and <@1234567890123456780>');

      expect(await textOf(key)).toEqual(['ask @Wren and @Sky']);
    });

    it('names a Discord person before any Discord bot has registered', async () => {
      const key = await discordThreadSaying('ask <@1234567890123456780>');

      expect(await textOf(key)).toEqual(['ask @Sky']);
    });
  });

  it('reads a channel’s top level for a session with no thread, without the replies in its threads', async () => {
    const key = await pairedKey(person);
    await newSession({ thread_id: null });
    await said('Standup moves to ten.', { threadId: null });
    await said('Ten works for me.');
    const [{ threadKey }] = await listThreads(key);

    const { messages } = parsed<{ messages: Array<{ text: string }> }>(await read(key, threadKey));

    expect(messages.map((message) => message.text)).toEqual(['Standup moves to ten.']);
  });

  it('reads nothing that only an agent the person cannot call recorded', async () => {
    await shareWorkgroup();
    const key = await pairedKey(person);
    await newSession({ thread_id: THREAD });
    await newSession({ thread_id: THREAD, agent_group_id: 'ag-quiet' });
    await said('Is the nightly green?');
    await said('Only the quiet agent saw this.', { agent: 'ag-quiet' });
    const [{ threadKey }] = await listThreads(key);

    const { messages } = parsed<{ messages: Array<{ text: string }> }>(await read(key, threadKey));

    expect(messages.map((message) => message.text)).toEqual(['Is the nightly green?']);
  });

  describe('across sibling bots', () => {
    withSiblingBots();

    it('reads through a sibling when the freshest agent’s own check fails', async () => {
      await memberOf('ag-sibling');
      await shareWorkgroup();
      await channel('mg-sibling', 'slack:C0TEST', 'slack-sibling', 'general');
      await newSession({ thread_id: THREAD, last_active: ago(60_000) });
      await newSession({ thread_id: THREAD, agent_group_id: 'ag-sibling', messaging_group_id: 'mg-sibling' });
      const key = await pairedKey(person);
      const [{ threadKey }] = await listThreads(key);
      H.failingBots.add('slack-sibling');

      expect((await read(key, threadKey)).status).toBe(200);
    });

    it('shows each message once, and an agent’s post as that agent recorded it', async () => {
      await memberOf('ag-sibling');
      await shareWorkgroup();
      await channel('mg-sibling', 'slack:C0TEST', 'slack-sibling', 'general');
      await newSession({ thread_id: THREAD });
      await newSession({ thread_id: THREAD, agent_group_id: 'ag-sibling', messaging_group_id: 'mg-sibling' });
      const sibling = { agent: 'ag-sibling', channelType: 'slack-sibling' };
      const inBoth = async (text: string, senderId: string, senderName: string, sentAt: string) => {
        await said(text, { senderId: `slack:${senderId}`, senderName, sentAt });
        await said(text, { ...sibling, senderId: `slack-sibling:${senderId}`, senderName, sentAt });
      };
      await inBoth('Is the nightly green?', 'U0EXAMPLE', 'Ana Example', '2026-10-31T11:00:00.000Z');
      await said('It is **green**.', {
        role: 'assistant',
        senderId: 'ag-voice',
        senderName: 'assistant',
        sentAt: '2026-10-31T11:01:00.150Z',
      });
      await said('It is *green*.', {
        ...sibling,
        senderId: 'slack-sibling:U-BOT-A',
        senderName: 'Juniper',
        sentAt: '2026-10-31T11:01:00.000Z',
      });
      await said('Two flaky tests were retried.', {
        ...sibling,
        role: 'assistant',
        senderId: 'ag-sibling',
        senderName: 'assistant',
        sentAt: '2026-10-31T11:02:00.200Z',
      });
      await said('Two flaky tests were retried.', {
        senderId: 'slack:U-BOT-B',
        senderName: 'Aster',
        sentAt: '2026-10-31T11:02:00.000Z',
      });
      await inBoth('I re-ran the deploy.', 'U-BOT-C', 'Quill', '2026-10-31T11:03:00.000Z');
      const key = await pairedKey(person);
      const [{ threadKey }] = await listThreads(key);

      const res = await read(key, threadKey);

      const shown = (speaker: string, fromAgent: boolean, text: string, sentAt: string) => ({
        id: expect.stringMatching(/^[\w-]{22}$/),
        speaker,
        fromAgent,
        spoken: false,
        text,
        sentAt,
      });
      expect(parsed(res)).toEqual({
        messages: [
          shown('Ana Example', false, 'Is the nightly green?', '2026-10-31T11:00:00.000Z'),
          shown('Juniper', true, 'It is **green**.', '2026-10-31T11:01:00.150Z'),
          shown('Aster', true, 'Two flaky tests were retried.', '2026-10-31T11:02:00.200Z'),
          shown('Quill', true, 'I re-ran the deploy.', '2026-10-31T11:03:00.000Z'),
        ],
      });
    });
  });
});

describe('the person’s own DMs', () => {
  const DM = 'mg-dm';
  const DM_THREAD = 'slack:D0DM:5.0';
  const read = (key: string, threadKey: string) => send('GET', `/v1/threads/${threadKey}/messages`, { key });
  const dmCall = (key: string, sessionId: string) => send('POST', `/v1/threads/${sessionId}/dm-call`, { key });

  const record = (userId: string, messagingGroupId: string, channelType = 'slack') =>
    upsertUserDm({
      user_id: userId,
      channel_type: channelType,
      messaging_group_id: messagingGroupId,
      resolved_at: NOW,
    });

  /** A DM with an agent, named for the person in it as `ensureUserDm` names one, and recorded as `owner`'s. */
  async function dm(
    owner: string | null,
    {
      id = DM,
      channelType = 'slack',
      platformId = 'slack:D0DM',
    }: Partial<Record<'id' | 'channelType' | 'platformId', string>> = {},
  ): Promise<void> {
    await createMessagingGroup({
      id,
      channel_type: channelType,
      platform_id: platformId,
      name: 'Person 1',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: NOW,
    });
    if (owner) await record(owner, id, channelType);
  }

  /** Nothing but the record left: no membership, no channel the platform shows them, no calls on this host. */
  async function onlyTheRecord(): Promise<void> {
    await getDb().run('DELETE FROM agent_group_members');
    H.visible.clear();
    H.callsConfigured = false;
  }

  it('lists one to the person in it, with no call, no platform check and no other access', async () => {
    const key = await pairedKey(person);
    await onlyTheRecord();
    await dm(person);
    const lastActive = new Date().toISOString();
    await newSession({ messaging_group_id: DM, thread_id: DM_THREAD, last_active: lastActive });

    const list = await listing(key);

    expect(list).toEqual({
      threads: [
        {
          threadKey: expect.stringMatching(/^[\w-]{22}$/),
          workgroupId: '_agent-group:ag-voice',
          workgroupName: 'juniper',
          platform: 'slack',
          channelKey: expect.stringMatching(/^[\w-]{22}$/),
          channelName: null,
          title: 'DM with Juniper',
          lastActiveAt: lastActive,
          agents: [],
          dmWith: 'Juniper',
          dmCalls: [],
          call: null,
        },
      ],
      workgroups: [{ id: '_agent-group:ag-voice', name: 'juniper' }],
      channels: [
        {
          id: list.threads[0].channelKey,
          workgroupId: '_agent-group:ag-voice',
          platform: 'slack',
          name: 'DM with Juniper',
        },
      ],
    });
    expect(H.seeCalls).toBe(0);
  });

  describe('calls from it', () => {
    const LINK = /^https:\/\/[0-9a-f]{32}\.calls\.example$/;

    it('lists its agent for a DM call and for no group call, which it still refuses', async () => {
      await dm(person);
      const sessionId = await newSession({ messaging_group_id: DM, thread_id: DM_THREAD });
      const key = await pairedKey(person);

      const [thread] = await listThreads(key);

      expect([thread.agents, thread.dmCalls]).toEqual([
        [],
        [{ sessionId, agentGroupId: 'ag-voice', name: 'Juniper', avatarUrl: null }],
      ]);
      expect((await send('POST', `/v1/threads/${sessionId}/call`, { key })).status).toBe(404);
    });

    it('opens a room only the DM’s person may join, as them and not whoever spoke last, with the link in the response', async () => {
      await dm(person);
      const sessionId = await newSession({ messaging_group_id: DM, thread_id: DM_THREAD });
      const key = await pairedKey(person);
      H.latestHuman = await newPerson();
      H.dmsOpened.length = 0;
      H.posts.length = 0;

      const res = await dmCall(key, sessionId);

      const body = parsed<{ url: string }>(res);
      expect([res.status, body]).toEqual([
        200,
        { url: expect.stringMatching(LINK), agentName: 'Juniper', joined: false, expiresAt: expect.any(String) },
      ]);
      const { call, person: joiner } = linkFor(linkIn(body.url))!;
      expect([joiner.userId, call.sessionId, call.place, call.route]).toEqual([
        person,
        sessionId,
        { platform: 'slack', dm: true, ownerId: person },
        {
          channelType: 'slack',
          instance: 'slack',
          platformId: 'slack:D0DM',
          threadId: DM_THREAD,
          messagingGroupId: DM,
        },
      ]);
      expect([H.dmsOpened, H.posts]).toEqual([[], []]);
    });

    it('answers 404 and opens nothing for a DM not theirs, a session gone from theirs, or a channel thread', async () => {
      const owner = await newPerson();
      await dm(owner);
      const theirs = await newSession({ messaging_group_id: DM, thread_id: DM_THREAD });
      await dm(null, { id: 'mg-dm-nobody', platformId: 'slack:D0NOB' });
      const nobodys = await newSession({ messaging_group_id: 'mg-dm-nobody', thread_id: 'slack:D0NOB:1.0' });
      await dm(person, { id: 'mg-dm-own', platformId: 'slack:D0OWN' });
      const closed = await newSession({
        messaging_group_id: 'mg-dm-own',
        thread_id: 'slack:D0OWN:1.0',
        status: 'closed',
      });
      const unwired = await newSession({
        messaging_group_id: 'mg-dm-own',
        thread_id: 'slack:D0OWN:2.0',
        agent_group_id: 'ag-sibling',
      });
      await getDb().run('DELETE FROM messaging_group_agents WHERE agent_group_id = ?', 'ag-sibling');
      const channelThread = await newSession();
      const key = await pairedKey(person);

      const sessions = [theirs, nobodys, closed, unwired, channelThread];
      for (const sessionId of sessions)
        expect([sessionId, (await dmCall(key, sessionId)).status]).toEqual([sessionId, 404]);
      expect(sessions.filter(groupCallLive)).toEqual([]);
    });

    it('lists none and refuses one where voice is off for the agent, or the person may not call it', async () => {
      await addMember({ user_id: person, agent_group_id: 'ag-quiet', added_by: null, added_at: NOW });
      await dm(person);
      const quiet = await newSession({ agent_group_id: 'ag-quiet', messaging_group_id: DM, thread_id: DM_THREAD });
      const outsider = await newPerson();
      const outsiderKey = await pairedKey(outsider);
      await getDb().run('DELETE FROM agent_group_members WHERE user_id = ?', outsider);
      await dm(outsider, { id: 'mg-dm-outsider', platformId: 'slack:D0OUT' });
      const barred = await newSession({ messaging_group_id: 'mg-dm-outsider', thread_id: 'slack:D0OUT:1.0' });

      for (const [key, sessionId, refusal] of [
        [await pairedKey(person), quiet, 'Group calls are not enabled for this agent.'],
        [outsiderKey, barred, 'Only people who can talk to this agent can call it from their DM.'],
      ]) {
        expect((await listThreads(key)).map((thread) => thread.dmCalls)).toEqual([[]]);
        const res = await dmCall(key, sessionId);
        expect([res.status, parsed(res)]).toEqual([409, { error: refusal }]);
      }
      expect([quiet, barred].filter(groupCallLive)).toEqual([]);
    });

    it('lists none, and refuses one, on a host with group calls off', async () => {
      await dm(person);
      const sessionId = await newSession({ messaging_group_id: DM, thread_id: DM_THREAD });
      const key = await pairedKey(person);
      H.callsConfigured = false;

      expect((await listThreads(key)).map((thread) => thread.dmCalls)).toEqual([[]]);
      const res = await dmCall(key, sessionId);
      expect([res.status, parsed(res)]).toEqual([409, { error: 'Group calls are not enabled for this agent.' }]);
    });

    it('lists the DM with no call while its room is live, and joins that room from any thread of the DM', async () => {
      await dm(person);
      const first = await newSession({ messaging_group_id: DM, thread_id: DM_THREAD });
      const second = await newSession({ messaging_group_id: DM, thread_id: 'slack:D0DM:6.0' });
      const key = await pairedKey(person);
      const opened = parsed<{ url: string }>(await dmCall(key, first));
      const room = linkFor(linkIn(opened.url))!;
      H.roomPeople = [room.person.identity];
      await vi.waitFor(() => expect(groupCallPeople(first)).toEqual([nameOf(person)]), { timeout: 5000 });

      expect((await listThreads(key)).map((thread) => [thread.call, thread.dmCalls!.length])).toEqual([
        [null, 1],
        [null, 1],
      ]);
      const again = parsed<{ url: string; joined: boolean }>(await dmCall(key, second));
      expect([again.joined, linkFor(linkIn(again.url))!.call]).toEqual([true, room.call]);
    });

    it('opens its own room while a channel call of the agent is live, which the person could join from the channel', async () => {
      await dm(person);
      const sessionId = await newSession({ messaging_group_id: DM, thread_id: DM_THREAD });
      const key = await pairedKey(person);
      const channel = parsed<{ url: string }>(await send('POST', `/v1/threads/${await newSession()}/call`, { key }));

      const own = parsed<{ url: string; joined: boolean }>(await dmCall(key, sessionId));

      expect(own.joined).toBe(false);
      expect(linkFor(linkIn(own.url))!.call).not.toBe(linkFor(linkIn(channel.url))!.call);
    });
  });

  it('finds a word in it without waiting for the scheduled check, and says nothing was cut short', async () => {
    const key = await pairedKey(person);
    await onlyTheRecord();
    await dm(person);
    await newSession({ messaging_group_id: DM, thread_id: DM_THREAD });
    await said('the zeppelin landed', { platformId: 'slack:D0DM', threadId: DM_THREAD });

    const { threads, textCutShort } = await listing(key, { q: 'zeppelin' });

    expect([threads.map((thread) => thread.dmWith), textCutShort]).toEqual([['Juniper'], undefined]);
  });

  it('titles it as any thread is titled, so “DM with” its agent is only the last resort', async () => {
    await dm(person);
    await setTitle(await newSession({ messaging_group_id: DM, thread_id: DM_THREAD }), 'Nightly deploy check', NOW);

    expect((await listThreads(await pairedKey(person))).map((thread) => thread.title)).toEqual([
      'Nightly deploy check',
    ]);
  });

  it('reads both sides of it on the record alone', async () => {
    const key = await pairedKey(person);
    await onlyTheRecord();
    await dm(person);
    await newSession({ messaging_group_id: DM, thread_id: DM_THREAD });
    const at = { platformId: 'slack:D0DM', threadId: DM_THREAD };
    await said('Can you check the nightly?', {
      ...at,
      senderId: person,
      senderName: 'Person 1',
      sentAt: '2026-10-31T11:00:00.000Z',
    });
    await said('It is green.', {
      ...at,
      role: 'assistant',
      senderId: 'ag-voice',
      senderName: 'assistant',
      sentAt: '2026-10-31T11:01:00.000Z',
    });
    const [{ threadKey }] = await listThreads(key);

    const { messages } = parsed<{ messages: Array<{ speaker: string; text: string }> }>(await read(key, threadKey));

    expect(messages.map(({ speaker, text }) => [speaker, text])).toEqual([
      ['Person 1', 'Can you check the nightly?'],
      ['Juniper', 'It is green.'],
    ]);
    expect(H.seeCalls).toBe(0);
  });

  it('reads a Discord DM whole: the person’s words under its thread and the agent’s replies at its top level', async () => {
    const id = 'discord:7654321098';
    await createUser({ id, kind: 'discord', display_name: 'Carol Example', created_at: NOW });
    await memberOf('ag-voice', id);
    await dm(id, { id: 'mg-ddm', channelType: 'discord', platformId: 'discord:@me:555' });
    await newSession({ messaging_group_id: 'mg-ddm', thread_id: 'discord:@me:555' });
    const at = { channelType: 'discord', platformId: 'discord:@me:555' };
    await said('Is the deploy done?', {
      ...at,
      threadId: 'discord:@me:555',
      senderId: id,
      senderName: 'Carol Example',
      sentAt: '2026-10-31T11:00:00.000Z',
    });
    await said('It shipped at noon.', {
      ...at,
      threadId: null,
      role: 'assistant',
      senderId: 'ag-voice',
      senderName: 'assistant',
      sentAt: '2026-10-31T11:01:00.000Z',
    });
    const key = await pairedKey(id);
    const [{ threadKey, platform, dmWith }] = await listThreads(key);

    const { messages } = parsed<{ messages: Array<{ text: string }> }>(await read(key, threadKey));

    expect([platform, dmWith]).toEqual(['discord', 'Juniper']);
    expect(messages.map((message) => message.text)).toEqual(['Is the deploy done?', 'It shipped at noon.']);
  });

  it.each<[string, (other: string) => Promise<unknown>]>([
    ['a member of the agent the platform shows every channel', async () => undefined],
    ['an owner', (other) => makeOwner(other)],
  ])('never lists, finds or reads it for anyone else, even %s', async (_name, empower) => {
    await dm(person);
    await newSession({ messaging_group_id: DM, thread_id: DM_THREAD });
    await said('the zeppelin landed', { platformId: 'slack:D0DM', threadId: DM_THREAD });
    const [{ threadKey }] = await listThreads(await pairedKey(person));
    const other = await newPerson();
    await empower(other);
    const key = await pairedKey(other);
    const theirs = await newSession();
    await searchable();

    const listed = await listThreads(key);
    expect(listed.map((thread) => thread.threadKey)).not.toContain(threadKey);
    expect(listed).toEqual([expect.objectContaining({ agents: [expect.objectContaining({ sessionId: theirs })] })]);
    expect((await listing(key)).channels.map((channel) => channel.name)).toEqual(['#general']);
    expect(await listThreads(key, { q: 'zeppelin' })).toEqual([]);
    expect(H.walks).toBe(1);
    expect((await read(key, threadKey)).status).toBe(404);
  });

  it('follows the record to a re-opened DM, so the old one lists and reads nothing', async () => {
    await dm(person, { id: 'mg-dm-old', platformId: 'slack:D0OLD' });
    await setTitle(await newSession({ messaging_group_id: 'mg-dm-old', thread_id: 'slack:D0OLD:1.0' }), 'Before', NOW);
    await said('the old words', { platformId: 'slack:D0OLD', threadId: 'slack:D0OLD:1.0' });
    const key = await pairedKey(person);
    const [{ threadKey }] = await listThreads(key);

    await dm(person, { id: 'mg-dm-new', platformId: 'slack:D0NEW' });
    await setTitle(await newSession({ messaging_group_id: 'mg-dm-new', thread_id: 'slack:D0NEW:1.0' }), 'After', NOW);

    expect((await listThreads(key)).map((thread) => thread.title)).toEqual(['After']);
    expect((await read(key, threadKey)).status).toBe(404);
  });

  it('builds a DM’s thread from its own group, never from another that carries the same channel id', async () => {
    await shareWorkgroup();
    await memberOf('ag-sibling');
    await dm(person);
    await dm(null, { id: 'mg-dm-copy', channelType: 'slack-sibling' });
    await setTitle(await newSession({ messaging_group_id: DM, thread_id: DM_THREAD }), 'Shown', NOW);
    const copy = { agent_group_id: 'ag-sibling', messaging_group_id: 'mg-dm-copy', thread_id: DM_THREAD };
    await setTitle(await newSession(copy), 'Lighthouse budget', '2026-10-31T13:00:00.000Z');
    const key = await pairedKey(person);

    expect((await listThreads(key)).map(({ title, dmWith }) => [title, dmWith])).toEqual([['Shown', 'Juniper']]);
    expect(await listThreads(key, { q: 'lighthouse' })).toEqual([]);
  });

  it.each([
    ['a channel', CHANNEL, 'slack:C0TEST:5.0'],
    ['a Slack group DM', 'mg-group', 'slack:G0GROUP:5.0'],
  ])('takes a record naming %s as no proof: only the platform can show it', async (_name, messagingGroupId, thread) => {
    if (messagingGroupId !== CHANNEL) await dm(null, { id: messagingGroupId, platformId: 'slack:G0GROUP' });
    const outsider = await newPerson({ visible: false });
    await record(person, messagingGroupId);
    await record(outsider, messagingGroupId);
    const sessionId = await newSession({ messaging_group_id: messagingGroupId, thread_id: thread });

    expect(await listThreads(await pairedKey(outsider))).toEqual([]);
    const [shown] = await listThreads(await pairedKey(person));
    expect([sessionIds([shown]), shown.dmWith]).toEqual([[sessionId], undefined]);
  });

  it.each<[string, () => Promise<unknown>]>([
    ['a system thread', () => newSession({ messaging_group_id: DM, thread_id: 'system:checks' })],
    ['a task thread', () => newSession({ messaging_group_id: DM, thread_id: 'system:tasks:series-1' })],
    [
      'a native CLI conversation recorded as theirs',
      async () => {
        await createMessagingGroup({
          id: 'mg-cli',
          channel_type: 'cli',
          platform_id: 'native-juniper',
          name: null,
          is_group: 0,
          unknown_sender_policy: 'strict',
          created_at: NOW,
        });
        await record(person, 'mg-cli', 'cli');
        return newSession({ messaging_group_id: 'mg-cli', thread_id: null });
      },
    ],
  ])('omits %s, beside the DM thread it shows', async (_name, arrange) => {
    await dm(person);
    const key = await pairedKey(person);
    await arrange();
    await setTitle(await newSession({ messaging_group_id: DM, thread_id: DM_THREAD }), 'Shown', NOW);

    expect((await listThreads(key)).map((thread) => thread.title)).toEqual(['Shown']);
  });

  describe('under another of the person’s ids', () => {
    withSiblingBots();

    it('calls from it as that id, the one its messages carry', async () => {
      const sibling = `slack-sibling:${person.slice('slack:'.length)}`;
      await createUser({ id: sibling, kind: 'slack', display_name: 'Person 1', created_at: NOW });
      await addMember({ user_id: sibling, agent_group_id: 'ag-voice', added_by: null, added_at: NOW });
      await dm(sibling, { id: 'mg-dm-sib', channelType: 'slack-sibling', platformId: 'slack:D0SIB' });
      const sessionId = await newSession({ messaging_group_id: 'mg-dm-sib', thread_id: 'slack:D0SIB:1.0' });

      const body = parsed<{ url: string }>(await dmCall(await pairedKey(person), sessionId));

      expect(linkFor(linkIn(body.url))!.person.userId).toBe(sibling);
    });

    it('is theirs when a bot of their own workspace recorded it, and not when one in another workspace did', async () => {
      const raw = person.slice('slack:'.length);
      for (const [channelType, platformId, title] of [
        ['slack-sibling', 'slack:D0SIB', 'In their workspace'],
        ['slack-foreign', 'slack:D0FOR', 'In another workspace'],
      ]) {
        const id = `${channelType}:${raw}`;
        await createUser({ id, kind: 'slack', display_name: 'Person 1', created_at: NOW });
        await dm(id, { id: `mg-${channelType}`, channelType, platformId });
        await setTitle(
          await newSession({ messaging_group_id: `mg-${channelType}`, thread_id: `${platformId}:1.0` }),
          title,
          NOW,
        );
      }

      expect((await listThreads(await pairedKey(person))).map((thread) => thread.title)).toEqual([
        'In their workspace',
      ]);
    });

    it('offers each DM in the channel filter under its agent’s name, and choosing one shows only that DM', async () => {
      await shareWorkgroup();
      const sibling = `slack-sibling:${person.slice('slack:'.length)}`;
      await createUser({ id: sibling, kind: 'slack', display_name: 'Person 1', created_at: NOW });
      await dm(person);
      await dm(sibling, { id: 'mg-dm-aster', channelType: 'slack-sibling', platformId: 'slack:D0AST' });
      await setTitle(await newSession({ messaging_group_id: DM, thread_id: DM_THREAD }), 'With Juniper', NOW);
      const aster = { agent_group_id: 'ag-sibling', messaging_group_id: 'mg-dm-aster', thread_id: 'slack:D0AST:1.0' };
      await setTitle(await newSession(aster), 'With Aster', NOW);
      await setTitle(await newSession(), 'In general', NOW);
      const key = await pairedKey(person);

      const { channels } = await listing(key);
      const juniper = channels.find((channel) => channel.name === 'DM with Juniper');

      expect(channels.map((channel) => channel.name).sort()).toEqual(['#general', 'DM with Aster', 'DM with Juniper']);
      expect((await listThreads(key, { channel: juniper!.id })).map((thread) => thread.title)).toEqual([
        'With Juniper',
      ]);
    });
  });
});

const sendSetup = (clientId: string | null, teamId: string | null) => {
  for (const [name, value] of [
    ['MOBILE_SLACK_SEND_CLIENT_ID', clientId],
    ['MOBILE_SLACK_SEND_TEAM_ID', teamId],
  ] as const) {
    if (value === null) delete process.env[name];
    else process.env[name] = value;
  }
};

type HeldSecret = { id: string; name: string; hostPattern: string | null };
const USER_TOKEN: HeldSecret = { id: 'secret-user-token', name: 'Slack-User-Token-Example', hostPattern: 'slack.com' };
const FILES_TOKEN: HeldSecret = {
  id: 'secret-files-token',
  name: 'Slack-User-Token-Example-Files',
  hostPattern: 'files.slack.com',
};

/** Writes an agent group's `container.json`, declaring Slack user-token secrets. */
function declareSecrets(folder: string, onecliSecrets: string[]): void {
  fs.mkdirSync(path.join(H.groupsDir, folder), { recursive: true });
  fs.writeFileSync(
    path.join(H.groupsDir, folder, 'container.json'),
    JSON.stringify({ onecliSecrets, slack_user_token: { enabled: true } }),
  );
}

describe('a task’s posts in a channel', () => {
  const RAW = '123456789000000601';
  const PERSON = `discord:${RAW}`;
  const BOT = '123456789000000611';
  const CHANNEL_ID = 'discord:G2:C2';
  const TASK_CHANNEL = { channelType: 'discord', platformId: CHANNEL_ID };

  beforeEach(async () => {
    await createUser({ id: PERSON, kind: 'discord', display_name: 'Ana Example', created_at: NOW });
    await memberOf('ag-voice', PERSON);
    await memberOf('ag-sibling', PERSON);
    H.visible.add(PERSON);
    H.discordBots.set('discord', { userId: BOT, username: 'Juniper' });
    await shareWorkgroup();
    await channel('mg-dc', CHANNEL_ID, 'discord', 'general');
    await channel('mg-dc-codex', CHANNEL_ID, 'discord-codex', 'general');
  });

  const callIdOf = (sessionId: string, anchor: string, platformId = CHANNEL_ID) =>
    `${sessionId}~${Buffer.from(`${platformId}:${anchor}`).toString('base64url')}`;

  const textsIn = async (key: string, threadKey: string) =>
    parsed<{ messages: Array<{ text: string }> }>(
      await send('GET', `/v1/threads/${threadKey}/messages`, { key }),
    ).messages.map(({ text }) => text);

  async function rowsShown(key: string): Promise<Array<[string, string[]]>> {
    const shown: Array<[string, string[]]> = [];
    for (const { title, threadKey } of await listThreads(key)) shown.push([title, await textsIn(key, threadKey)]);
    return shown.sort(([a], [b]) => a.localeCompare(b));
  }

  const siblingCopy = (text: string, threadId: string | null) =>
    said(text, {
      agent: 'ag-sibling',
      channelType: 'discord-codex',
      platformId: CHANNEL_ID,
      threadId,
      role: 'user',
      senderId: `discord-codex:${BOT}`,
      senderName: 'Juniper',
      messagingGroupId: 'mg-dc-codex',
    });

  it('lists each task’s thread on its own, from its anchor post, and keeps its posts out of the channel’s top level', async () => {
    await newSession({ messaging_group_id: 'mg-dc', thread_id: null });
    await newSession({ agent_group_id: 'ag-sibling', messaging_group_id: 'mg-dc-codex', thread_id: null });
    await said('Standup moves to ten.', {
      ...TASK_CHANNEL,
      threadId: null,
      senderId: PERSON,
      messagingGroupId: 'mg-dc',
    });
    await said('Ten it is.', { ...TASK_CHANNEL, threadId: null, role: 'assistant', messagingGroupId: 'mg-dc' });
    for (const [series, anchor, posts] of [
      ['meeting-prep', '1234567890100000001', ['**Meeting prep, Thu.** Two docs.', 'Budget review, 10:30.']],
      ['career-journal', '1234567890100000002', ['Career journal, Wed.', 'Shipped the fix.']],
    ] as const) {
      await siblingCopy(posts[0], null);
      await taskPosting(series, TASK_CHANNEL, anchor, [...posts]);
    }
    const key = await pairedKey(PERSON);

    expect(await rowsShown(key)).toEqual([
      ['#general', ['Standup moves to ten.', 'Ten it is.']],
      ['Career journal, Wed.', ['Career journal, Wed.', 'Shipped the fix.']],
      ['Meeting prep, Thu. Two docs.', ['**Meeting prep, Thu.** Two docs.', 'Budget review, 10:30.']],
    ]);
  });

  it('lists a task’s thread only to someone the platform shows that thread, and calls there only for them', async () => {
    await wire('mg-dc');
    const sessionId = await taskPosting('meeting-prep', TASK_CHANNEL, '1234567890100000001', [
      'Meeting prep, Thu.',
      'Budget review, 10:30.',
    ]);
    const outsider = 'discord:123456789000000602';
    await createUser({ id: outsider, kind: 'discord', display_name: 'Sky Example', created_at: NOW });
    await memberOf('ag-voice', outsider);
    H.visible.add(outsider);
    H.outOfThread.add(`1234567890100000001 ${outsider}`);
    const key = await pairedKey(PERSON);

    const outsiderKey = await pairedKey(outsider);
    expect(await listThreads(outsiderKey)).toEqual([]);
    const [[callId]] = (await listThreads(key)).map((thread) => thread.agents.map((agent) => agent.sessionId));
    expect(callId).toBe(callIdOf(sessionId, '1234567890100000001'));
    for (const id of [
      callId,
      sessionId,
      `${callId}~1`,
      `${sessionId}~1234567890100000001`,
      callIdOf(sessionId, '1234567890100000009'),
    ])
      expect((await send('POST', `/v1/threads/${id}/call`, { key: outsiderKey })).status).toBe(404);
    expect((await send('POST', `/v1/threads/${sessionId}/call`, { key })).status).toBe(404);
    expect(await threadSessions()).toEqual([]);
    expect((await send('POST', `/v1/threads/${callId}/call`, { key })).status).toBe(200);
  });

  const threadSessions = () =>
    getDb().all<{ agent_group_id: string; messaging_group_id: string; thread_id: string; engaged: number }>(
      `SELECT agent_group_id, messaging_group_id, thread_id, engaged_at IS NOT NULL AS engaged
         FROM sessions WHERE thread_id LIKE ? ORDER BY created_at, id`,
      `${CHANNEL_ID}:%`,
    );

  it('calls in a task’s thread through the session a reply there opens, opened once and found after', async () => {
    await wire('mg-dc');
    await taskPosting('meeting-prep', TASK_CHANNEL, '1234567890100000001', ['Meeting prep, Thu.', 'Budget review.']);
    const key = await pairedKey(PERSON);
    const [{ agents }] = await listThreads(key);
    H.posts.length = 0;

    const first = await send('POST', `/v1/threads/${agents[0].sessionId}/call`, { key });
    const second = await send('POST', `/v1/threads/${agents[0].sessionId}/call`, { key });

    const opened = await threadSessions();
    expect(opened).toEqual([
      {
        agent_group_id: 'ag-voice',
        messaging_group_id: 'mg-dc',
        thread_id: `${CHANNEL_ID}:1234567890100000001`,
        engaged: 1,
      },
    ]);
    const id = (await findSessionForAgent('ag-voice', 'mg-dc', opened[0].thread_id))?.id;
    expect([first.status, parsed(second)]).toEqual([200, expect.objectContaining({ joined: true })]);
    expect(H.posts).toEqual([
      {
        platformId: CHANNEL_ID,
        threadId: `${CHANNEL_ID}:1234567890100000001`,
        text: expect.stringContaining('started a call with Juniper'),
      },
    ]);
    const [row] = await listThreads(key);
    expect([row.title, row.agents.map((agent) => agent.sessionId)]).toEqual(['Meeting prep, Thu.', [id]]);
  });

  it('lists a task’s top-level posts only in a channel where its series keeps an anchor', async () => {
    await wire('mg-dc');
    await channel('mg-dc3', 'discord:G2:C3', 'discord', 'random');
    await wire('mg-dc3');
    const sessionId = await taskPosting('mention-scan', TASK_CHANNEL, '1234567890100000001', [
      'Mention scan, Tue.',
      'One ask.',
    ]);
    const elsewhere = { channelType: 'discord', platformId: 'discord:G2:C3' };
    await taskFire(sessionId, elsewhere, '1234567890100000002', ['Keyed item.', 'Its follow-up.']);
    await getDb().run(
      'DELETE FROM task_thread_anchors WHERE session_id = ? AND platform_id = ?',
      sessionId,
      'discord:G2:C3',
    );

    expect((await listThreads(await pairedKey(PERSON))).map((thread) => thread.title)).toEqual(['Mention scan, Tue.']);
  });

  it('calls the thread a row names when one series’ posts in two channels share a post id', async () => {
    await wire('mg-dc');
    await channel('mg-dc3', 'discord:G2:C3', 'discord', 'random');
    await wire('mg-dc3');
    const elsewhere = { channelType: 'discord', platformId: 'discord:G2:C3' };
    const sessionId = await taskPosting(
      'mention-scan',
      TASK_CHANNEL,
      'T5',
      ['Mention scan, general.', 'One ask.'],
      ago(60 * 60_000),
    );
    await taskFire(sessionId, elsewhere, 'T5', ['Mention scan, random.', 'No asks.']);
    const key = await pairedKey(PERSON);
    const rows = new Map((await listThreads(key)).map((thread) => [thread.title, thread.agents[0].sessionId]));
    expect(rows).toEqual(
      new Map([
        ['Mention scan, random.', callIdOf(sessionId, 'T5', 'discord:G2:C3')],
        ['Mention scan, general.', callIdOf(sessionId, 'T5')],
      ]),
    );

    expect((await send('POST', `/v1/threads/${rows.get('Mention scan, general.')}/call`, { key })).status).toBe(200);
    expect((await threadSessions()).map((session) => session.thread_id)).toEqual([`${CHANNEL_ID}:T5`]);
  });

  it('opens no session for a call in a task’s thread that the agent or its wiring refuses', async () => {
    await wire('mg-dc');
    await wire('mg-dc', 'ag-quiet');
    await memberOf('ag-quiet', PERSON);
    const quiet = await taskPosting('quiet-scan', { ...TASK_CHANNEL, agent: 'ag-quiet' }, '1234567890100000005', [
      'Quiet scan.',
      'One ask.',
    ]);
    const scan = await taskPosting('mention-scan', TASK_CHANNEL, '1234567890100000006', ['Mention scan.', 'One ask.']);
    await getDb().run(
      "UPDATE messaging_group_agents SET session_mode = 'agent-shared' WHERE messaging_group_id = 'mg-dc' AND agent_group_id = 'ag-voice'",
    );
    const key = await pairedKey(PERSON);

    for (const id of [callIdOf(quiet, '1234567890100000005'), callIdOf(scan, '1234567890100000006')])
      expect((await send('POST', `/v1/threads/${id}/call`, { key })).status).toBe(409);
    expect(await threadSessions()).toEqual([]);
  });

  it('lists every thread a task’s fires started, and leaves a fire’s lone post at the channel’s top level', async () => {
    await wire('mg-dc');
    const channelSession = await newSession({ messaging_group_id: 'mg-dc', thread_id: null });
    const day = 24 * 60 * 60_000;
    const sessionId = await taskPosting(
      'mention-scan',
      TASK_CHANNEL,
      '1234567890100000001',
      ['Mention scan, Tue.', 'Two asks in JIRA.'],
      ago(2 * day),
    );
    await taskFire(sessionId, TASK_CHANNEL, '1234567890100000002', ['Mention scan, Wed. No asks.'], ago(day));
    await taskFire(sessionId, TASK_CHANNEL, '1234567890100000003', ['**Mention scan, Thu.**', 'One ask.'], ago(60_000));
    const key = await pairedKey(PERSON);

    expect(await rowsShown(key)).toEqual([
      ['#general', ['Mention scan, Wed. No asks.']],
      ['Mention scan, Thu.', ['**Mention scan, Thu.**', 'One ask.']],
      ['Mention scan, Tue.', ['Mention scan, Tue.', 'Two asks in JIRA.']],
    ]);
    const callIds = new Map((await listThreads(key)).map((thread) => [thread.title, thread.agents[0].sessionId]));
    expect(callIds).toEqual(
      new Map([
        ['Mention scan, Thu.', callIdOf(sessionId, '1234567890100000003')],
        ['#general', channelSession],
        ['Mention scan, Tue.', callIdOf(sessionId, '1234567890100000001')],
      ]),
    );
    expect((await send('POST', `/v1/threads/${callIds.get('Mention scan, Tue.')}/call`, { key })).status).toBe(200);
    expect((await threadSessions()).map((session) => session.thread_id)).toEqual([`${CHANNEL_ID}:1234567890100000001`]);
    await searchable();
    expect((await listThreads(key, { q: 'scan, tue' })).map((thread) => thread.title)).toContain('Mention scan, Tue.');
  });

  it('reads a task’s record again once its current anchor is not in it, so the next fire’s thread has its post', async () => {
    await wire('mg-dc');
    const sessionId = await taskPosting('mention-scan', TASK_CHANNEL, '1234567890100000001', [
      'Mention scan, Tue.',
      'No asks.',
    ]);
    const key = await pairedKey(PERSON);
    expect(await rowsShown(key)).toEqual([['Mention scan, Tue.', ['Mention scan, Tue.', 'No asks.']]]);

    await taskFire(sessionId, TASK_CHANNEL, '1234567890100000002', ['Mention scan, Wed.', 'One ask.']);

    expect(await rowsShown(key)).toEqual([
      ['Mention scan, Tue.', ['Mention scan, Tue.', 'No asks.']],
      ['Mention scan, Wed.', ['Mention scan, Wed.', 'One ask.']],
    ]);
  });

  it('lists a task’s thread that only another bot archived posts under, as the rest of a split post', async () => {
    await wire('mg-dc');
    await taskPosting('meeting-digest', TASK_CHANNEL, '1234567890100000009', ['Meeting digest, Wed.']);
    await siblingCopy('2. Planning review: notes.', `${CHANNEL_ID}:1234567890100000009`);

    expect((await listThreads(await pairedKey(PERSON))).map((thread) => thread.title)).toEqual([
      'Meeting digest, Wed.',
    ]);
  });

  it('keeps at the channel’s top level the posts of a task that opens no listed thread', async () => {
    await newSession({ messaging_group_id: 'mg-dc', thread_id: null });
    const watch = await newSession({ messaging_group_id: null, thread_id: 'system:tasks:mention-watch' });
    initSessionFolder('ag-voice', watch);
    await taskFire(watch, TASK_CHANNEL, '1234567890100000007', ['New mention: the pricing sheet.', 'Its follow-up.']);
    await getDb().run('DELETE FROM task_thread_anchors WHERE session_id = ?', watch);
    await taskPosting('career-journal', TASK_CHANNEL, '1234567890100000008', ['Career journal, Wed.']);

    expect(await rowsShown(await pairedKey(PERSON))).toEqual([
      ['#general', ['New mention: the pricing sheet.', 'Career journal, Wed.']],
    ]);
  });

  it('keeps at the channel’s top level the posts of an agent wired there agent-shared, which no session’s group marks', async () => {
    await newSession({ messaging_group_id: 'mg-dc', thread_id: null });
    await getDb().run(
      "UPDATE messaging_group_agents SET session_mode = 'agent-shared' WHERE messaging_group_id = 'mg-dc'",
    );
    await said('Shared answer.', { ...TASK_CHANNEL, threadId: null, role: 'assistant' });

    expect(await rowsShown(await pairedKey(PERSON))).toEqual([['#general', ['Shared answer.']]]);
  });

  it('finds a task’s thread by the words of its anchor post, as its title shows them, once its channel is searchable', async () => {
    await wire('mg-dc');
    await taskPosting('meeting-prep', TASK_CHANNEL, '1234567890100000001', [
      '**Meeting prep, Thu.** Two docs.',
      'Budget review, 10:30.',
    ]);
    await taskPosting('career-journal', TASK_CHANNEL, '1234567890100000002', ['Career journal, Wed.', 'Shipped.']);
    const reader = 'discord:123456789000000603';
    await createUser({ id: reader, kind: 'discord', display_name: 'Lee Example', created_at: NOW });
    await memberOf('ag-voice', reader);
    H.visible.add(reader);
    const key = await pairedKey(reader);
    expect(await listThreads(key, { q: 'meeting PREP' })).toEqual([]);

    await searchable();
    for (const q of ['meeting PREP', 'Meeting prep, Thu. Two docs.'])
      expect((await listThreads(key, { q })).map((thread) => thread.title)).toEqual(['Meeting prep, Thu. Two docs.']);
  });

  it('finds a task’s thread by its anchor post’s words only within the tenant that post was archived in', async () => {
    await wire('mg-dc');
    await taskPosting('meeting-prep', TASK_CHANNEL, '1234567890100000001', ['Meeting prep, Thu.', 'Budget review.']);
    await inWorkgroup('ag-voice', 'globex', 'Globex');
    const reader = 'discord:123456789000000604';
    await createUser({ id: reader, kind: 'discord', display_name: 'Kim Example', created_at: NOW });
    await memberOf('ag-voice', reader);
    H.visible.add(reader);
    const key = await pairedKey(reader);
    await searchable();

    expect(await listThreads(key, { q: 'meeting prep' })).toEqual([]);
  });

  it('shows and searches a task’s thread by that thread alone, never by the title its session carries', async () => {
    await wire('mg-dc');
    const digest = await taskPosting('daily-digest', TASK_CHANNEL, '1234567890100000001', [
      'Daily digest.',
      'Quiet day.',
    ]);
    await setTitle(digest, 'Orchid acquisition', NOW);
    const key = await pairedKey(PERSON);
    expect((await listThreads(key)).map((thread) => thread.title)).toEqual(['Daily digest.']);
    expect(await listThreads(key, { q: 'orchid' })).toEqual([]);

    const archive = new Database(path.join(ARCHIVE_DIR, 'archive.db'));
    archive.prepare("DELETE FROM messages_archive WHERE text = 'Daily digest.'").run();
    archive.close();
    expect((await listThreads(key)).map((thread) => thread.title)).toEqual(['#general']);
  });

  it('dates a task’s thread by its anchor, so one from an old fire stays off while the series still runs', async () => {
    await wire('mg-dc');
    await taskPosting(
      'weekly-pulse',
      TASK_CHANNEL,
      '1234567890100000004',
      ['Weekly pulse.', 'Flat week.'],
      ago(30 * 24 * 60 * 60_000),
    );

    expect(await listThreads(await pairedKey(PERSON))).toEqual([]);
  });

  it('adds no thread for a task anchored in the person’s own DM, whose posts stay in the DM', async () => {
    await createMessagingGroup({
      id: 'mg-dm',
      channel_type: 'discord',
      platform_id: 'discord:@me:D2',
      name: 'Ana Example',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: NOW,
    });
    await upsertUserDm({ user_id: PERSON, channel_type: 'discord', messaging_group_id: 'mg-dm', resolved_at: NOW });
    await newSession({ messaging_group_id: 'mg-dm', thread_id: null });
    await taskPosting(
      'career-journal',
      { channelType: 'discord', platformId: 'discord:@me:D2' },
      '1234567890100000003',
      ['Career journal, Wed.'],
    );

    expect(await rowsShown(await pairedKey(PERSON))).toEqual([['DM with Juniper', ['Career journal, Wed.']]]);
  });
});

describe('replying in Slack as the person', () => {
  const TEAM = 'TEXAMPLE1';
  // One object: unregistering removes a bot only when handed the identity it was registered with.
  const BOT = { userId: 'U-BOT-A', username: 'a', teamId: TEAM };
  const THREAD = 'slack:C0TEST:1712345678.123456';
  const agentOf = (userId: string) => `approved-run-slack-send-${TEAM}-${userId.slice('slack:'.length)}`.toLowerCase();

  type Exchange = { teamId: string; userId: string; token: string; scopes: string[]; rotating: boolean };
  type Answer = { ok: boolean; error?: string; ts?: string };
  let exchangeAs: (code: string) => Exchange | { error: string };
  let slackAnswer: () => Promise<Answer>;
  let stored: Array<{ agent: string; injection: Record<string, unknown>; value: string }>;
  let revoked: string[];
  let posts: Array<{ agent: string; channel: string; text: string; threadTs?: string }>;
  let held: HeldSecret[];
  let askedWho: string[];
  let shares: Array<{ agent: string; channel: string; comment: string; threadTs: string }>;
  let shareAnswer: () => Promise<{ ok: boolean; error?: string }>;
  /** The token each reserved agent holds, and what Slack granted each token: its own scopes decide what it may do. */
  let vault: Map<string, string>;
  let granted: Map<string, string[]>;
  let sendIds = 0;

  beforeEach(() => {
    registerSlackBot('slack', BOT);
    sendSetup('client-example', TEAM);
    shares = [];
    shareAnswer = async () => ({ ok: true });
    vault = new Map();
    granted = new Map();
    stored = [];
    revoked = [];
    posts = [];
    held = [];
    askedWho = [];
    slackAnswer = async () => ({ ok: true, ts: '1712345699.000100' });
    // Slack signs in whoever the code names; by default the person the state was issued for.
    exchangeAs = (code) => ({
      teamId: TEAM,
      userId: code.slice('code-for-'.length),
      token: `xoxp-token-of-${code}`,
      scopes: ['chat:write'],
      rotating: false,
    });
    _setSlackSendDepsForTest({
      exchange: async (code) => {
        const answer = exchangeAs(code);
        if (!('error' in answer)) granted.set(answer.token, answer.scopes);
        return answer;
      },
      revoke: async (token) => void revoked.push(token),
      store: async (agent, injection, value) => {
        stored.push({ agent, injection: { ...injection }, value });
        vault.set(agent, value);
      },
      held: async () => held,
      apiFor: async (agent) => ({
        postMessage: async (channel: string, text: string, threadTs?: string) => {
          posts.push({ agent, channel, text, threadTs });
          return slackAnswer();
        },
        // Whatever token is asked about is the person's, so only the route's choice of source keeps it unused.
        authTest: async () => (askedWho.push(agent), { ok: true, userId: person.slice('slack:'.length), teamId: TEAM }),
        shareFiles: async (channel: string, _files: unknown[], opts: { threadTs: string; comment: string }) => {
          shares.push({ agent, channel, ...opts });
          const scopes = granted.get(vault.get(agent) ?? '') ?? [];
          return scopes.includes('files:write') ? shareAnswer() : { ok: false, error: FILES_NOT_ALLOWED };
        },
      }),
    });
  });

  afterEach(() => {
    unregisterSlackBot('slack', BOT);
    fs.rmSync(path.join(H.groupsDir, 'juniper'), { recursive: true, force: true });
    sendSetup(null, null);
    _setSlackSendDepsForTest(null);
    _resetSlackSendForTest();
    _resetReplyForTest();
  });

  const startConnect = async (key: string) => {
    const res = await send('POST', '/v1/slack/connect', { key });
    return { res, url: res.status === 200 ? new URL(parsed<{ url: string }>(res).url) : null };
  };
  /** Slack's redirect back, signed in as `slackUser`. */
  const callback = (state: string, slackUser: string) =>
    send('GET', `/slack/oauth/callback?code=code-for-${slackUser}&state=${encodeURIComponent(state)}`);
  const claimIn = (page: { body: string }) =>
    /anderton:\/\/slack-connected\?claim=([\w-]+)&amp;host=/.exec(page.body)?.[1];
  const redeem = (key: string, claim: string) =>
    send('POST', '/v1/slack/claim', { key, body: JSON.stringify({ claim }) });

  /** The real Connect flow end to end: start, Slack's redirect, the claim. */
  async function connected(userId: string): Promise<{ key: string; sendKey: string }> {
    const key = await pairedKey(userId);
    const { url } = await startConnect(key);
    const page = await callback(url!.searchParams.get('state')!, userId.slice('slack:'.length));
    const { sendKey } = parsed<{ sendKey: string }>(await redeem(key, claimIn(page)!));
    return { key, sendKey };
  }

  const reply = (sendKey: string, threadKey: string, text: string, extra: Record<string, unknown> = {}) =>
    send('POST', `/v1/threads/${threadKey}/messages`, {
      key: sendKey,
      body: JSON.stringify({ text, sendId: `send-id-${String((sendIds += 1)).padStart(8, '0')}`, ...extra }),
    });
  const read = (key: string, threadKey: string) => send('GET', `/v1/threads/${threadKey}/messages`, { key });

  async function threadKeyFor(key: string): Promise<string> {
    const [{ threadKey }] = await listThreads(key);
    return threadKey;
  }

  it('signs a person in to Slack for their own workspace, keeps their token for their reserved agent alone, and tells them', async () => {
    const key = await pairedKey(person);
    const { url } = await startConnect(key);

    expect(url!.origin + url!.pathname).toBe('https://slack.com/oauth/v2/authorize');
    expect(Object.fromEntries(url!.searchParams)).toEqual({
      client_id: 'client-example',
      user_scope: 'chat:write,files:write',
      redirect_uri: 'https://app.calls.example/slack/oauth/callback',
      state: expect.stringMatching(/^[\w-]{43}$/),
      team: TEAM,
    });

    const page = await callback(url!.searchParams.get('state')!, person.slice('slack:'.length));

    expect(page.status).toBe(200);
    expect(page.headers['content-security-policy']).toContain("default-src 'none'");
    expect(stored).toEqual([
      {
        agent: agentOf(person),
        injection: {
          name: `${agentOf(person)} token`,
          hostPattern: 'slack.com',
          pathPattern: '/api/*',
          headerName: 'Authorization',
          valueFormat: 'Bearer {value}',
        },
        value: `xoxp-token-of-code-for-${person.slice('slack:'.length)}`,
      },
    ]);
    expect(H.posts).toContainEqual(
      expect.objectContaining({ platformId: `dm:${person}`, text: expect.stringContaining('connected Slack') }),
    );
    expect(loggedText()).not.toContain('xoxp-');
  });

  it('replies in the person’s own Slack DM thread, into that DM, and in no one else’s', async () => {
    await createMessagingGroup({
      id: 'mg-dm',
      channel_type: 'slack',
      platform_id: 'slack:D0DM',
      name: 'Person 1',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: NOW,
    });
    await upsertUserDm({ user_id: person, channel_type: 'slack', messaging_group_id: 'mg-dm', resolved_at: NOW });
    await newSession({ messaging_group_id: 'mg-dm', thread_id: 'slack:D0DM:1712345678.123456' });
    const mine = await connected(person);
    const theirs = await connected(await newPerson());
    const threadKey = await threadKeyFor(mine.key);

    expect(parsed<{ reply?: string }>(await read(mine.key, threadKey)).reply).toBe('ready');
    expect((await reply(theirs.sendKey, threadKey, 'Not my DM')).status).toBe(404);
    expect((await reply(mine.sendKey, threadKey, 'Thanks')).status).toBe(200);
    expect(posts).toEqual([{ agent: agentOf(person), channel: 'D0DM', text: 'Thanks', threadTs: '1712345678.123456' }]);
  });

  describe('with a file', () => {
    const bothScopes = () => {
      const exchange = exchangeAs;
      exchangeAs = (code) => {
        const answer = exchange(code);
        return 'error' in answer ? answer : { ...answer, scopes: ['chat:write', 'files:write'] };
      };
    };

    it('shares a file as the person, into the thread the host verified, dated by its copy', async () => {
      bothScopes();
      await newSession({ thread_id: THREAD });
      const { key, sendKey } = await connected(person);
      const threadKey = await threadKeyFor(key);
      expect(parsed(await read(key, threadKey))).toMatchObject({ reply: 'ready', files: true });
      const copyAt = '2026-11-04T12:00:01.250Z';
      shareAnswer = async () => {
        await said('The screenshot.', {
          platformId: 'slack:C0TEST',
          threadId: THREAD,
          senderId: person,
          sentAt: copyAt,
        });
        return { ok: true };
      };
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(Date.parse('2026-11-04T12:00:00.000Z'));

      const res = await reply(sendKey, threadKey, 'The screenshot.', { files: [await uploaded(sendKey)] });
      vi.useRealTimers();

      expect([res.status, parsed(res)]).toEqual([200, { outcome: 'sent', postedAt: copyAt }]);
      expect(shares).toEqual([
        { agent: agentOf(person), channel: 'C0TEST', comment: 'The screenshot.', threadTs: '1712345678.123456' },
      ]);
      expect([posts, uploadsOnDisk()]).toEqual([[], []]);
    });

    it('replaces the one token when the person reconnects, so a reconnect granting chat:write alone asks again for a file', async () => {
      await newSession({ thread_id: THREAD });
      const exchange = exchangeAs;
      const grants = [['chat:write', 'files:write'], ['chat:write']];
      exchangeAs = (code) => {
        const answer = exchange(code);
        return 'error' in answer
          ? answer
          : { ...answer, token: `${answer.token}-${grants.length}`, scopes: grants.shift()! };
      };
      await connected(person);
      const { key, sendKey } = await connected(person);

      const file = await reply(sendKey, await threadKeyFor(key), 'The screenshot.', {
        files: [await uploaded(sendKey)],
      });

      expect(stored.map(({ agent }) => agent)).toEqual([agentOf(person), agentOf(person)]);
      expect([...vault.keys()]).toEqual([agentOf(person)]);
      expect(parsed(file)).toEqual({
        outcome: 'failed',
        error: 'Reconnect Slack to send files. Nothing was posted.',
        offerConnect: true,
      });
    });

    // An app build reads `reconnect` as "this phone's key is gone" and forgets it, so a refusal of files alone never
    // carries it: the key still sends words.
    it('keeps a token granted chat:write alone for words, and asks for a reconnect when it is sent a file', async () => {
      await newSession({ thread_id: THREAD });
      const { key, sendKey } = await connected(person);
      const threadKey = await threadKeyFor(key);

      const words = await reply(sendKey, threadKey, 'Words still go.');
      const file = await reply(sendKey, threadKey, 'The screenshot.', { files: [await uploaded(sendKey)] });

      expect(stored.map(({ injection }) => injection.pathPattern)).toEqual(['/api/*']);
      expect([words.status, parsed(words).outcome]).toEqual([200, 'sent']);
      const after = await reply(sendKey, threadKey, 'Words still go after it.');

      expect([file.status, parsed(file)]).toEqual([
        200,
        { outcome: 'failed', error: 'Reconnect Slack to send files. Nothing was posted.', offerConnect: true },
      ]);
      expect([after.status, parsed(after).outcome]).toEqual([200, 'sent']);
      expect(uploadsOnDisk()).toEqual([]);
    });
  });

  // The reserved name is what keeps a connected token from every agent group: a spawn whose container.json or workgroup
  // declares one aborts (`applyOnecliSecrets`), and the approved-run token guard removes any grant but its agent's.
  it('stores a token that ncl secrets grant refuses to give any agent group or workgroup, by its reserved name', async () => {
    await connected(person);
    const [{ agent, injection }] = stored;
    const name = injection.name as string;

    expect(reservedOwner(name)).toBe(agent);
    for (const grant of [
      { groups: ['ag-voice'], workgroups: [] },
      { groups: [], workgroups: ['wg-example'] },
    ]) {
      await expect(grantSecret({ name, ...grant, caller: { kind: 'host' } })).rejects.toThrow(
        `is reserved to OneCLI agent ${agent}`,
      );
    }
  });

  it('posts exactly the words, in the thread, under the token of the device’s own person, refusing a request that names any other', async () => {
    const other = await newPerson();
    await newSession({ thread_id: THREAD });
    const mine = await connected(person);
    const theirs = await connected(other);
    const threadKey = await threadKeyFor(mine.key);
    const words = '  On it — <@U0EXAMPLE> see https://example.com/a?b=1 *now* 🚀\n\nsecond line  ';

    const naming = await reply(mine.sendKey, threadKey, words, {
      userId: other,
      agent: agentOf(other),
      channel: 'C0OTHER',
    });
    const res = await reply(mine.sendKey, threadKey, words);
    await reply(theirs.sendKey, threadKey, 'theirs');

    expect([naming.status, parsed(naming)]).toEqual([400, { error: 'That request could not be read.' }]);
    expect([res.status, parsed(res)]).toEqual([200, { outcome: 'sent', postedAt: '2024-04-05T19:34:59.000Z' }]);
    expect(posts).toEqual([
      { agent: agentOf(person), channel: 'C0TEST', text: words, threadTs: '1712345678.123456' },
      { agent: agentOf(other), channel: 'C0TEST', text: 'theirs', threadTs: '1712345678.123456' },
    ]);
  });

  it('mentions the chosen agent’s bot once, ahead of the words as typed, and no one when the person picks no agent', async () => {
    await newSession({ thread_id: THREAD });
    const { key, sendKey } = await connected(person);
    const threadKey = await threadKeyFor(key);

    const chosen = await reply(sendKey, threadKey, 'checking in <@U0EXAMPLE>', { agentId: 'ag-voice' });
    const none = await reply(sendKey, threadKey, 'just a note', { agentId: null });

    expect([chosen.status, none.status]).toEqual([200, 200]);
    expect(posts.map(({ text }) => text)).toEqual(['<@U-BOT-A> checking in <@U0EXAMPLE>', 'just a note']);
  });

  it.each<[string, unknown]>([
    ['an agent group in no session of the thread', 'ag-quiet'],
    ['an agent group that does not exist', 'ag-nowhere'],
    ['something that is not an id', 7],
  ])('refuses %s as the agent with 400, posting nothing', async (_case, agentId) => {
    await newSession({ thread_id: THREAD });
    const { key, sendKey } = await connected(person);

    const res = await reply(sendKey, await threadKeyFor(key), 'hello', { agentId });

    expect(res.status).toBe(400);
    expect(posts).toEqual([]);
  });

  it('keeps no token Slack issued to anyone but the paired person in the set-up workspace, and revokes it', async () => {
    const signedIn = exchangeAs as (code: string) => Exchange;
    const cases: Array<(code: string) => Exchange> = [
      (code) => ({ ...signedIn(code), userId: 'U0EXAMPLE2' }),
      (code) => ({ ...signedIn(code), teamId: 'TOTHER1' }),
      (code) => ({ ...signedIn(code), scopes: ['users:read'] }),
      (code) => ({ ...signedIn(code), rotating: true }),
    ];
    for (const answer of cases) {
      exchangeAs = answer;
      const { url } = await startConnect(await pairedKey(person));
      const page = await callback(url!.searchParams.get('state')!, person.slice('slack:'.length));
      expect([page.status, page.body.includes('Nothing was connected'), claimIn(page)]).toEqual([409, true, undefined]);
    }
    expect(stored).toEqual([]);
    expect(revoked).toHaveLength(cases.length);
  });

  it('accepts each sign-in state once, within ten minutes, and shows a reload of its redirect the same page', async () => {
    const key = await pairedKey(person);
    const raw = person.slice('slack:'.length);
    const { url } = await startConnect(key);
    const state = url!.searchParams.get('state')!;
    const first = await callback(state, raw);
    const reloaded = await callback(state, raw);
    expect([first.status, reloaded.status]).toEqual([200, 200]);
    expect(claimIn(reloaded)).toBe(claimIn(first));
    const otherCode = await send('GET', `/slack/oauth/callback?code=another-code&state=${encodeURIComponent(state)}`);
    expect(otherCode.status).toBe(410);

    vi.useFakeTimers({ toFake: ['Date'] });
    const late = await startConnect(key);
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    expect((await callback(late.url!.searchParams.get('state')!, raw)).status).toBe(410);
    expect((await callback('a-state-never-issued', raw)).status).toBe(410);
    expect(stored).toHaveLength(1);
  });

  it('spends a sign-in state before the exchange, so two redirects with it exchange once', async () => {
    const key = await pairedKey(person);
    const { url } = await startConnect(key);
    const state = url!.searchParams.get('state')!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let exchanges = 0;
    const signedIn = exchangeAs;
    _setSlackSendDepsForTest({
      exchange: async (code) => {
        exchanges += 1;
        await held;
        return signedIn(code);
      },
    });

    const first = callback(state, person.slice('slack:'.length));
    await vi.waitFor(() => expect(exchanges).toBe(1));
    const second = await callback(state, person.slice('slack:'.length));
    release();

    expect([second.status, (await first).status, exchanges]).toEqual([410, 200, 1]);
  });

  it.each<[string, () => void, string]>([
    [
      'Slack cannot be reached',
      () => _setSlackSendDepsForTest({ exchange: () => Promise.reject(new Error('fetch failed')) }),
      'Slack could not be reached.',
    ],
    [
      'Slack refuses the code',
      () => _setSlackSendDepsForTest({ exchange: async () => ({ error: 'invalid_code' }) }),
      'Slack refused the sign-in (invalid_code).',
    ],
  ])('sets up no sending, and says so, when %s', async (_case, fail, says) => {
    const key = await pairedKey(person);
    const { url } = await startConnect(key);
    fail();

    const page = await callback(url!.searchParams.get('state')!, person.slice('slack:'.length));

    expect([page.status, page.body.includes(says), claimIn(page)]).toEqual([503, true, undefined]);
    expect(stored).toEqual([]);
  });

  const sendKeyHashes = async () =>
    (await getDb().all<{ send_key_hash: string | null }>('SELECT send_key_hash FROM mobile_devices')).map(
      (row) => row.send_key_hash,
    );

  it.each<[string, Error, string]>([
    [
      'the vault cannot confirm the token is the person’s alone',
      new ReservedTokenMayBeLive('two holders'),
      'may be stored',
    ],
    [
      'the vault refuses the token',
      new Error('vault down'),
      'could not finish setting up sending. Try again in a few minutes.',
    ],
  ])('issues no send key, and tells the phone why when it redeems, when %s', async (_case, error, says) => {
    const key = await pairedKey(person);
    const { url } = await startConnect(key);
    _setSlackSendDepsForTest({ store: () => Promise.reject(error) });

    const page = await callback(url!.searchParams.get('state')!, person.slice('slack:'.length));
    const first = await redeem(key, claimIn(page)!);
    const again = await redeem(key, claimIn(page)!);

    expect([page.status, first.status, parsed<{ error: string }>(first).error.includes(says), again.status]).toEqual([
      200,
      503,
      true,
      410,
    ]);
    expect(parsed<{ final?: boolean }>(first).final).toBe(true);
    expect(await sendKeyHashes()).toEqual([null]);
    expect(log.error).toHaveBeenCalledWith(
      'Mobile: Slack token could not be stored',
      expect.objectContaining({ err: error }),
    );
  });

  it('answers Slack before the token is stored, and issues the send key only once it is stored and checked', async () => {
    let finish: (() => void) | undefined;
    _setSlackSendDepsForTest({ store: () => new Promise<void>((resolve) => (finish = resolve)) });
    const key = await pairedKey(person);
    const { url } = await startConnect(key);

    const page = await callback(url!.searchParams.get('state')!, person.slice('slack:'.length));
    const redeeming = redeem(key, claimIn(page)!);
    await new Promise((resolve) => setTimeout(resolve, 200));
    const whileStoring = await sendKeyHashes();
    finish!();
    const redeemed = await redeeming;

    expect([
      page.status,
      page.body.includes('Tap Open Anderton to finish.'),
      page.body.includes('is connected'),
    ]).toEqual([200, true, false]);
    expect(whileStoring).toEqual([null]);
    const { sendKey } = parsed<{ sendKey: string }>(redeemed);
    expect(await sendKeyHashes()).toEqual([createHash('sha256').update(sendKey).digest('hex')]);
  });

  it('leaves a claim unspent when its token is still being stored, so the phone can ask again', async () => {
    _setClaimWaitForTest(50);
    let finish: (() => void) | undefined;
    _setSlackSendDepsForTest({ store: () => new Promise<void>((resolve) => (finish = resolve)) });
    const key = await pairedKey(person);
    const { url } = await startConnect(key);
    const claim = claimIn(await callback(url!.searchParams.get('state')!, person.slice('slack:'.length)))!;

    const early = await redeem(key, claim);
    finish!();
    const later = await redeem(key, claim);

    expect([early.status, parsed(early)]).toEqual([
      503,
      { error: 'Still finishing. Tap Open Anderton again in a moment.' },
    ]);
    expect([later.status, parsed(later)]).toEqual([200, { sendKey: expect.stringMatching(/^ncs_[\w-]{43}$/) }]);
  });

  it('opens the app with the claim by itself from the connected page, and from its button', async () => {
    const key = await pairedKey(person);
    const { url } = await startConnect(key);

    const page = await callback(url!.searchParams.get('state')!, person.slice('slack:'.length));

    const refresh = /<meta http-equiv="refresh" content="0;url=([^"]+)">/.exec(page.body)?.[1];
    expect(refresh).toMatch(/^anderton:\/\/slack-connected\?claim=[\w-]{43}&amp;host=app\.calls\.example$/);
    expect(/<a href="([^"]+)">Open Anderton<\/a>/.exec(page.body)?.[1]).toBe(refresh);
  });

  it('stores nothing when the person cancels on Slack', async () => {
    const key = await pairedKey(person);
    const { url } = await startConnect(key);

    const page = await send('GET', `/slack/oauth/callback?error=access_denied&state=${url!.searchParams.get('state')}`);

    expect([page.status, page.body.includes('cancelled'), claimIn(page)]).toEqual([200, true, undefined]);
    expect(stored).toEqual([]);
  });

  it('hands the send key only to the device that started the sign-in, the same key each time it asks', async () => {
    const key = await pairedKey(person);
    const otherDevice = await pairedKey(person);
    const { url } = await startConnect(key);
    const claim = claimIn(await callback(url!.searchParams.get('state')!, person.slice('slack:'.length)))!;

    expect((await redeem(otherDevice, claim)).status).toBe(410);
    const redeemed = await redeem(key, claim);
    expect([redeemed.status, parsed(redeemed)]).toEqual([200, { sendKey: expect.stringMatching(/^ncs_[\w-]{43}$/) }]);
    const again = await redeem(key, claim);
    expect([again.status, parsed(again)]).toEqual([200, parsed(redeemed)]);
    const { sendKey } = parsed<{ sendKey: string }>(redeemed);
    const rows = await getDb().all<{ send_key_hash: string | null }>(
      'SELECT send_key_hash FROM mobile_devices ORDER BY send_key_hash IS NULL',
    );
    expect(rows).toEqual([
      { send_key_hash: createHash('sha256').update(sendKey).digest('hex') },
      { send_key_hash: null },
    ]);
    expect(JSON.stringify(await getDb().all('SELECT * FROM mobile_devices'))).not.toContain(
      sendKey.slice('ncs_'.length),
    );
    const claims = vi
      .mocked(log.info)
      .mock.calls.filter(([message]) => message === 'Mobile: send key claim')
      .map(([, fields]) => (fields as { outcome: string }).outcome);
    expect(claims).toEqual(['unknown', 'redeemed', 'replayed']);
    expect(loggedText()).not.toContain(claim);
    expect(loggedText()).not.toContain(sendKey.slice('ncs_'.length));
  });

  it.each([
    ['a read key', 'read'],
    ['no key', 'none'],
  ])('never posts for %s, and a send key reads nothing', async (_case, which) => {
    await newSession({ thread_id: THREAD });
    const { key, sendKey } = await connected(person);
    const threadKey = await threadKeyFor(key);

    const res = await reply(which === 'read' ? key : '', threadKey, 'hello');

    expect(res.status).toBe(401);
    expect((await read(sendKey, threadKey)).status).toBe(401);
    expect((await send('GET', '/v1/threads', { key: sendKey })).status).toBe(401);
    expect(posts).toEqual([]);
  });

  it('stops both keys when the device is revoked', async () => {
    await newSession({ thread_id: THREAD });
    const { key, sendKey } = await connected(person);
    const threadKey = await threadKeyFor(key);

    expect((await send('DELETE', '/v1/device', { key })).status).toBe(200);

    expect((await reply(sendKey, threadKey, 'hello')).status).toBe(401);
    expect((await read(key, threadKey)).status).toBe(401);
    expect(posts).toEqual([]);
  });

  it('sends by the list’s fresh answer that the person can see the thread, and asks again once it lapses', async () => {
    await newSession({ thread_id: THREAD });
    const { key, sendKey } = await connected(person);
    const threadKey = await threadKeyFor(key);
    const checks = H.seeCalls;
    vi.useFakeTimers({ toFake: ['Date'] });
    H.visible.delete(person);

    const fresh = await reply(sendKey, threadKey, 'within ten minutes');
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    const lapsed = await reply(sendKey, threadKey, 'after they left');

    expect([fresh.status, lapsed.status, H.seeCalls - checks]).toEqual([200, 404, 1]);
    expect(posts.map(({ text }) => text)).toEqual(['within ten minutes']);
  });

  it('refuses a send when no fresh answer says the person can see the thread and the platform fails', async () => {
    await newSession({ thread_id: THREAD });
    const { key, sendKey } = await connected(person);
    const threadKey = await threadKeyFor(key);
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60_000 + 1 });
    H.seeFails = true;

    const res = await reply(sendKey, threadKey, 'hello');

    expect(res.status).toBe(404);
    expect(posts).toEqual([]);
  });

  const tryAgain = { outcome: 'sent', postedAt: '2024-04-05T19:34:59.000Z' };
  it.each<[string, () => Promise<Answer>, Record<string, unknown>, Record<string, unknown> | null]>([
    [
      'posts it',
      async () => ({ ok: true, ts: '1712345699.000100' }),
      { outcome: 'sent', postedAt: '2024-04-05T19:34:59.000Z' },
      null,
    ],
    [
      'does not answer',
      async () => ({ ok: false, error: 'no_answer' }),
      { outcome: 'unknown', error: expect.stringContaining('may have posted') },
      { outcome: 'unknown', error: expect.stringContaining('change the words') },
    ],
    [
      'refuses it',
      async () => ({ ok: false, error: 'channel_not_found' }),
      { outcome: 'failed', error: 'Slack refused it (channel_not_found). Nothing was posted.' },
      tryAgain,
    ],
    [
      'no longer takes the token',
      async () => ({ ok: false, error: 'token_revoked' }),
      { outcome: 'failed', error: expect.stringContaining('Connect Slack again'), reconnect: true, offerConnect: true },
      tryAgain,
    ],
    [
      'is never reached, because the gateway gives no identity',
      async () => ({ ok: false, error: 'no gateway identity', local: true }),
      { outcome: 'failed', error: 'The host could not reach Slack. Nothing was posted.' },
      tryAgain,
    ],
  ])(
    'reports what happened when Slack %s, and posts the same sendId again only if nothing was posted',
    async (_case, answer, outcome, repeat) => {
      await newSession({ thread_id: THREAD });
      const { key, sendKey } = await connected(person);
      const threadKey = await threadKeyFor(key);
      slackAnswer = answer;
      const body = JSON.stringify({ text: 'hello', sendId: 'send-id-repeated-0001' });
      const post = () => send('POST', `/v1/threads/${threadKey}/messages`, { key: sendKey, body });

      const first = await post();
      slackAnswer = async () => ({ ok: true, ts: '1712345699.000100' });
      const repeated = await post();

      expect([first.status, parsed(first)]).toEqual([200, outcome]);
      expect(parsed(repeated)).toEqual(repeat ?? outcome);
      expect(posts).toHaveLength(repeat === tryAgain ? 2 : 1);
    },
  );

  it('answers a second request for a reply still sending as unknown, without posting it again', async () => {
    await newSession({ thread_id: THREAD });
    const { key, sendKey } = await connected(person);
    const threadKey = await threadKeyFor(key);
    let answer!: (value: Answer) => void;
    slackAnswer = () => new Promise((resolve) => (answer = resolve));
    const body = JSON.stringify({ text: 'hello', sendId: 'send-id-in-flight-0001' });
    const post = () => send('POST', `/v1/threads/${threadKey}/messages`, { key: sendKey, body });

    const first = post();
    await vi.waitFor(() => expect(posts).toHaveLength(1));
    const second = await post();
    answer({ ok: true, ts: '1712345699.000100' });

    expect([second.status, parsed(second)]).toEqual([
      200,
      { outcome: 'unknown', error: 'That reply is still sending. Check the thread in a moment.' },
    ]);
    expect(parsed(await first)).toEqual({ outcome: 'sent', postedAt: '2024-04-05T19:34:59.000Z' });
    expect(posts).toHaveLength(1);
  });

  it('answers 429 past ten replies a minute from one device, counting only replies about to post', async () => {
    await newSession({ thread_id: THREAD });
    const { key, sendKey } = await connected(person);
    const threadKey = await threadKeyFor(key);
    vi.useFakeTimers({ toFake: ['Date'] });
    for (let refused = 0; refused < 3; refused += 1)
      expect((await reply(sendKey, 'AAAAAAAAAAAAAAAAAAAAAA', 'hello')).status).toBe(404);
    for (let sent = 0; sent < 10; sent += 1) expect((await reply(sendKey, threadKey, 'hello')).status).toBe(200);

    const limited = await reply(sendKey, threadKey, 'hello');

    expect(limited.status).toBe(429);
    expect(posts).toHaveLength(10);
    vi.setSystemTime(Date.now() + 60_001);
    expect((await reply(sendKey, threadKey, 'hello')).status).toBe(200);
  });

  it.each([
    ['blank text', { text: ' \n ', sendId: 'send-id-blank-000001' }, 400],
    ['text over 4,000 characters', { text: 'x'.repeat(4001), sendId: 'send-id-long-0000001' }, 413],
    ['no send id', { text: 'hello' }, 400],
    ['text that is not a string', { text: 7, sendId: 'send-id-number-00001' }, 400],
  ])('refuses %s without posting', async (_case, body, status) => {
    await newSession({ thread_id: THREAD });
    const { key, sendKey } = await connected(person);
    const threadKey = await threadKeyFor(key);

    const res = await send('POST', `/v1/threads/${threadKey}/messages`, { key: sendKey, body: JSON.stringify(body) });

    expect(res.status).toBe(status);
    expect(posts).toEqual([]);
  });

  it('accepts 4,000 characters that escape to more than 4 KB of JSON', async () => {
    await newSession({ thread_id: THREAD });
    const { key, sendKey } = await connected(person);
    const words = '\u0001'.repeat(4000);

    const res = await reply(sendKey, await threadKeyFor(key), words);

    expect(res.status).toBe(200);
    expect(posts.map((post) => post.text)).toEqual([words]);
  });

  it('offers Connect Slack, then the reply box, on a Slack thread in the set-up workspace', async () => {
    await newSession({ thread_id: THREAD });
    const key = await pairedKey(person);
    const threadKey = await threadKeyFor(key);
    expect(parsed(await read(key, threadKey)).reply).toBe('connect');

    const { url } = await startConnect(key);
    const claim = claimIn(await callback(url!.searchParams.get('state')!, person.slice('slack:'.length)))!;
    await redeem(key, claim);

    expect(parsed(await read(key, threadKey)).reply).toBe('ready');
  });

  it('posts in the send app’s workspace only under the token the person connected, whatever a group there holds', async () => {
    declareSecrets('juniper', [USER_TOKEN.name]);
    held = [USER_TOKEN];
    await newSession({ thread_id: THREAD });
    const unconnected = await pairedKey(person);
    const threadKey = await threadKeyFor(unconnected);

    expect(parsed(await read(unconnected, threadKey))).toMatchObject({ reply: 'connect', unlock: 'connect' });
    expect((await send('POST', '/v1/replies/enable', { key: unconnected })).status).toBe(409);
    const { sendKey } = await connected(person);
    expect((await reply(sendKey, threadKey, 'Through my own sign-in.')).status).toBe(200);
    expect(posts.map((row) => row.agent)).toEqual([agentOf(person)]);
    expect(askedWho).toEqual([]);
  });

  it.each<[string, () => Promise<unknown>]>([
    ['the host has no Slack app set up', async () => sendSetup('', TEAM)],
    ['the person’s workspace is not the set-up one', async () => sendSetup('client-example', 'TOTHER1')],
    ['the session holds the channel, not a thread', () => getDb().run('UPDATE sessions SET thread_id = NULL')],
  ])('offers no reply and refuses to send when %s', async (_case, change) => {
    await newSession({ thread_id: THREAD });
    const { key, sendKey } = await connected(person);
    await change();
    const threadKey = await threadKeyFor(key);

    expect(parsed(await read(key, threadKey))).not.toHaveProperty('reply');
    expect((await reply(sendKey, threadKey, 'hello')).status).toBe(409);
    expect(posts).toEqual([]);
  });

  it('names the token after the person exactly, lowercased, and refuses a pair of ids too long to fit', async () => {
    const withUserId = async (raw: string) => {
      const id = `slack:${raw}`;
      await createUser({ id, kind: 'slack', display_name: 'Long Id', created_at: NOW });
      await memberOf('ag-voice', id);
      H.visible.add(id);
      return id;
    };
    // `approved-run-` leaves 63 characters, and `slack-send-TEXAMPLE1-` takes 21 of them.
    const fits = await withUserId(`U${'A'.repeat(41)}`);
    const tooLong = await withUserId(`U${'A'.repeat(42)}`);

    await connected(fits);
    const refused = await startConnect(await pairedKey(tooLong));

    expect(stored.map((row) => row.agent)).toEqual([`approved-run-slack-send-texample1-u${'a'.repeat(41)}`]);
    expect([refused.res.status, refused.url]).toEqual([409, null]);
  });

  it('refuses to start a sign-in for a person outside the set-up workspace', async () => {
    sendSetup('client-example', 'TOTHER1');
    const key = await pairedKey(person);

    const { res } = await startConnect(key);

    expect([res.status, parsed(res)]).toEqual([
      409,
      { error: 'Replying from the app is not available for this account.' },
    ]);
  });
});

describe('replying in Slack with a token the workspace’s agents hold', () => {
  const TEAM = 'TWORKSPACE1';
  const BOT = { userId: 'U-BOT-B', username: 'b', teamId: TEAM };
  const THREAD = 'slack:C0TEST:1712345678.123456';
  const TS = '1712345678.123456';
  const raw = (userId: string) => userId.slice('slack:'.length);

  type Who = { ok: boolean; error?: string; userId?: string; teamId?: string; scopes?: string[] };
  let held: Map<string, HeldSecret[] | Error>;
  let whoAmI: Who;
  let postAnswer: { ok: boolean; error?: string; ts?: string };
  let calls: Array<{ agent: string; method: string; channel?: string; text?: string; threadTs?: string }>;
  /** What happens in the thread while Slack shares a file, such as its copy landing in the archive. */
  let onShare: () => Promise<void>;
  let sendIds = 0;

  beforeEach(() => {
    registerSlackBot('slack', BOT);
    // The host has a send app, for another workspace: this one has none.
    sendSetup('client-example', 'TOTHERTEAM1');
    declareSecrets('juniper', [USER_TOKEN.name, FILES_TOKEN.name]);
    held = new Map([['ag-voice', [USER_TOKEN, FILES_TOKEN]]]);
    whoAmI = { ok: true, userId: raw(person), teamId: TEAM };
    postAnswer = { ok: true, ts: '1712345699.000100' };
    calls = [];
    onShare = async () => undefined;
    _setSlackSendDepsForTest({
      held: async (agent) => {
        const secrets = held.get(agent) ?? [];
        if (secrets instanceof Error) throw secrets;
        return secrets;
      },
      apiFor: async (agent) => ({
        authTest: async () => (calls.push({ agent, method: 'authTest' }), whoAmI),
        postMessage: async (channel: string, text: string, threadTs?: string) => (
          calls.push({ agent, method: 'postMessage', channel, text, threadTs }),
          postAnswer
        ),
        shareFiles: async (channel: string, _files: unknown[], opts: { threadTs: string; comment: string }) => {
          calls.push({ agent, method: 'shareFiles', channel, text: opts.comment, threadTs: opts.threadTs });
          await onShare();
          return { ok: true };
        },
      }),
    });
  });

  afterEach(() => {
    unregisterSlackBot('slack', BOT);
    fs.rmSync(path.join(H.groupsDir, 'juniper'), { recursive: true, force: true });
    sendSetup(null, null);
    _setSlackSendDepsForTest(null);
    _resetSlackSendForTest();
    _resetReplyForTest();
    _resetUploadsForTest();
  });

  const enableLink = (key: string) => send('POST', '/v1/replies/enable', { key });
  const linkClaim = () => /https:\/\/app\.calls\.example\/replies#([\w-]{43})\n/.exec(H.posts.at(-1)?.text ?? '')?.[1];
  const read = async (key: string, threadKey: string) =>
    parsed(await send('GET', `/v1/threads/${threadKey}/messages`, { key }));
  const reply = (sendKey: string, threadKey: string, text: string, extra: Record<string, unknown> = {}) =>
    send('POST', `/v1/threads/${threadKey}/messages`, {
      key: sendKey,
      body: JSON.stringify({ text, sendId: `slack-group-${String((sendIds += 1)).padStart(8, '0')}`, ...extra }),
    });

  /** The real way in: the DMed link, redeemed by the phone that asked. */
  async function enabled(userId: string): Promise<{ key: string; sendKey: string; threadKey: string }> {
    const key = await pairedKey(userId);
    expect((await enableLink(key)).status).toBe(200);
    const res = await send('POST', '/v1/slack/claim', { key, body: JSON.stringify({ claim: linkClaim() }) });
    const [{ threadKey }] = await listThreads(key);
    return { key, sendKey: parsed<{ sendKey: string }>(res).sendKey, threadKey };
  }

  it('sets a phone up by a link DMed to the person, and leaves the send app’s workspace to Connect', async () => {
    await newSession({ thread_id: THREAD });
    const key = await pairedKey(person);
    const [{ threadKey }] = await listThreads(key);
    expect(await read(key, threadKey)).toMatchObject({ reply: 'enable', unlock: 'enable' });

    expect((await enableLink(key)).status).toBe(200);
    expect(H.posts.at(-1)).toMatchObject({ platformId: `dm:${person}`, text: expect.stringContaining('/replies#') });

    sendSetup('client-example', TEAM);
    const refused = await enableLink(await pairedKey(person));
    expect([refused.status, parsed(refused)]).toEqual([
      409,
      { error: 'Replying from the app is not available for this account.' },
    ]);
  });

  it('posts through the group’s own identity, which also holds the files.slack.com token, asking Slack on each send whose token it is', async () => {
    const other = await newPerson();
    await newSession({ thread_id: THREAD });
    const { key, sendKey, threadKey } = await enabled(person);
    expect(await read(key, threadKey)).toMatchObject({ reply: 'ready', unlock: 'enable' });
    calls = [];

    const first = await reply(sendKey, threadKey, 'Shipping now.');
    const naming = await reply(sendKey, threadKey, 'Elsewhere.', {
      userId: other,
      agent: 'ag-sibling',
      teamId: 'TOTHER1',
      channel: 'C0OTHER',
    });
    const second = await reply(sendKey, threadKey, 'Notes to follow.');

    expect([first.status, parsed(first), naming.status, second.status]).toEqual([
      200,
      { outcome: 'sent', postedAt: '2024-04-05T19:34:59.000Z' },
      400,
      200,
    ]);
    expect(calls).toEqual([
      { agent: 'ag-voice', method: 'authTest' },
      { agent: 'ag-voice', method: 'postMessage', channel: 'C0TEST', text: 'Shipping now.', threadTs: TS },
      { agent: 'ag-voice', method: 'authTest' },
      { agent: 'ag-voice', method: 'postMessage', channel: 'C0TEST', text: 'Notes to follow.', threadTs: TS },
    ]);
  });

  // The group's identity is how its agents act as the person in Slack, reading, posting and moving files both ways, so
  // the phone only uses it: what it holds is read through `held` alone, and any other OneCLI call could change it.
  it('makes no OneCLI call of its own and leaves the group’s container.json as it was, through a setup, words and a file', async () => {
    await newSession({ thread_id: THREAD });
    whoAmI = { ...whoAmI, scopes: ['chat:write', 'files:write'] };
    const declared = path.join(H.groupsDir, 'juniper', 'container.json');
    const before = fs.readFileSync(declared, 'utf8');
    H.onecliCalls = [];

    const { sendKey, threadKey } = await enabled(person);
    const words = await reply(sendKey, threadKey, 'Shipping now.');
    const file = await reply(sendKey, threadKey, 'The screenshot.', { files: [await uploaded(sendKey)] });

    expect([parsed(words).outcome, parsed(file).outcome]).toEqual(['sent', 'sent']);
    expect(calls.map(({ agent, method }) => `${agent} ${method}`)).toEqual([
      'ag-voice authTest',
      'ag-voice postMessage',
      'ag-voice authTest',
      'ag-voice shareFiles',
    ]);
    expect(H.onecliCalls).toEqual([]);
    expect(fs.readFileSync(declared, 'utf8')).toBe(before);
  });

  it('shares files as the person, the words as their comment, dated by their copy that says those words', async () => {
    await newSession({ thread_id: THREAD });
    whoAmI = { ...whoAmI, scopes: ['chat:write', 'files:write'] };
    const { key, sendKey, threadKey } = await enabled(person);
    expect(await read(key, threadKey)).toMatchObject({ reply: 'ready', files: true });
    calls = [];
    const copyAt = '2026-11-04T12:00:01.250Z';
    const at = { platformId: 'slack:C0TEST', threadId: THREAD, senderId: person };
    onShare = async () => {
      await said('Typed in Slack meanwhile.', { ...at, sentAt: '2026-11-04T12:00:00.500Z' });
      await said('The *screenshot*.', { ...at, sentAt: copyAt });
    };
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse('2026-11-04T12:00:00.000Z'));

    const res = await reply(sendKey, threadKey, 'The screenshot.', { files: [await uploaded(sendKey)] });
    onShare = async () => undefined;
    const alone = await reply(sendKey, threadKey, '', { files: [await uploaded(sendKey)] });
    vi.useRealTimers();

    expect([res.status, parsed(res)]).toEqual([200, { outcome: 'sent', postedAt: copyAt }]);
    expect([alone.status, parsed(alone)]).toEqual([200, { outcome: 'sent', postedAt: '2026-11-04T12:00:00.000Z' }]);
    expect(calls).toEqual([
      { agent: 'ag-voice', method: 'authTest' },
      { agent: 'ag-voice', method: 'shareFiles', channel: 'C0TEST', text: 'The screenshot.', threadTs: TS },
      { agent: 'ag-voice', method: 'authTest' },
      { agent: 'ag-voice', method: 'shareFiles', channel: 'C0TEST', text: '', threadTs: TS },
    ]);
    expect(uploadsOnDisk()).toEqual([]);
  });

  it('takes no message from before the share was asked for as its copy, and none that a second one just after unsettles', async () => {
    await newSession({ thread_id: THREAD });
    whoAmI = { ...whoAmI, scopes: ['chat:write', 'files:write'] };
    const { sendKey, threadKey } = await enabled(person);
    const at = { platformId: 'slack:C0TEST', threadId: THREAD, senderId: person };
    const later = (ms: number) => new Date(Date.now() + ms).toISOString();
    let sharingFrom = '';
    _setSlackSendDepsForTest({
      apiFor: async (agent) => ({
        authTest: async () => (calls.push({ agent, method: 'authTest' }), whoAmI),
        postMessage: async () => postAnswer,
        shareFiles: async () => {
          await onShare();
          return { ok: true, sharingFrom };
        },
      }),
    });
    let copyAt = '';
    // Typed in Slack while a three-second upload ran, then the share's own copy.
    onShare = async () => {
      await said('The screenshot.', { ...at, sentAt: later(0) });
      sharingFrom = later(3_000);
      copyAt = later(3_300);
      await said('The screenshot.', { ...at, sentAt: copyAt });
    };
    const res = await reply(sendKey, threadKey, 'The screenshot.', { files: [await uploaded(sendKey)] });
    onShare = async () => {
      sharingFrom = later(0);
      await said('Again.', { ...at, sentAt: later(100) });
      setTimeout(() => void said('Again.', { ...at, sentAt: later(700) }), 500);
    };
    const unsettled = await reply(sendKey, threadKey, 'Again.', { files: [await uploaded(sendKey)] });

    expect([parsed(res), parsed(unsettled)]).toEqual([{ outcome: 'sent', postedAt: copyAt }, { outcome: 'sent' }]);
  });

  it('leaves a share undated when two of the person’s messages could be its copy, or none says its words', async () => {
    await newSession({ thread_id: THREAD });
    whoAmI = { ...whoAmI, scopes: ['chat:write', 'files:write'] };
    const { sendKey, threadKey } = await enabled(person);
    _setCopyWaitForTest(0);
    const at = { platformId: 'slack:C0TEST', threadId: THREAD, senderId: person };
    onShare = async () => {
      await said('Same words.', { ...at, sentAt: new Date(Date.now() + 100).toISOString() });
      await said('Same words.', { ...at, sentAt: new Date(Date.now() + 200).toISOString() });
    };
    const twice = await reply(sendKey, threadKey, 'Same words.', { files: [await uploaded(sendKey)] });
    onShare = async () => {
      await said('Something else.', at);
    };
    const neither = await reply(sendKey, threadKey, 'The screenshot.', { files: [await uploaded(sendKey)] });

    expect([parsed(twice), parsed(neither)]).toEqual([{ outcome: 'sent' }, { outcome: 'sent' }]);
  });

  it('keeps a share that posted as posted when looking up its copy fails, so the same send id never shares again', async () => {
    await newSession({ thread_id: THREAD });
    whoAmI = { ...whoAmI, scopes: ['chat:write', 'files:write'] };
    const { sendKey, threadKey } = await enabled(person);
    _setSlackSendDepsForTest({
      copyAt: async () => {
        throw new Error('SQLITE_BUSY');
      },
    });
    calls = [];
    const sendId = 'slack-group-copy-fails-01';

    const first = await reply(sendKey, threadKey, 'The screenshot.', { sendId, files: [await uploaded(sendKey)] });
    const again = await reply(sendKey, threadKey, 'The screenshot.', { sendId, files: [await uploaded(sendKey)] });

    expect([parsed(first), parsed(again)]).toEqual([{ outcome: 'sent' }, { outcome: 'sent' }]);
    expect(calls.filter(({ method }) => method === 'shareFiles')).toHaveLength(1);
    expect(uploadsOnDisk()).toEqual([]);
  });

  it('refuses files when the group’s token cannot send them, asking for a reconnect, and posts nothing', async () => {
    await newSession({ thread_id: THREAD });
    whoAmI = { ...whoAmI, scopes: ['chat:write', 'files:read'] };
    const { key, sendKey, threadKey } = await enabled(person);
    expect(await read(key, threadKey)).not.toHaveProperty('files');
    calls = [];

    const res = await reply(sendKey, threadKey, 'The screenshot.', { files: [await uploaded(sendKey)] });

    expect([res.status, parsed(res)]).toEqual([
      200,
      {
        outcome: 'failed',
        error: 'This Slack token cannot send files. Reconnect Slack to send files. Nothing was posted.',
      },
    ]);
    expect(calls).toEqual([{ agent: 'ag-voice', method: 'authTest' }]);
    expect(uploadsOnDisk()).toEqual([]);
  });

  it('reports a token Slack stops taking between its check and the post as refused, offering no Connect', async () => {
    await newSession({ thread_id: THREAD });
    const { sendKey, threadKey } = await enabled(person);
    postAnswer = { ok: false, error: 'token_revoked' };

    const res = await reply(sendKey, threadKey, 'Mine to send.');

    expect(parsed(res)).toEqual({ outcome: 'failed', error: 'Slack refused it (token_revoked). Nothing was posted.' });
  });

  it('offers no reply box and posts nothing when Slack says the token is another member’s or another workspace’s, or will not say', async () => {
    await newSession({ thread_id: THREAD });
    const member = await newPerson();
    const { key, sendKey, threadKey } = await enabled(member);
    const answers: Who[] = [
      { ok: true, userId: raw(person), teamId: TEAM },
      { ok: true, userId: raw(member), teamId: 'TOTHER1' },
      { ok: false, error: 'no_answer' },
    ];

    for (const answer of answers) {
      whoAmI = answer;
      _resetSlackSendForTest();
      const view = await read(key, threadKey);
      const res = await reply(sendKey, threadKey, 'Mine to send.');
      expect([view.reply ?? null, res.status]).toEqual([null, 409]);
    }
    expect(calls.filter((call) => call.method === 'postMessage')).toEqual([]);
  });

  it('asks Slack nothing and offers no reply box unless the group’s identity holds one secret for slack.com, its declared token', async () => {
    const second: HeldSecret = { id: 'secret-second', name: 'Slack-User-Token-Second', hostPattern: 'slack.com' };
    declareSecrets('juniper', [USER_TOKEN.name, second.name, FILES_TOKEN.name]);
    await newSession({ thread_id: THREAD });
    const { key, sendKey, threadKey } = await enabled(person);
    const holdings: Array<HeldSecret[] | Error> = [
      [USER_TOKEN, second],
      [{ ...USER_TOKEN, id: 'secret-bot', name: 'Slack-Bot-Token-Example' }],
      [USER_TOKEN, { id: 'secret-anywhere', name: 'Anywhere', hostPattern: '*' }],
      [USER_TOKEN, { id: 'secret-unlisted', name: '', hostPattern: null }],
      [{ ...USER_TOKEN, hostPattern: '*' }],
      [{ ...USER_TOKEN, hostPattern: null }],
      new Error('vault unreadable'),
    ];

    for (const holding of holdings) {
      held.set('ag-voice', holding);
      _resetSlackSendForTest();
      const view = await read(key, threadKey);
      const res = await reply(sendKey, threadKey, 'Mine to send.');
      expect([view.reply ?? null, res.status]).toEqual([null, 409]);
    }
    expect(calls).toEqual([]);
  });

  it('skips a group whose config cannot be read, for a sibling there that proves', async () => {
    fs.writeFileSync(path.join(H.groupsDir, 'juniper', 'container.json'), 'null');
    declareSecrets('aster', [USER_TOKEN.name]);
    held.set('ag-sibling', [USER_TOKEN]);
    await shareWorkgroup();
    await memberOf('ag-sibling');
    await newSession({ agent_group_id: 'ag-sibling', thread_id: THREAD, last_active: NOW });
    await newSession({ thread_id: THREAD });
    const { key, sendKey, threadKey } = await enabled(person);

    expect(await read(key, threadKey)).toMatchObject({ reply: 'ready', unlock: 'enable' });
    expect((await reply(sendKey, threadKey, 'Mine to send.')).status).toBe(200);
    expect(calls.filter((call) => call.method === 'postMessage').map((call) => call.agent)).toEqual(['ag-sibling']);
  });

  it('does not keep a check that failed, so the next screen asks again', async () => {
    await newSession({ thread_id: THREAD });
    const { key, threadKey } = await enabled(person);
    held.set('ag-voice', new Error('vault unreadable'));
    expect((await read(key, threadKey)).reply ?? null).toBe(null);

    held.set('ag-voice', [USER_TOKEN, FILES_TOKEN]);

    expect(await read(key, threadKey)).toMatchObject({ reply: 'ready' });
  });
});

describe('replying in Discord under the person’s name', () => {
  const RAW = '123456789000000501';
  const PERSON = `discord:${RAW}`;
  const PLATFORM = 'discord:G1:C1';
  const THREAD = 'discord:G1:C1:T1';
  const BOTS: Record<string, string> = { discord: '111111111111111111', 'discord-codex': '222222222222222222' };
  const NAME_LINE = '**Ana Example** · from the Anderton app';

  type Answer = { messageId?: string; unknown?: true; error?: string };
  type PostedFile = { name: string; type: string; bytes: string };
  let posted: Array<{ channelType: string; threadId: string; body: Record<string, unknown>; files?: PostedFile[] }>;
  let routed: Array<import('../../channels/adapter.js').InboundEvent>;
  let discordAnswer: () => Promise<Answer>;
  let canPost: boolean;
  let canAttach: boolean;
  let posterName: string | null;
  /** The reply's files vanish from the host's disk once the posting check has passed. */
  let filesVanish: boolean;
  let sendIds = 0;

  beforeEach(async () => {
    posted = [];
    routed = [];
    canPost = true;
    canAttach = true;
    filesVanish = false;
    posterName = 'Ana Example';
    discordAnswer = async () => ({ messageId: `1234567890${String(posted.length).padStart(8, '0')}` });
    await createUser({ id: PERSON, kind: 'discord', display_name: 'Ana In Db', created_at: NOW });
    await memberOf('ag-voice', PERSON);
    await memberOf('ag-sibling', PERSON);
    H.visible.add(PERSON);
    await shareWorkgroup();
    await channel('mg-dc', PLATFORM, 'discord', 'general');
    await channel('mg-dc-codex', PLATFORM, 'discord-codex', 'general');
    _setDiscordSendDepsForTest({ ...discord, route: async (event) => void routed.push(event) });
  });

  /** Discord at the transport boundary: who could post where, the post itself, and the bots' own ids. */
  const discord: Parameters<typeof _setDiscordSendDepsForTest>[0] = {
    poster: async (place, _channelType, userId) => {
      if (filesVanish) fs.rmSync(UPLOADS, { recursive: true, force: true });
      return canPost && place.threadId === 'T1' && userId === RAW ? { name: posterName, files: canAttach } : null;
    },
    post: async (channelType, threadId, body, files = []) => {
      const sent = files.map(({ path: at, name, type }) => ({ name, type, bytes: fs.readFileSync(at).toString() }));
      posted.push({ channelType, threadId, body, ...(sent.length > 0 ? { files: sent } : {}) });
      return discordAnswer();
    },
    botUserId: async (channelType) => BOTS[channelType],
  };

  afterEach(() => {
    _setDiscordSendDepsForTest(null);
    _resetDiscordSendForTest();
    _resetReplyForTest();
    _resetRelayPostsForTest();
    _resetUploadsForTest();
  });

  /** A session of `agent` in the thread, engaged `engagedAgo` ms ago when given. */
  async function inThread(agent: 'ag-voice' | 'ag-sibling' = 'ag-voice', engagedAgo: number | null = 60_000) {
    const sibling = agent === 'ag-sibling';
    const id = await newSession({
      agent_group_id: agent,
      messaging_group_id: sibling ? 'mg-dc-codex' : 'mg-dc',
      thread_id: THREAD,
    });
    if (engagedAgo !== null) await getDb().run('UPDATE sessions SET engaged_at = ? WHERE id = ?', ago(engagedAgo), id);
    return id;
  }

  const postedBy = (agent: 'ag-voice' | 'ag-sibling', sentAgo: number) =>
    said('An agent’s post.', {
      agent,
      channelType: agent === 'ag-sibling' ? 'discord-codex' : 'discord',
      platformId: PLATFORM,
      threadId: THREAD,
      role: 'assistant',
      senderId: agent,
      sentAt: ago(sentAgo),
    });

  const redeem = (key: string, claim: string) =>
    send('POST', '/v1/slack/claim', { key, body: JSON.stringify({ claim }) });
  const linkClaim = () => /https:\/\/app\.calls\.example\/replies#([\w-]{43})\n/.exec(H.posts.at(-1)?.text ?? '')?.[1];

  /** The real way in: the DMed link, redeemed by the phone that asked. */
  async function enabled(): Promise<{ key: string; sendKey: string; threadKey: string }> {
    const key = await pairedKey(PERSON);
    expect((await send('POST', '/v1/replies/enable', { key })).status).toBe(200);
    const { sendKey } = parsed<{ sendKey: string }>(await redeem(key, linkClaim()!));
    const [{ threadKey }] = await listThreads(key);
    return { key, sendKey, threadKey };
  }

  const reply = (sendKey: string, threadKey: string, text: string, extra: Record<string, unknown> = {}) =>
    send('POST', `/v1/threads/${threadKey}/messages`, {
      key: sendKey,
      body: JSON.stringify({ text, sendId: `discord-send-${String((sendIds += 1)).padStart(8, '0')}`, ...extra }),
    });
  const read = async (key: string, threadKey: string) =>
    parsed(await send('GET', `/v1/threads/${threadKey}/messages`, { key }));

  it('turns on replies only by a link DMed to the person, which just the phone that asked can redeem, for one key', async () => {
    await inThread();
    const key = await pairedKey(PERSON);
    const otherPhone = await pairedKey(PERSON);
    const [{ threadKey }] = await listThreads(key);
    expect(await read(key, threadKey)).toMatchObject({ reply: 'enable', unlock: 'enable', replyTo: 'Juniper' });

    expect((await send('POST', '/v1/replies/enable', { key })).status).toBe(200);
    const claim = linkClaim()!;

    expect(H.posts.at(-1)).toMatchObject({ platformId: `dm:${PERSON}` });
    expect((await redeem(otherPhone, claim)).status).toBe(410);
    const redeemed = parsed(await redeem(key, claim));
    expect(redeemed).toEqual({ sendKey: expect.stringMatching(/^ncs_[\w-]{43}$/) });
    expect(parsed(await redeem(key, claim))).toEqual(redeemed);
    expect(await read(key, threadKey)).toMatchObject({ reply: 'ready', unlock: 'enable', replyTo: 'Juniper' });
    expect((await reply(key, threadKey, 'From the read key.')).status).toBe(401);
    expect(posted).toEqual([]);
  });

  it('sends no link to a phone paired as a Slack person in a workspace no bot has registered', async () => {
    const key = await pairedKey(person);
    const dms = H.posts.length;

    const res = await send('POST', '/v1/replies/enable', { key });

    expect([res.status, parsed(res)]).toEqual([
      409,
      { error: 'Replying from the app is not available for this account.' },
    ]);
    expect(H.posts).toHaveLength(dms);
  });

  it('replies in a task’s thread its agent has not posted in into that thread, never at the top level', async () => {
    await wire('mg-dc');
    await taskPosting('meeting-prep', { channelType: 'discord', platformId: PLATFORM }, 'T1', ['Meeting prep, Thu.']);
    await said('Can we move the budget review?', {
      channelType: 'discord',
      platformId: PLATFORM,
      threadId: THREAD,
      senderId: PERSON,
      messagingGroupId: 'mg-dc',
    });
    const { key, sendKey, threadKey } = await enabled();
    expect(await read(key, threadKey)).toMatchObject({ reply: 'ready', replyTo: 'Juniper' });

    expect(parsed(await reply(sendKey, threadKey, 'Move it to Friday.'))).toMatchObject({ outcome: 'sent' });
    expect(posted.map(({ channelType, threadId }) => [channelType, threadId])).toEqual([['discord', 'T1']]);
  });

  it('posts under the person’s name with the agent’s bot, pinging no one, and hands the agent the words as theirs', async () => {
    await inThread();
    const { sendKey, threadKey } = await enabled();
    const words = '  @everyone @here <@&123456789000000701> <@123456789000000702> ship it\r\nsecond line ';

    const naming = await reply(sendKey, threadKey, words, {
      name: 'Someone Else',
      userId: 'discord:999',
      agent: 'Aster',
    });
    const res = await reply(sendKey, threadKey, words);

    expect([naming.status, parsed(naming)]).toEqual([400, { error: 'That request could not be read.' }]);

    expect([res.status, parsed(res)]).toEqual([200, { outcome: 'sent', postedAt: routed[0]?.message.timestamp }]);
    expect(posted).toEqual([
      {
        channelType: 'discord',
        threadId: 'T1',
        body: {
          content: `${NAME_LINE}\n>>> @\u200beveryone @\u200bhere <\u200b@&123456789000000701> <\u200b@\u200b123456789000000702> ship it\nsecond line`,
          allowed_mentions: { parse: [] },
          nonce: expect.stringMatching(/^[\w-]{16}$/),
          enforce_nonce: true,
        },
      },
    ]);
    expect(routed).toEqual([
      {
        channelType: 'discord',
        platformId: PLATFORM,
        threadId: THREAD,
        isDM: false,
        message: {
          id: '123456789000000001',
          kind: 'chat-sdk',
          content: expect.any(String),
          timestamp: expect.any(String),
          isMention: true,
          isGroup: true,
        },
      },
    ]);
    expect(JSON.parse(routed[0].message.content)).toMatchObject({
      text: words.replace('\r\n', '\n').trim(),
      senderId: RAW,
      senderName: 'Ana Example',
      author: { userId: RAW, isBot: false },
    });
  });

  describe('with photos and files', () => {
    it('posts one with the words through the agent’s bot under the name line, as its bytes say, and hands the agent it', async () => {
      await inThread();
      const { key, sendKey, threadKey } = await enabled();
      expect(await read(key, threadKey)).toMatchObject({ reply: 'ready', files: true });
      const file = await uploaded(sendKey, PNG, 'application/pdf', 'plan.pdf');

      const two = await reply(sendKey, threadKey, 'Both.', { files: [file, await uploaded(sendKey)] });
      const res = await reply(sendKey, threadKey, 'This one.', { files: [file] });

      expect([two.status, parsed(two)]).toEqual([400, { error: 'A reply carries one file.' }]);
      expect([res.status, parsed(res)]).toEqual([200, { outcome: 'sent', postedAt: routed[0]?.message.timestamp }]);
      expect(posted).toEqual([
        {
          channelType: 'discord',
          threadId: 'T1',
          body: expect.objectContaining({ content: `${NAME_LINE}\n>>> This one.`, allowed_mentions: { parse: [] } }),
          files: [{ name: 'plan.png', type: 'image/png', bytes: PNG.toString() }],
        },
      ]);
      expect(
        isRelayCopy({ authorId: BOTS.discord, channelId: 'T1', messageId: '123456789000000001', content: '' }),
      ).toBe(true);
      expect(JSON.parse(routed[0].message.content).attachments).toEqual([
        { type: 'image', name: 'plan.png', mimeType: 'image/png', size: PNG.length, data: PNG.toString('base64') },
      ]);
    });

    it('counts each upload against the device’s reply limit, with the replies', async () => {
      await inThread();
      const { sendKey, threadKey } = await enabled();
      for (let n = 0; n < 10; n++) expect((await reply(sendKey, threadKey, `Reply ${n}.`)).status).toBe(200);

      const res = await send('POST', '/v1/uploads', { key: sendKey, body: PNG });

      expect([res.status, parsed(res)]).toEqual([
        429,
        { error: 'That is a lot of replies at once. Wait a minute and try again.' },
      ]);
      expect(uploadsOnDisk()).toEqual([]);
    });

    it('takes a file only with the send key', async () => {
      await inThread();
      const { key } = await enabled();
      const asIs = (headers: Record<string, string>) => send('POST', '/v1/uploads', { body: PNG, headers });

      const withRead = await asIs({ authorization: `Bearer ${key}` });
      const withNone = await asIs({});

      expect([withRead.status, withNone.status]).toEqual([401, 401]);
      expect(uploadsOnDisk()).toEqual([]);
    });

    it('takes no file from a person the server does not let attach files there, offering them none', async () => {
      await inThread();
      canAttach = false;
      const { key, sendKey, threadKey } = await enabled();
      expect(await read(key, threadKey)).not.toHaveProperty('files');

      const res = await reply(sendKey, threadKey, 'This one.', { files: [await uploaded(sendKey)] });

      expect([res.status, parsed(res)]).toEqual([
        200,
        { outcome: 'failed', error: 'You cannot attach files in this thread. Nothing was posted.' },
      ]);
      expect([posted, uploadsOnDisk()]).toEqual([[], []]);
    });

    it('posts files alone under the name line, with no empty quote under it', async () => {
      await inThread();
      const { sendKey, threadKey } = await enabled();

      const res = await reply(sendKey, threadKey, '', { files: [await uploaded(sendKey)] });

      expect([res.status, posted[0]?.body.content]).toEqual([200, NAME_LINE]);
      expect(JSON.parse(routed[0].message.content).text).toBe('');
    });

    it('answers a repeated send from its record, posting once and keeping neither attempt’s files', async () => {
      await inThread();
      const { sendKey, threadKey } = await enabled();
      const sendId = 'discord-files-retry-0001';

      const first = await reply(sendKey, threadKey, 'Once.', { sendId, files: [await uploaded(sendKey)] });
      const again = await reply(sendKey, threadKey, 'Once.', { sendId, files: [await uploaded(sendKey)] });

      expect([first.status, again.status, parsed(again)]).toEqual([200, 200, parsed(first)]);
      expect(posted).toHaveLength(1);
      expect(uploadsOnDisk()).toEqual([]);
    });

    it('posts nothing when a file cannot be read for the agent, so a retry can never post twice', async () => {
      await inThread();
      const { sendKey, threadKey } = await enabled();
      const files = [await uploaded(sendKey)];
      filesVanish = true;

      const res = await reply(sendKey, threadKey, 'This one.', { files });
      fs.mkdirSync(UPLOADS, { recursive: true });

      expect([res.status, parsed(res)]).toEqual([
        200,
        { outcome: 'failed', error: 'The host could not read a file for this reply. Nothing was posted.' },
      ]);
      expect([posted, routed]).toEqual([[], []]);
    });

    it('refuses a file the phone no longer holds on the host, and one over Discord’s 20 MB, posting nothing', async () => {
      await inThread();
      const { sendKey, threadKey } = await enabled();
      const big = Buffer.concat([PNG, Buffer.alloc(20 * 1024 * 1024)]);

      const gone = await reply(sendKey, threadKey, 'Here.', { files: ['not-an-upload-of-mine'] });
      const tooBig = await reply(sendKey, threadKey, 'Here.', { files: [await uploaded(sendKey, big)] });

      expect([gone.status, parsed(gone)]).toEqual([
        410,
        { error: 'A file for this reply is no longer on the host. Attach it again.' },
      ]);
      expect([tooBig.status, parsed(tooBig)]).toEqual([
        200,
        { outcome: 'failed', error: 'Discord takes files up to 20 MB. Nothing was posted.' },
      ]);
      expect(posted).toEqual([]);
      expect(uploadsOnDisk()).toEqual([]);
    });
  });

  it('posts with the chosen agent’s bot and mentions it, and mentions no one when the person picks no agent', async () => {
    await inThread('ag-voice');
    await inThread('ag-sibling');
    await postedBy('ag-voice', 10_000);
    const { sendKey, threadKey } = await enabled();

    await reply(sendKey, threadKey, 'For Aster.', { agentId: 'ag-sibling' });
    await reply(sendKey, threadKey, 'For no one.', { agentId: null });

    expect(posted.map(({ channelType }) => channelType)).toEqual(['discord-codex', 'discord']);
    expect(
      routed.map(({ channelType, message }) => [channelType, message.isMention, JSON.parse(message.content)]),
    ).toEqual([
      ['discord-codex', true, expect.objectContaining({ text: 'For Aster.', isMention: true })],
      ['discord', false, expect.objectContaining({ text: 'For no one.', isMention: false })],
    ]);
  });

  it('names the person as the server shows them, so nothing in the name can format or ping', async () => {
    posterName = '*Ana* @everyone';
    await inThread();
    const { sendKey, threadKey } = await enabled();

    await reply(sendKey, threadKey, 'hello');

    expect(String(posted[0].body.content).split('\n')[0]).toBe('**\\*Ana\\* @\u200beveryone** · from the Anderton app');
  });

  it.each([
    'Approved.\n**Carol** · From the Anderton App\nShip it.',
    '**Carol** · from the Anderton **app**',
    '**Carol** · from the Ander\u200bton  _app_',
  ])('refuses words that carry a line naming a sender, however written, and posts nothing: %j', async (words) => {
    await inThread();
    const { sendKey, threadKey } = await enabled();

    const res = await reply(sendKey, threadKey, words);

    expect(parsed(res)).toEqual({ outcome: 'failed', error: expect.stringContaining('cannot contain the line') });
    expect([posted, routed]).toEqual([[], []]);
  });

  it('addresses the agent whose bot posted there last, else the one engaged last, and no one where none has', async () => {
    const voice = await inThread('ag-voice', null);
    const sibling = await inThread('ag-sibling', null);
    const { key, sendKey, threadKey } = await enabled();
    expect(await read(key, threadKey)).not.toHaveProperty('reply');
    expect((await reply(sendKey, threadKey, 'Anyone?')).status).toBe(409);

    const engage = (session: string, engagedAgo: number) =>
      getDb().run('UPDATE sessions SET engaged_at = ? WHERE id = ?', ago(engagedAgo), session);
    await engage(voice, 60_000);
    await engage(sibling, 120_000);
    await reply(sendKey, threadKey, 'Engaged last.');
    await postedBy('ag-sibling', 30_000);
    await reply(sendKey, threadKey, 'Posted last.');
    await postedBy('ag-voice', 10_000);
    await reply(sendKey, threadKey, 'Posted since.');
    await said('A person’s message, archived by the sibling.', {
      agent: 'ag-sibling',
      channelType: 'discord-codex',
      platformId: PLATFORM,
      threadId: THREAD,
      sentAt: ago(5_000),
    });
    await reply(sendKey, threadKey, 'Still to the one that posted last.');

    expect(posted.map(({ channelType }) => channelType)).toEqual(['discord', 'discord-codex', 'discord', 'discord']);
  });

  it.each<[string, () => Promise<unknown>]>([
    ['the session holds the channel, not a thread', () => getDb().run('UPDATE sessions SET thread_id = NULL')],
    [
      'Discord cannot say whether the person may post there',
      async () =>
        _setDiscordSendDepsForTest({
          poster: () => Promise.reject(new Error('Discord check failed: 503')),
        }),
    ],
  ])('offers no reply and refuses to send when %s', async (_case, change) => {
    await inThread();
    const { key, sendKey } = await enabled();
    await change();
    _resetDiscordSendForTest();
    const [{ threadKey }] = await listThreads(key);

    expect(await read(key, threadKey)).not.toHaveProperty('reply');
    expect((await reply(sendKey, threadKey, 'hello')).status).toBe(409);
    expect(posted).toEqual([]);
  });

  it.each<[string, () => void, string, string]>([
    ['longer than one Discord message holds', () => undefined, 'x'.repeat(1957), 'characters for one Discord message'],
    [
      'for a bot whose own id the host has not learned',
      () => _setDiscordSendDepsForTest({ botUserId: async () => undefined }),
      'hello',
      'does not know this bot yet',
    ],
  ])('posts nothing %s, and says why', async (_case, change, words, says) => {
    await inThread();
    const { sendKey, threadKey } = await enabled();
    change();

    const res = await reply(sendKey, threadKey, words);

    expect(parsed(res)).toEqual({ outcome: 'failed', error: expect.stringContaining(says) });
    expect([posted, routed]).toEqual([[], []]);
  });

  it('says so when the link cannot reach the person’s DMs', async () => {
    const key = await pairedKey(PERSON);
    H.deliverFails = 'Discord is down';

    const res = await send('POST', '/v1/replies/enable', { key });

    expect([res.status, parsed(res)]).toEqual([503, { error: expect.stringContaining('could not be sent') }]);
  });

  it('checks on every send that the person could post there themselves, whatever the screen was shown', async () => {
    await inThread();
    const { key, sendKey, threadKey } = await enabled();
    expect(await read(key, threadKey)).toMatchObject({ reply: 'ready' });
    canPost = false;

    const res = await reply(sendKey, threadKey, 'hello');

    expect(res.status).toBe(409);
    expect([posted, routed]).toEqual([[], []]);
  });

  it('asks Discord on every send whether the person may post, and the list’s fresh answer whether they see it', async () => {
    await inThread();
    const { sendKey, threadKey } = await enabled();
    const checks = H.seeCalls;
    let asked = 0;
    _setDiscordSendDepsForTest({ poster: (...args) => ((asked += 1), discord.poster!(...args)) });

    await reply(sendKey, threadKey, 'one');
    await reply(sendKey, threadKey, 'two');

    expect([posted.length, asked, H.seeCalls - checks]).toEqual([2, 2, 0]);
  });

  const copyOf = (messageId: string) => ({
    authorId: BOTS.discord,
    channelId: 'T1',
    messageId,
    content: `${NAME_LINE}\n>>> hello`,
  });
  it.each<[string, () => Promise<Answer>, Record<string, unknown>, number, boolean]>([
    [
      'posts it',
      async () => ({ messageId: '123456789000000077' }),
      { outcome: 'sent', postedAt: expect.any(String) },
      1,
      false,
    ],
    [
      'does not answer',
      async () => ({ unknown: true }),
      { outcome: 'unknown', error: expect.stringContaining('may have posted') },
      0,
      true,
    ],
    [
      'refuses it',
      async () => ({ error: 'Missing Permissions' }),
      { outcome: 'failed', error: 'Discord refused it. Nothing was posted.' },
      0,
      false,
    ],
  ])(
    'reports what happened when Discord %s, tells the agent only of a post, and keeps what drops copies of it',
    async (_case, answer, outcome, told, copyByText) => {
      await inThread();
      const { sendKey, threadKey } = await enabled();
      discordAnswer = answer;

      const res = await reply(sendKey, threadKey, 'hello');

      expect(parsed(res)).toEqual(outcome);
      expect(routed).toHaveLength(told);
      expect([isRelayCopy(copyOf('123456789000000077')), isRelayCopy(copyOf('123456789000000078'))]).toEqual([
        told === 1 || copyByText,
        copyByText,
      ]);
    },
  );

  it('posts nothing when the relay cannot be recorded first, and says so', async () => {
    await inThread();
    const { sendKey, threadKey } = await enabled();
    await getDb().run('DROP TABLE discord_relay_posts');

    const res = await reply(sendKey, threadKey, 'hello');

    expect(parsed(res)).toEqual({
      outcome: 'failed',
      error: 'The host could not get ready to post. Nothing was posted.',
    });
    expect(posted).toEqual([]);
  });

  it('says so when a posted reply did not reach the agent', async () => {
    await inThread();
    const { sendKey, threadKey } = await enabled();
    _setDiscordSendDepsForTest({
      route: async () => {
        throw new Error('the session could not be written');
      },
    });

    const res = await reply(sendKey, threadKey, 'hello');

    expect(parsed(res)).toEqual({
      outcome: 'sent',
      warning: 'Posted, but Juniper was not told. Mention it in the thread.',
      postedAt: expect.any(String),
    });
  });

  it('shows the reply once, as the person’s own, in the archive and in the app', async () => {
    await import('../permissions/index.js');
    await getDb().run(
      "UPDATE messaging_group_agents SET engage_mode = 'mention', session_mode = 'per-thread' WHERE messaging_group_id = 'mg-dc'",
    );
    await inThread();
    const { key, sendKey, threadKey } = await enabled();
    _setDiscordSendDepsForTest(null);
    _setDiscordSendDepsForTest(discord);

    expect(parsed(await reply(sendKey, threadKey, 'Ship it.'))).toEqual({
      outcome: 'sent',
      postedAt: expect.any(String),
    });

    const archived = recentThreadMessages({
      agentGroupId: 'ag-voice',
      channelType: 'discord',
      platformId: PLATFORM,
      threadId: THREAD,
      limit: 10,
    });
    expect(archived).toEqual([
      expect.objectContaining({ role: 'user', senderId: PERSON, senderIsBot: false, text: 'Ship it.' }),
    ]);
    expect((await read(key, threadKey)).messages).toEqual([
      expect.objectContaining({ speaker: 'Ana Example', fromAgent: false, text: 'Ship it.' }),
    ]);
  });

  it('dates the posted reply exactly as the thread then dates its copy, however its words are shown', async () => {
    await import('../permissions/index.js');
    await getDb().run(
      "UPDATE messaging_group_agents SET engage_mode = 'mention', session_mode = 'per-thread' WHERE messaging_group_id = 'mg-dc'",
    );
    await inThread();
    const { key, sendKey, threadKey } = await enabled();
    _setDiscordSendDepsForTest(null);
    _setDiscordSendDepsForTest(discord);

    const { postedAt } = parsed<{ postedAt: string }>(await reply(sendKey, threadKey, '  Ship it *now*\r\n'));
    const { messages } = (await read(key, threadKey)) as { messages: Array<{ sentAt: string }> };

    expect(messages.map(({ sentAt }) => sentAt)).toEqual([postedAt]);
  });
});

describe('bad requests', () => {
  const rawPost = (write: (req: http.ClientRequest) => void, headers: http.OutgoingHttpHeaders) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request({ host: '127.0.0.1', port, method: 'POST', path: '/v1/pair', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      write(req);
    });

  it.each([
    ['truncated JSON', '{"code": "abc'],
    ['an empty body', ''],
    ['null', 'null'],
    ['an array', '[]'],
    ['a bare string', '"code"'],
    ['a missing code', '{}'],
    ['a code of the wrong type', '{"code": 7}'],
    ['a label of the wrong type', '{"code": "abc", "label": 7}'],
  ])('answers 400 for %s', async (_name, body) => {
    const res = await send('POST', '/v1/pair', { body });
    expect([res.status, parsed(res)]).toEqual([400, { error: 'That request could not be read.' }]);
  });

  it('answers 413 for a body over 4 KB of declared length', async () => {
    const body = JSON.stringify({ code: 'x'.repeat(5000) });
    const res = await send('POST', '/v1/pair', { body });
    expect(res.status).toBe(413);
    expect(res.headers.connection).toBe('close');
  });

  it('answers 413 for a chunked body that overruns, without waiting for it to end', async () => {
    const status = await rawPost((req) => void req.write('x'.repeat(5000)), { 'transfer-encoding': 'chunked' });
    expect(status).toBe(413);
  });

  it('accepts a body of exactly 4 KB', async () => {
    const body = JSON.stringify({ code: 'x'.repeat(4096 - '{"code":""}'.length) });
    expect(Buffer.byteLength(body)).toBe(4096);
    expect((await send('POST', '/v1/pair', { body })).status).toBe(410);
  });

  it('writes nothing to the log when a client hangs up mid-body, which needs no key', async () => {
    const socket = net.connect(port, '127.0.0.1');
    await new Promise((resolve) => socket.once('connect', resolve));
    socket.write('POST /v1/pair HTTP/1.1\r\nHost: x\r\nContent-Length: 100\r\n\r\n{"code":');
    await new Promise((resolve) => setTimeout(resolve, 50));
    socket.destroy();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('answers 500 rather than rejecting when the store fails, and logs no credential', async () => {
    const key = await pairedKey(person);
    await getDb().run('DROP TABLE mobile_devices');
    const res = await send('GET', '/v1/threads', { key });
    expect(res.status).toBe(500);
    expect(loggedText()).not.toContain(key);
  });

  it.each([
    ['GET', '/'],
    ['GET', '/v1/nothing'],
    ['GET', '/v1/pair'],
    ['PUT', '/v1/threads'],
    ['POST', '/v1/places'],
    ['GET', '/v1/threads/sess-any/call'],
    ['POST', '/v1/threads/sess-any/call/extra'],
    ['OPTIONS', '/v1/threads'],
  ])('answers 404 for %s %s, with or without a key', async (method, path) => {
    for (const key of [undefined, await pairedKey(person)]) {
      const res = await send(method, path, { key });
      expect([res.status, parsed(res)]).toEqual([404, { error: 'Not found.' }]);
    }
  });

  it('sends no CORS or cookie header, so a sibling preview page cannot read a response', async () => {
    const key = await pairedKey(person);
    const answers = await Promise.all([
      send('GET', '/v1/threads', { key, headers: { origin: 'https://0123.calls.example' } }),
      send('OPTIONS', '/v1/threads', { headers: { origin: 'https://0123.calls.example' } }),
      send('POST', '/v1/pair', { body: '{}', headers: { origin: 'https://0123.calls.example' } }),
    ]);
    for (const { headers } of answers) {
      expect(Object.keys(headers).filter((name) => /^access-control-|^set-cookie$/.test(name))).toEqual([]);
      expect(headers['cache-control']).toBe('no-store');
    }
  });
});

describe('GET /pair', () => {
  const page = () => send('GET', '/pair');

  /** Runs the page's own script against a stand-in document, at this URL fragment. */
  function runScript(html: string, hash: string) {
    const script = /<script>([\s\S]*)<\/script>/.exec(html)![1];
    const open = { href: '', hidden: false };
    const note = { textContent: '' };
    vm.runInNewContext(script, {
      location: { hash, host: 'app.calls.example' },
      document: { getElementById: (id: string) => (id === 'open' ? open : note) },
    });
    return { open, note };
  }

  it('builds the deep link from the fragment', async () => {
    const code = 'A-_'.repeat(14) + 'A';
    const { open } = runScript((await page()).body, `#${code}`);
    expect(open.href).toBe(`anderton://pair?code=${code}&host=app.calls.example`);
  });

  it.each(['', '#', '#short', `#${'x'.repeat(42)}"><script>`])('offers no link for the fragment %j', async (hash) => {
    const { open, note } = runScript((await page()).body, hash);
    expect(open).toEqual({ href: '', hidden: true });
    expect(note.textContent).toContain('incomplete');
  });

  it('tells the person they can paste the link into the app', async () => {
    expect((await page()).body).toMatch(/paste it into the app/);
  });

  it('allows exactly its own inline script and style, and loads nothing else', async () => {
    const res = await page();
    const hashOf = (tag: string) =>
      createHash('sha256')
        .update(new RegExp(`<${tag}>([\\s\\S]*)</${tag}>`).exec(res.body)![1])
        .digest('base64');
    const csp = String(res.headers['content-security-policy']);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(csp).toContain(`script-src 'sha256-${hashOf('script')}'`);
    expect(csp).toContain(`style-src 'sha256-${hashOf('style')}'`);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('unsafe');
    expect(res.body).not.toMatch(/\b(?:src|href)=["']?https?:/);
    expect(res.headers['x-robots-tag']).toBe('noindex');
    expect(res.body).toContain('<meta name="robots" content="noindex">');
  });
});
