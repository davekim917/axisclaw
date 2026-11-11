/**
 * Discord inbound and outbound over the real transport stack: the host's Discord wiring (discord.ts), the real
 * `@chat-adapter/discord` with its pnpm patch, a real discord.js Client on a real gateway WebSocket, and the real Chat
 * SDK bridge with its local webhook server. Only Discord is fake: a local server answers REST and speaks the gateway
 * protocol. discord.js emits `raw` and then builds its own objects from the same packet, so a forwarder that
 * serializes late sees the packet discord.js mutated; only a real Client on a real socket reproduces that order.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { DefaultRestOptions } from 'discord.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import { allowNetwork } from '../test-hermeticity.js';
import { ChannelRateLimitedError, type ChannelSetup, type InboundMessage } from './adapter.js';
import { serveAttachments } from '../test-attachment-transport.js';

const TOKEN = 'live-path-test-token';
const BOT = '123456789000000001';
const HUMAN = '123456789000000002';
const GUILD = '123456789000000003';
const CHANNEL = '123456789000000004';
const DM_CHANNEL = '123456789000000005';
const THREAD = '123456789000000006';
const DELETED_THREAD = '123456789000000007';
const ANCHOR = '123456789000000008';
const OTHER_CHANNEL = '123456789000000009';
const OTHER_THREAD = '123456789000000010';
const SIBLING_TOKEN = 'live-path-sibling-token';
const SIBLING = '123456789000000040';

vi.mock('../env.js', async (importOriginal) => {
  const values: Record<string, string> = {
    DISCORD_BOT_TOKEN: TOKEN,
    DISCORD_PUBLIC_KEY: '0'.repeat(64),
    DISCORD_APPLICATION_ID: '123456789000000001',
    DISCORD_BOT_TOKEN_SIBLING: SIBLING_TOKEN,
    DISCORD_PUBLIC_KEY_SIBLING: '1'.repeat(64),
    DISCORD_APPLICATION_ID_SIBLING: SIBLING,
  };
  return {
    ...(await importOriginal<typeof import('../env.js')>()),
    readEnvFileMatching: (pattern: RegExp) =>
      Object.fromEntries(Object.entries(values).filter(([key]) => pattern.test(key))),
    readEnvFile: () => values,
  };
});

const botUser = { id: BOT, username: 'example-agent', discriminator: '0', global_name: null, bot: true, avatar: null };
const siblingUser = {
  id: SIBLING,
  username: 'example-sibling',
  discriminator: '0',
  global_name: null,
  bot: true,
  avatar: null,
};
const BOT_AVATAR = '0123456789abcdef0123456789abcdef';
const humanUser = {
  id: HUMAN,
  username: 'example.user',
  discriminator: '0',
  global_name: 'Example User',
  avatar: null,
};
const channel = { id: CHANNEL, type: 0, guild_id: GUILD, name: 'general', position: 0, permission_overwrites: [] };
const thread = { id: THREAD, type: 11, guild_id: GUILD, parent_id: CHANNEL, name: 'a thread', thread_metadata: {} };

let server: http.Server;
let gateway: WebSocketServer;
let socket: WebSocket | null = null;
let seq = 0;
let identifyToken: string | undefined;
let identifyIntents = 0;
const unfaked: string[] = [];
let renameRetryAfter: string | null = null;
let renameForbidden = false;
let anchorThreadOpen = false;
const posted: Array<{ path: string; body: Record<string, unknown> }> = [];
const threadsOpened: Array<{ path: string; body: Record<string, unknown> }> = [];
const inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];
const waiters: Array<() => void> = [];
let registry: typeof import('./channel-registry.js');
let savedApiUrl: string | undefined;
// The adapter constructs its own discord.js Client, so the library default is the only way to point its REST at the
// fake. It is typed read-only but is a plain object at runtime.
const restDefaults = DefaultRestOptions as { api: string };
const savedRestApi = restDefaults.api;

function dispatch(t: string, d: unknown, to: WebSocket | null = socket): void {
  seq += 1;
  to!.send(JSON.stringify({ op: 0, t, s: seq, d }));
}

function rest(method: string, path: string, body: Record<string, unknown>, auth?: string): [number, unknown] {
  if (method === 'GET' && path === '/gateway/bot') {
    const { port } = server.address() as AddressInfo;
    return [
      200,
      {
        url: `ws://127.0.0.1:${port}`,
        shards: 1,
        session_start_limit: { total: 1000, remaining: 1000, reset_after: 0, max_concurrency: 1 },
      },
    ];
  }
  if (method === 'GET' && path === '/users/@me')
    return [200, auth === `Bot ${SIBLING_TOKEN}` ? siblingUser : { ...botUser, avatar: BOT_AVATAR }];
  if (method === 'GET' && path === `/channels/${CHANNEL}`) return [200, channel];
  if (method === 'GET' && path === `/channels/${THREAD}`) return [200, thread];
  if (method === 'GET' && path === `/channels/${DELETED_THREAD}`)
    return [404, { message: 'Unknown Channel', code: 10003 }];
  if (method === 'PATCH' && path === `/channels/${THREAD}`) {
    if (renameForbidden) return [403, { message: 'Missing Permissions', code: 50013 }];
    if (renameRetryAfter !== null)
      return [429, { message: 'You are being rate limited.', retry_after: 0, global: false }];
    thread.name = String(body.name).trim();
    return [200, thread];
  }
  if (method === 'GET' && path === `/channels/${DM_CHANNEL}`) return [200, { id: DM_CHANNEL, type: 1 }];
  if (method === 'GET' && path === `/guilds/${GUILD}/channels`) return [200, [channel]];
  if (method === 'GET' && path === `/channels/${CHANNEL}/messages/${ANCHOR}`)
    return [200, { id: ANCHOR, channel_id: CHANNEL, content: 'Weekly deploys', author: botUser }];
  if (method === 'GET' && path === `/channels/${ANCHOR}`)
    return anchorThreadOpen ? [200, { ...thread, id: ANCHOR }] : [404, { message: 'Unknown Channel', code: 10003 }];
  if (method === 'POST' && path === `/channels/${ANCHOR}/messages` && !anchorThreadOpen)
    return [404, { message: 'Unknown Channel', code: 10003 }];
  if (method === 'GET' && path === `/channels/${OTHER_THREAD}`)
    return [200, { ...thread, id: OTHER_THREAD, parent_id: OTHER_CHANNEL }];
  if (method === 'POST' && path === `/channels/${CHANNEL}/messages/${ANCHOR}/threads`) {
    anchorThreadOpen = true;
    threadsOpened.push({ path, body });
    return [201, { ...thread, id: ANCHOR }];
  }
  if (method === 'POST' && /^\/channels\/\d+\/messages$/.test(path)) {
    posted.push({ path, body });
    return [200, { id: '123456789000000099', channel_id: path.split('/')[2], content: body.content, author: botUser }];
  }
  if (method === 'POST' && /^\/channels\/\d+\/messages\/\d+\/threads$/.test(path)) {
    threadsOpened.push({ path, body });
    return [201, thread];
  }
  unfaked.push(`${method} ${path}`);
  return [404, { message: 'Unknown', code: 0 }];
}

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => resolve(raw && (req.headers['content-type'] ?? '').includes('json') ? JSON.parse(raw) : {}));
  });
}

function nextInbound(count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`expected ${count} inbound message(s), got ${inbound.length}`)),
      3_000,
    );
    const check = (): void => {
      if (inbound.length >= count) {
        clearTimeout(timer);
        resolve();
      } else {
        waiters.push(check);
      }
    };
    check();
  });
}

function messageCreate(id: string, fields: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    type: 0,
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    tts: false,
    mention_everyone: false,
    mentions: [],
    mention_roles: [],
    attachments: [],
    embeds: [],
    pinned: false,
    flags: 0,
    author: humanUser,
    ...fields,
  };
}

beforeAll(async () => {
  allowNetwork();
  const { initMigratedTestDb } = await import('../db/index.js');
  await initMigratedTestDb();

  const answer = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const path = (req.url ?? '').replace(/^\/api(\/v\d+)?/, '').split('?')[0]!;
    const [status, body] = rest(req.method ?? 'GET', path, await readBody(req), req.headers.authorization);
    res.statusCode = status;
    if (status === 429 && renameRetryAfter !== null) res.setHeader('retry-after', renameRetryAfter);
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  server = http.createServer((req, res) => void answer(req, res));
  gateway = new WebSocketServer({ server });
  gateway.on('connection', (ws) => {
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString()) as { op: number; d: { token?: string; intents?: number } };
      if (frame.op === 1) ws.send(JSON.stringify({ op: 11 }));
      if (frame.op === 2) {
        // The sibling workspace connects too; test events go only to the bot under test.
        const user = frame.d.token === TOKEN ? botUser : siblingUser;
        if (frame.d.token === TOKEN) {
          socket = ws;
          identifyToken = frame.d.token;
          identifyIntents = frame.d.intents ?? 0;
        }
        const { port } = server.address() as AddressInfo;
        dispatch(
          'READY',
          {
            v: 10,
            user,
            guilds: [{ id: GUILD, unavailable: true }],
            session_id: 'live-path-session',
            resume_gateway_url: `ws://127.0.0.1:${port}`,
            application: { id: user.id, flags: 0 },
          },
          ws,
        );
        dispatch(
          'GUILD_CREATE',
          {
            id: GUILD,
            name: 'Example Guild',
            owner_id: HUMAN,
            unavailable: false,
            member_count: 2,
            roles: [
              {
                id: GUILD,
                name: '@everyone',
                permissions: '0',
                position: 0,
                color: 0,
                hoist: false,
                managed: false,
                mentionable: false,
              },
            ],
            channels: [channel],
            threads: [],
            members: [],
            emojis: [],
            features: [],
          },
          ws,
        );
      }
    });
    ws.send(JSON.stringify({ op: 10, d: { heartbeat_interval: 45_000 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  restDefaults.api = `http://127.0.0.1:${port}/api`;
  savedApiUrl = process.env.DISCORD_API_URL;
  process.env.DISCORD_API_URL = `http://127.0.0.1:${port}/api/v10`;

  await import('./discord.js');
  registry = await import('./channel-registry.js');
  const setup: ChannelSetup = {
    onInbound: async (platformId, threadId, msg) => {
      inbound.push({ platformId, threadId, message: msg });
      for (const wake of waiters.splice(0)) wake();
    },
    onInboundEvent: async () => {},
    onMetadata: async () => {},
    onAction: () => {},
  };
  await registry.initChannelAdapters(() => setup);
  const deadline = Date.now() + 10_000;
  while (identifyToken === undefined && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  if (identifyToken === undefined) throw new Error('discord.js never identified to the fake gateway');
  await new Promise((r) => setTimeout(r, 200));
}, 30_000);

afterAll(async () => {
  await registry?.teardownChannelAdapters();
  restDefaults.api = savedRestApi;
  if (savedApiUrl === undefined) delete process.env.DISCORD_API_URL;
  else process.env.DISCORD_API_URL = savedApiUrl;
  gateway?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  const { closeDb } = await import('../db/index.js');
  await closeDb();
});

describe('Discord inbound and outbound through the real adapter and discord.js gateway', () => {
  it('identifies to the gateway with the bot token and the intents inbound needs', () => {
    expect(identifyToken).toBe(TOKEN);
    // Discord withholds what an intent does not ask for: DMs without DirectMessages, message text without
    // MessageContent. The fake gateway delivers regardless, so the request itself is the contract.
    const required = { Guilds: 1 << 0, GuildMessages: 1 << 9, DirectMessages: 1 << 12, MessageContent: 1 << 15 };
    const missing = Object.entries(required).filter(([, bit]) => (identifyIntents & bit) === 0);
    expect(missing.map(([name]) => name)).toEqual([]);
  });

  it('registers the bot’s avatar from its own user object, at Discord’s CDN', async () => {
    const { getKnownDiscordBots } = await import('./discord.js');
    expect(getKnownDiscordBots().get('discord')?.avatarUrl).toBe(
      `https://cdn.discordapp.com/avatars/${BOT}/${BOT_AVATAR}.png?size=256`,
    );
  });

  it('delivers a guild @mention that discord.js turns circular, in a thread it opens for a week', async () => {
    inbound.length = 0;
    dispatch(
      'MESSAGE_CREATE',
      messageCreate('123456789000000010', {
        channel_id: CHANNEL,
        guild_id: GUILD,
        content: `<@${BOT}> status please`,
        member: { roles: [], joined_at: new Date(0).toISOString(), deaf: false, mute: false },
        mentions: [
          { ...botUser, member: { roles: [], joined_at: new Date(0).toISOString(), deaf: false, mute: false } },
        ],
      }),
    );
    await nextInbound(1);

    expect(inbound[0]!.platformId).toContain(CHANNEL);
    expect(inbound[0]!.message).toMatchObject({ isMention: true, isDM: false });
    expect(inbound[0]!.message.content).toMatchObject({
      text: expect.stringContaining('status please'),
      author: expect.objectContaining({ userId: HUMAN }),
    });
    expect(threadsOpened).toContainEqual({
      path: `/channels/${CHANNEL}/messages/123456789000000010/threads`,
      body: expect.objectContaining({ auto_archive_duration: 10080 }),
    });
  });

  it('delivers a reply to the bot, whose implicit mention discord.js also turns circular', async () => {
    inbound.length = 0;
    const member = { roles: [], joined_at: new Date(0).toISOString(), deaf: false, mute: false };
    dispatch(
      'MESSAGE_CREATE',
      messageCreate('123456789000000013', {
        type: 19,
        channel_id: CHANNEL,
        guild_id: GUILD,
        content: 'thanks, and one more thing',
        member,
        mentions: [{ ...botUser, member }],
        message_reference: { message_id: '123456789000000099', channel_id: CHANNEL, guild_id: GUILD },
        referenced_message: messageCreate('123456789000000099', {
          channel_id: CHANNEL,
          guild_id: GUILD,
          author: botUser,
          content: 'an earlier answer',
        }),
      }),
    );
    await nextInbound(1);

    expect(inbound[0]!.message).toMatchObject({ isMention: true, isDM: false });
    expect(inbound[0]!.message.content).toMatchObject({ text: expect.stringContaining('one more thing') });
  });

  it('downloads an attachment above the adapter default without sending the bot token to the CDN', async () => {
    const { INBOUND_ATTACHMENT_MAX_BYTES } = await import('../config.js');
    const MiB = 1024 * 1024;
    const big = `https://cdn.discordapp.com/attachments/${CHANNEL}/123456789000000020/originals.zip`;
    const huge = `https://cdn.discordapp.com/attachments/${CHANNEL}/123456789000000021/footage.zip`;
    const requests = serveAttachments(
      new Map([
        [big, 30 * MiB],
        [huge, INBOUND_ATTACHMENT_MAX_BYTES + 1],
      ]),
    );
    const attachment = (id: string, filename: string, size: number, url: string) => ({
      id,
      filename,
      size,
      url,
      proxy_url: url.replace('cdn.discordapp.com', 'media.discordapp.net'),
      content_type: 'application/zip',
    });
    inbound.length = 0;
    dispatch(
      'MESSAGE_CREATE',
      messageCreate('123456789000000014', {
        channel_id: DM_CHANNEL,
        content: 'the archives',
        attachments: [
          attachment('123456789000000021', 'footage.zip', 101 * MiB, huge),
          attachment('123456789000000020', 'originals.zip', 30 * MiB, big),
        ],
      }),
    );
    await nextInbound(1);

    const attachments = (inbound[0]!.message.content as { attachments: Array<{ name: string; data?: string }> })
      .attachments;
    expect(attachments.map((a) => a.name)).toEqual(['footage.zip', 'originals.zip']);
    expect(attachments[0]!.data).toBeUndefined();
    expect(Buffer.from(attachments[1]!.data ?? '', 'base64').length).toBe(30 * MiB);
    expect(requests).toEqual([{ url: big, authorization: undefined }]);
  });

  it('admits a NanoClaw sibling’s @mention and drops one from any other bot, as recovery does', async () => {
    inbound.length = 0;
    const { getKnownDiscordBots } = await import('./discord.js');
    expect([...getKnownDiscordBots().values()].map((bot) => bot.userId)).toContain(SIBLING);
    const member = { roles: [], joined_at: new Date(0).toISOString(), deaf: false, mute: false };
    const integration = { id: '123456789000000030', username: 'example-integration', discriminator: '0', bot: true };
    for (const [id, author] of [
      ['123456789000000031', integration],
      ['123456789000000032', siblingUser],
    ] as const) {
      dispatch(
        'MESSAGE_CREATE',
        messageCreate(id, {
          channel_id: CHANNEL,
          guild_id: GUILD,
          author: { ...author, global_name: null, avatar: null },
          member,
          content: `<@${BOT}> your turn`,
          mentions: [{ ...botUser, member }],
        }),
      );
    }
    await nextInbound(1);
    await new Promise((r) => setTimeout(r, 300));

    expect(inbound.map((entry) => (entry.message.content as { author: { userId: string } }).author.userId)).toEqual([
      SIBLING,
    ]);
    expect(inbound[0]!.message).toMatchObject({ isMention: true, isDM: false });
    expect(inbound[0]!.message.content).toMatchObject({
      author: expect.objectContaining({ userId: SIBLING, isBot: true }),
    });
  });

  it('delivers a plain guild message as not a mention', async () => {
    inbound.length = 0;
    dispatch(
      'MESSAGE_CREATE',
      messageCreate('123456789000000011', {
        channel_id: CHANNEL,
        guild_id: GUILD,
        content: 'just chatting',
        member: { roles: [], joined_at: new Date(0).toISOString(), deaf: false, mute: false },
      }),
    );
    await nextInbound(1);

    expect(inbound[0]!.message).toMatchObject({ isMention: false, isDM: false });
    expect(inbound[0]!.message.content).toMatchObject({ text: 'just chatting' });
  });

  it('delivers a direct message as a DM addressed to the bot', async () => {
    inbound.length = 0;
    dispatch(
      'MESSAGE_CREATE',
      messageCreate('123456789000000012', { channel_id: DM_CHANNEL, content: 'a private question' }),
    );
    await nextInbound(1);

    expect(inbound[0]!.platformId).toContain(DM_CHANNEL);
    expect(inbound[0]!.message).toMatchObject({ isMention: true, isDM: true });
    expect(inbound[0]!.message.content).toMatchObject({ text: 'a private question' });
  });

  it('posts an agent reply into a thread through the REST API', async () => {
    const adapter = registry.getChannelAdapterExact('discord')!;
    posted.length = 0;
    await adapter.deliver(`discord:${GUILD}:${CHANNEL}`, `discord:${GUILD}:${CHANNEL}:${THREAD}`, {
      kind: 'chat',
      content: { text: 'a reply from the agent' },
    });

    expect(posted.map((p) => p.path)).toContain(`/channels/${THREAD}/messages`);
    expect(JSON.stringify(posted)).toContain('a reply from the agent');
  });

  it('posts an agent card as a Components V2 message, with no embed a client could hide', async () => {
    const adapter = registry.getChannelAdapterExact('discord')!;
    posted.length = 0;
    await adapter.deliver(`discord:${GUILD}:${CHANNEL}`, `discord:${GUILD}:${CHANNEL}:${THREAD}`, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        fallbackText: 'Weekly deploys: 12',
        spec: {
          root: 'card',
          elements: {
            card: { type: 'Card', props: { title: 'Weekly deploys' }, children: ['kpis', 'rows'] },
            kpis: { type: 'Fields', props: {}, children: ['total'] },
            total: { type: 'Field', props: { label: 'Deploys', value: '12' }, children: [] },
            rows: { type: 'Table', props: { headers: ['Service'], rows: [['ledger-api']] }, children: [] },
          },
        },
      },
    });

    expect(posted).toHaveLength(1);
    const { path, body } = posted[0]!;
    expect(path).toBe(`/channels/${THREAD}/messages`);
    expect(body.flags).toBe(1 << 15);
    expect(body.embeds).toBeUndefined();
    expect(body.allowed_mentions).toEqual({ parse: [] });
    const [container] = body.components as Array<{
      type: number;
      components: Array<{ type: number; content: string }>;
    }>;
    expect(container!.type).toBe(17);
    const text = container!.components
      .filter((c) => c.type === 10)
      .map((c) => c.content)
      .join('\n');
    for (const piece of ['Weekly deploys', 'Deploys', '12', 'ledger-api']) expect(text).toContain(piece);
  });

  it('opens the thread on an anchor message that has none, then posts the card in it', async () => {
    const adapter = registry.getChannelAdapterExact('discord')!;
    posted.length = 0;
    threadsOpened.length = 0;
    await adapter.deliver(`discord:${GUILD}:${CHANNEL}`, `discord:${GUILD}:${CHANNEL}:${ANCHOR}`, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        fallbackText: 'Deploys: 12',
        spec: {
          root: 'card',
          elements: { card: { type: 'Card', props: { title: 'Deploys' }, children: [] } },
        },
      },
    });

    expect(threadsOpened.map((t) => t.path)).toEqual([`/channels/${CHANNEL}/messages/${ANCHOR}/threads`]);
    expect(posted.map((p) => p.path)).toEqual([`/channels/${ANCHOR}/messages`]);
    expect(posted[0]!.body.flags).toBe(1 << 15);
  });

  it('refuses a card for a thread that belongs to another channel, posting nothing', async () => {
    const adapter = registry.getChannelAdapterExact('discord')!;
    posted.length = 0;
    const delivered = adapter.deliver(`discord:${GUILD}:${CHANNEL}`, `discord:${GUILD}:${CHANNEL}:${OTHER_THREAD}`, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        fallbackText: 'Deploys: 12',
        spec: { root: 'card', elements: { card: { type: 'Card', props: { title: 'Deploys' }, children: [] } } },
      },
    });

    await expect(delivered).rejects.toThrow(`does not belong to channel ${CHANNEL}`);
    expect(posted).toEqual([]);
  });

  describe('thread names', () => {
    const threadId = `discord:${GUILD}:${CHANNEL}:${THREAD}`;
    const adapter = () => registry.getChannelAdapterExact('discord')!;

    it('reads a thread’s name and renames it as the bot, returning what the platform stored', async () => {
      await expect(adapter().threadName!(threadId)).resolves.toBe('a thread');
      await expect(adapter().renameThread!(threadId, '  Budget review ')).resolves.toBe('Budget review');
      await expect(adapter().threadName!(threadId)).resolves.toBe('Budget review');
    });

    it('turns a 429 into the wait its header asked for, at once, and does not queue through it', async () => {
      renameRetryAfter = '65';
      try {
        const started = Date.now();
        const refused = await adapter().renameThread!(threadId, 'Never applied').catch((err: unknown) => err);

        expect(refused).toBeInstanceOf(ChannelRateLimitedError);
        expect((refused as ChannelRateLimitedError).retryAfterMs).toBe(65_000);
        expect(Date.now() - started).toBeLessThan(5_000);
      } finally {
        renameRetryAfter = null;
      }
      await expect(adapter().threadName!(threadId)).resolves.toBe('Budget review');
    });

    it('turns a 403 on a rename into a reason an agent can say out loud', async () => {
      renameForbidden = true;
      try {
        await expect(adapter().renameThread!(threadId, 'Never applied')).rejects.toThrow(
          'Discord refused: this bot needs the Manage Threads permission, or to be the one that created the thread.',
        );
      } finally {
        renameForbidden = false;
      }
      await expect(adapter().threadName!(threadId)).resolves.toBe('Budget review');
    });

    it('refuses an id that is not a Discord thread without calling out', async () => {
      await expect(adapter().threadName!('discord:guild:channel')).rejects.toThrow('Not a Discord thread id');
    });

    it('reports a platform refusal as a failure, so a caller never reads it as a name', async () => {
      await expect(adapter().threadName!(`discord:${GUILD}:${CHANNEL}:${DELETED_THREAD}`)).rejects.toThrow('404');
    });
  });

  it('answers every REST call the host made, so no step ran on a faked failure', () => {
    expect(unfaked).toEqual([]);
  });
});
