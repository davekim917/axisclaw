/**
 * Slack inbound over the real transport stack: the host's Slack wiring (slack.ts), the real `@chat-adapter/slack`,
 * its `@slack/socket-mode` client and `@slack/web-api`, and the real Chat SDK bridge. Only the network is fake: a
 * local server answers the Web API and speaks the Socket Mode WebSocket protocol, reached through `SLACK_API_URL`.
 * Every other Slack test replaces the adapter or feeds the bridge ready-made messages, so none would notice a
 * dependency bump that changes how an event becomes an inbound message.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type WebSocket } from 'ws';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import { serveAttachments } from '../test-attachment-transport.js';

const BOT_TOKEN = 'xoxb-live-path-test';
const APP_TOKEN = 'xapp-live-path-test';
const TEAM = 'T0TEAMTEST';
const BOT_USER = 'U0BOT';
const HUMAN = 'U0HUMAN';
const CHANNEL = 'C0CHANNELTEST';
const DM = 'D0DIRECT';
/** The bot's profile name, which differs from its install-time `auth.test` username as a renamed bot's does. */
const BOT_DISPLAY_NAME = 'Example Agent';

vi.mock('../env.js', async (importOriginal) => {
  const values: Record<string, string> = { SLACK_BOT_TOKEN: BOT_TOKEN, SLACK_APP_TOKEN: APP_TOKEN };
  return {
    ...(await importOriginal<typeof import('../env.js')>()),
    readEnvFileMatching: (pattern: RegExp) =>
      Object.fromEntries(Object.entries(values).filter(([key]) => pattern.test(key))),
    readEnvFile: () => values,
  };
});

vi.mock('../webhook-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../webhook-server.js')>()),
  registerWebhookAdapter: vi.fn(),
}));

const human = {
  id: HUMAN,
  team_id: TEAM,
  name: 'example.user',
  real_name: 'Example User',
  is_bot: false,
  profile: {
    display_name: 'Example User',
    real_name: 'Example User',
    is_custom_image: true,
    image_72: 'https://avatars.example/example-user-72.png',
  },
};
const noPhoto = {
  id: 'U0NOPHOTOUSER',
  team_id: TEAM,
  name: 'no.photo',
  is_bot: false,
  profile: { real_name: 'No Photo', is_custom_image: false, image_72: 'https://avatars.example/default-72.png' },
};

const REFUSED_BLOCKS = 'Blocks this fake Slack refuses';

function webApi(method: string, body: Record<string, unknown>, port: number): Record<string, unknown> {
  switch (method) {
    case 'auth.test':
      return { ok: true, user_id: BOT_USER, user: 'example-agent', team_id: TEAM, team: 'Example', bot_id: 'B0BOT' };
    case 'apps.connections.open':
      return { ok: true, url: `ws://127.0.0.1:${port}/link` };
    case 'users.info':
      return body.user === BOT_USER
        ? {
            ok: true,
            user: {
              id: BOT_USER,
              team_id: TEAM,
              name: 'example-agent',
              is_bot: true,
              profile: { display_name: BOT_DISPLAY_NAME, real_name: BOT_DISPLAY_NAME },
            },
          }
        : { ok: true, user: human };
    case 'users.list':
      return { ok: true, members: [human, noPhoto], response_metadata: { next_cursor: '' } };
    case 'conversations.info':
      return {
        ok: true,
        channel: body.channel === DM ? { id: DM, is_im: true, user: HUMAN } : { id: CHANNEL, name: 'general' },
      };
    case 'chat.postMessage':
      posted.push(body);
      if (String(body.blocks ?? '').includes(REFUSED_BLOCKS))
        return {
          ok: false,
          error: 'invalid_blocks',
          errors: ['must be a valid url [json-pointer:/blocks/0/accessory/url]'],
          response_metadata: { messages: ['[ERROR] must be a valid url [json-pointer:/blocks/0/accessory/url]'] },
        };
      return { ok: true, channel: body.channel, ts: '1790000099.000100', message: { ts: '1790000099.000100' } };
    case 'bots.info':
      return { ok: true, bot: { id: 'B0BOT', user_id: BOT_USER, name: 'example-agent' } };
    default:
      unfaked.add(method);
      return { ok: false, error: 'not_faked' };
  }
}

let server: http.Server;
let sockets: WebSocketServer;
let socket: WebSocket | null = null;
let sendEnvelope: (id: string, event: Record<string, unknown>) => Promise<void>;
const acks = new Map<string, () => void>();
const apiCalls: Array<{ method: string; auth: string | undefined }> = [];
const unfaked = new Set<string>();
const posted: Array<Record<string, unknown>> = [];
const inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];
const waiters: Array<() => void> = [];
let registry: typeof import('./channel-registry.js');
let savedApiUrl: string | undefined;
/** Holds the bot's own `users.info` answer, so the host's profile lookup is still in flight after setup. */
let releaseBotProfile: () => void = () => {};
const botProfileHeld = new Promise<void>((resolve) => (releaseBotProfile = resolve));

function readBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      if (!raw) return resolve({});
      if ((req.headers['content-type'] ?? '').includes('json')) return resolve(JSON.parse(raw));
      resolve(Object.fromEntries(new URLSearchParams(raw)));
    });
  });
}

function nextInbound(count: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`expected ${count} inbound message(s), got ${inbound.length}`)),
      5_000,
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

let eventSeq = 0;
function message(event: Record<string, unknown>): Record<string, unknown> {
  eventSeq += 1;
  return {
    token: 'unused',
    team_id: TEAM,
    api_app_id: 'A0APP',
    type: 'event_callback',
    event_id: `Ev0LIVE${eventSeq}`,
    event_time: 1_790_000_000 + eventSeq,
    authorizations: [{ team_id: TEAM, user_id: BOT_USER, is_bot: true }],
    event: { team: TEAM, event_ts: event.ts, ...richText(event.text), ...event },
  };
}

/** Slack sends the text a second time as rich_text blocks: code spans as code-styled text, mentions as user elements. */
function richText(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string') return {};
  const elements = text
    .split(/(`[^`]*`)/)
    .filter(Boolean)
    .flatMap((part) => {
      if (part.startsWith('`')) return [{ type: 'text', text: part.slice(1, -1), style: { code: true } }];
      return part
        .split(/(<@[A-Z0-9]+>)/)
        .filter(Boolean)
        .map((piece) => {
          const mention = /^<@([A-Z0-9]+)>$/.exec(piece);
          return mention ? { type: 'user', user_id: mention[1] } : { type: 'text', text: piece };
        });
    });
  return { blocks: [{ type: 'rich_text', block_id: 'b0', elements: [{ type: 'rich_text_section', elements }] }] };
}

beforeAll(async () => {
  const { initMigratedTestDb } = await import('../db/index.js');
  await initMigratedTestDb();

  const answer = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const method = (req.url ?? '').replace(/^\/api\//, '').split('?')[0]!;
    const body = await readBody(req);
    apiCalls.push({ method, auth: req.headers.authorization });
    if (method === 'users.info' && body.user === BOT_USER) await botProfileHeld;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(webApi(method, body, (server.address() as AddressInfo).port)));
  };
  server = http.createServer((req, res) => void answer(req, res));
  sockets = new WebSocketServer({ server, path: '/link' });
  sockets.on('connection', (ws) => {
    socket = ws;
    ws.on('message', (data) => {
      const { envelope_id: id } = JSON.parse(data.toString()) as { envelope_id: string };
      acks.get(id)?.();
    });
    ws.send(JSON.stringify({ type: 'hello', num_connections: 1, connection_info: { app_id: 'A0APP' } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  savedApiUrl = process.env.SLACK_API_URL;
  process.env.SLACK_API_URL = `http://127.0.0.1:${port}/api/`;

  sendEnvelope = (id, payload) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`envelope ${id} was never acknowledged`)), 5_000);
      acks.set(id, () => {
        clearTimeout(timer);
        resolve();
      });
      socket!.send(JSON.stringify({ envelope_id: id, type: 'events_api', accepts_response_payload: false, payload }));
    });

  // A restarted host finds the bot's profile already in the SDK's persisted user cache, so the SDK renders a mention
  // of the bot by its profile name at once, while the host's own profile lookup has yet to answer.
  const { SqliteStateAdapter } = await import('../state-sqlite.js');
  await new SqliteStateAdapter().set(
    `slack:user:${BOT_USER}`,
    { displayName: BOT_DISPLAY_NAME, realName: BOT_DISPLAY_NAME, isBot: true },
    60 * 60 * 1000,
  );

  await import('./slack.js');
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
  const deadline = Date.now() + 5_000;
  while (!socket && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  if (!socket) throw new Error('the Socket Mode client never connected to the fake Slack');
}, 30_000);

afterAll(async () => {
  releaseBotProfile();
  await registry?.teardownChannelAdapters();
  if (savedApiUrl === undefined) delete process.env.SLACK_API_URL;
  else process.env.SLACK_API_URL = savedApiUrl;
  sockets?.close();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  const { closeDb } = await import('../db/index.js');
  await closeDb();
});

describe('Slack inbound through the real adapter and Socket Mode client', () => {
  it('keeps each workspace member’s own picture from users.list, and none for one on Slack’s default', async () => {
    const { getKnownSlackHumans } = await import('./slack-mentions.js');
    await vi.waitFor(() => expect(getKnownSlackHumans().get(TEAM)).toHaveLength(2));
    expect(
      getKnownSlackHumans()
        .get(TEAM)!
        .map(({ userId, imageUrl }) => [userId, imageUrl]),
    ).toEqual([
      [HUMAN, 'https://avatars.example/example-user-72.png'],
      ['U0NOPHOTOUSER', undefined],
    ]);
  });

  it('connects with the app token and calls the Web API with the bot token', () => {
    expect(apiCalls).toContainEqual({ method: 'apps.connections.open', auth: `Bearer ${APP_TOKEN}` });
    expect(apiCalls).toContainEqual({ method: 'auth.test', auth: `Bearer ${BOT_TOKEN}` });
  });

  it('acknowledges a channel message and delivers it unmentioned, as the root of its own thread', async () => {
    inbound.length = 0;
    await sendEnvelope(
      'env-channel',
      message({
        type: 'message',
        channel: CHANNEL,
        channel_type: 'channel',
        user: HUMAN,
        text: 'hello from the live path',
        ts: '1790000001.000100',
      }),
    );
    await nextInbound(1);

    expect(inbound[0]).toMatchObject({
      platformId: `slack:${CHANNEL}`,
      threadId: `slack:${CHANNEL}:1790000001.000100`,
    });
    expect(inbound[0]!.message).toMatchObject({ kind: 'chat-sdk', isMention: false, isDM: false });
    expect(inbound[0]!.message.content).toMatchObject({
      text: 'hello from the live path',
      author: expect.objectContaining({ userId: HUMAN }),
    });
  });

  it('marks an app_mention as a mention while the bot’s own profile lookup is still in flight after a restart', async () => {
    const { getKnownSlackBots } = await import('./slack-mentions.js');
    expect(getKnownSlackBots().get('slack')).toMatchObject({ userId: BOT_USER, username: 'example-agent' });
    expect(getKnownSlackBots().get('slack')?.displayName).toBeUndefined();

    inbound.length = 0;
    await sendEnvelope(
      'env-mention-at-boot',
      message({
        type: 'app_mention',
        channel: CHANNEL,
        user: HUMAN,
        text: `<@${BOT_USER}> are you up?`,
        ts: '1790000003.000100',
      }),
    );
    await nextInbound(1);

    expect(inbound[0]!.message.content).toMatchObject({ text: `@${BOT_DISPLAY_NAME} are you up?` });
    expect(inbound[0]!.message).toMatchObject({ isMention: true, isDM: false });
    releaseBotProfile();
  });

  it('marks an app_mention as a mention and threads the reply under it', async () => {
    inbound.length = 0;
    await sendEnvelope(
      'env-mention',
      message({
        type: 'app_mention',
        channel: CHANNEL,
        user: HUMAN,
        text: `<@${BOT_USER}> status please`,
        ts: '1790000002.000100',
      }),
    );
    await nextInbound(1);

    expect(inbound[0]).toMatchObject({
      platformId: `slack:${CHANNEL}`,
      threadId: `slack:${CHANNEL}:1790000002.000100`,
    });
    expect(inbound[0]!.message).toMatchObject({ isMention: true, isDM: false });
  });

  it('delivers a channel mention once, though Slack sends it as both a message and an app_mention', async () => {
    inbound.length = 0;
    const event = { channel: CHANNEL, user: HUMAN, text: `<@${BOT_USER}> one delivery`, ts: '1790000006.000100' };
    await sendEnvelope('env-pair-message', message({ type: 'message', channel_type: 'channel', ...event }));
    await sendEnvelope('env-pair-mention', message({ type: 'app_mention', ...event }));
    await nextInbound(1);
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(inbound).toHaveLength(1);
    expect(inbound[0]!.message).toMatchObject({ isMention: true });
  });

  it('demotes a channel mention that appears only inside code', async () => {
    inbound.length = 0;
    await sendEnvelope(
      'env-code-mention',
      message({
        type: 'app_mention',
        channel: CHANNEL,
        user: HUMAN,
        text: `the syntax is \`<@${BOT_USER}>\``,
        ts: '1790000005.000100',
      }),
    );
    await nextInbound(1);

    expect(inbound[0]!.message).toMatchObject({ isMention: false, isDM: false });
  });

  it('says why it demotes a mention the platform confirmed but the bot is named only inside code', async () => {
    const { log } = await import('../log.js');
    const info = vi.spyOn(log, 'info');
    inbound.length = 0;
    // Plain mrkdwn with no rich_text blocks: the SDK classifies the text, where an unclosed fence is not code, and
    // reports a mention, while the body the agent reads keeps the mention inside a code block.
    await sendEnvelope(
      'env-fenced-mention',
      message({
        type: 'app_mention',
        channel: CHANNEL,
        user: HUMAN,
        text: `usage:\n\`\`\`\n<@${BOT_USER}> ship 42`,
        ts: '1790000013.000100',
        blocks: undefined,
      }),
    );
    await nextInbound(1);

    expect(inbound[0]!.message).toMatchObject({ isMention: false });
    expect(info.mock.calls.filter(([line]) => line.startsWith('Platform mention demoted'))).toEqual([
      [
        'Platform mention demoted: no mention of the bot outside code',
        expect.objectContaining({
          channelType: 'slack',
          threadId: `slack:${CHANNEL}:1790000013.000100`,
          messageId: '1790000013.000100',
          checkedNames: expect.arrayContaining([`<@${BOT_USER}>`, 'example-agent', BOT_DISPLAY_NAME]),
        }),
      ],
    ]);
    info.mockRestore();
  });

  it('keeps a list from Slack’s composer as a list, nested item included', async () => {
    inbound.length = 0;
    const item = (text: string) => ({ type: 'rich_text_section', elements: [{ type: 'text', text }] });
    await sendEnvelope(
      'env-list',
      message({
        type: 'message',
        channel: CHANNEL,
        channel_type: 'channel',
        user: HUMAN,
        text: 'steps:\n• build\n• ship\n    ◦ tag it',
        ts: '1790000010.000100',
        blocks: [
          {
            type: 'rich_text',
            block_id: 'b0',
            elements: [
              { type: 'rich_text_section', elements: [{ type: 'text', text: 'steps:\n' }] },
              { type: 'rich_text_list', style: 'bullet', indent: 0, elements: [item('build'), item('ship')] },
              { type: 'rich_text_list', style: 'bullet', indent: 1, elements: [item('tag it')] },
            ],
          },
        ],
      }),
    );
    await nextInbound(1);

    expect(inbound[0]!.message.content).toMatchObject({ text: 'steps:\n\n- build\n- ship\n  - tag it' });
  });

  it('reads an integration’s Block Kit message from its blocks, not its notification text', async () => {
    inbound.length = 0;
    await sendEnvelope(
      'env-blocks',
      message({
        type: 'message',
        channel: CHANNEL,
        channel_type: 'channel',
        user: HUMAN,
        text: 'Deploy report',
        ts: '1790000011.000100',
        blocks: [
          { type: 'header', text: { type: 'plain_text', text: 'Deploy report' } },
          { type: 'section', text: { type: 'mrkdwn', text: 'web shipped 3 changes' } },
        ],
      }),
    );
    await nextInbound(1);

    expect(inbound[0]!.message.content).toMatchObject({ text: 'Deploy report\n\nweb shipped 3 changes' });
  });

  it('delivers a composer list past the markdown parse budget with its punctuation as typed', async () => {
    inbound.length = 0;
    const typed = `${'select source_data.x from schema.table where x = 1; '.repeat(240)}R&D, typed &#95; &lt; &amp; <@U0OTHER>`;
    await sendEnvelope(
      'env-long-list',
      message({
        type: 'message',
        channel: CHANNEL,
        channel_type: 'channel',
        user: HUMAN,
        text: `• ${typed.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')} and code \`&amp;#95;\``,
        ts: '1790000012.000100',
        blocks: [
          {
            type: 'rich_text',
            block_id: 'b0',
            elements: [
              {
                type: 'rich_text_list',
                style: 'bullet',
                indent: 0,
                elements: [
                  {
                    type: 'rich_text_section',
                    elements: [
                      { type: 'text', text: typed },
                      { type: 'text', text: ' and code ' },
                      { type: 'text', text: '&#95;', style: { code: true } },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      }),
    );
    await nextInbound(1);

    expect(inbound[0]!.message.content).toMatchObject({ text: `- ${typed} and code \`&#95;\`` });
    // The adapter's unparsed fallback, the path the decoding serves: the whole body in one text node.
    expect((inbound[0]!.message.content as { formatted: unknown }).formatted).toEqual({
      type: 'root',
      children: [{ type: 'paragraph', children: [{ type: 'text', value: `- ${typed} and code \`&#95;\`` }] }],
    });
  });

  it('keeps a thread reply in its thread', async () => {
    inbound.length = 0;
    await sendEnvelope(
      'env-thread',
      message({
        type: 'message',
        channel: CHANNEL,
        channel_type: 'channel',
        user: HUMAN,
        text: 'a reply in the thread',
        ts: '1790000003.000200',
        thread_ts: '1790000001.000100',
      }),
    );
    await nextInbound(1);

    expect(inbound[0]).toMatchObject({
      platformId: `slack:${CHANNEL}`,
      threadId: `slack:${CHANNEL}:1790000001.000100`,
    });
    expect(inbound[0]!.message.content).toMatchObject({ text: 'a reply in the thread' });
  });

  it('delivers a direct message as a DM addressed to the bot', async () => {
    inbound.length = 0;
    await sendEnvelope(
      'env-dm',
      message({
        type: 'message',
        channel: DM,
        channel_type: 'im',
        user: HUMAN,
        text: 'a private question',
        ts: '1790000004.000100',
      }),
    );
    await nextInbound(1);

    expect(inbound[0]).toMatchObject({ platformId: `slack:${DM}`, threadId: `slack:${DM}:1790000004.000100` });
    expect(inbound[0]!.message).toMatchObject({ isMention: true, isDM: true });
    expect(inbound[0]!.message.content).toMatchObject({ text: 'a private question' });
  });

  it('downloads a shared file above the adapter default with the bot token, and refuses one above the host limit', async () => {
    const { INBOUND_ATTACHMENT_MAX_BYTES } = await import('../config.js');
    const MiB = 1024 * 1024;
    const big = 'https://files.slack.com/files-pri/T0TEAMTEST-F0BIG/originals.zip';
    const huge = 'https://files.slack.com/files-pri/T0TEAMTEST-F0HUGE/footage.zip';
    const requests = serveAttachments(
      new Map([
        [big, 30 * MiB],
        [huge, INBOUND_ATTACHMENT_MAX_BYTES + 1],
      ]),
    );
    const file = (id: string, name: string, size: number, url: string) => ({
      id,
      name,
      mimetype: 'application/zip',
      filetype: 'zip',
      size,
      url_private: url,
      url_private_download: url,
    });
    inbound.length = 0;
    await sendEnvelope(
      'env-files',
      message({
        type: 'message',
        subtype: 'file_share',
        channel: CHANNEL,
        channel_type: 'channel',
        user: HUMAN,
        text: 'the archives',
        ts: '1790000007.000100',
        files: [file('F0HUGE', 'footage.zip', 101 * MiB, huge), file('F0BIG', 'originals.zip', 30 * MiB, big)],
      }),
    );
    await nextInbound(1);

    const attachments = (inbound[0]!.message.content as { attachments: Array<{ name: string; data?: string }> })
      .attachments;
    expect(attachments.map((a) => a.name)).toEqual(['footage.zip', 'originals.zip']);
    expect(attachments[0]!.data).toBeUndefined();
    expect(Buffer.from(attachments[1]!.data ?? '', 'base64').length).toBe(30 * MiB);
    expect(requests).toEqual([{ url: big, authorization: `Bearer ${BOT_TOKEN}` }]);
  });

  it.each([
    ['declared truthfully, without requesting the file that would not fit', 'honest', 2],
    ['understated, by checking the bytes that arrived', 'understated', 3],
  ])("stops a message's files at the per-message budget when their sizes are %s", async (_label, sizes, fetched) => {
    const { INBOUND_ATTACHMENTS_PER_MESSAGE_MAX_BYTES } = await import('../config.js');
    const MiB = 1024 * 1024;
    const each = Math.floor(INBOUND_ATTACHMENTS_PER_MESSAGE_MAX_BYTES / 2.5);
    const urls = ['F0ONE', 'F0TWO', 'F0THREE'].map(
      (id) => `https://files.slack.com/files-pri/T0TEAMTEST-${id}/part.bin`,
    );
    const requests = serveAttachments(new Map(urls.map((url) => [url, each])));
    inbound.length = 0;
    await sendEnvelope(
      `env-budget-${sizes}`,
      message({
        type: 'message',
        subtype: 'file_share',
        channel: CHANNEL,
        channel_type: 'channel',
        user: HUMAN,
        text: 'three parts',
        ts: sizes === 'honest' ? '1790000008.000100' : '1790000009.000100',
        files: urls.map((url, i) => ({
          id: `F0PART${i}`,
          name: `part${i}.bin`,
          mimetype: 'application/octet-stream',
          size: sizes === 'honest' ? each : 1024,
          url_private: url,
        })),
      }),
    );
    await nextInbound(1);

    const attachments = (inbound[0]!.message.content as { attachments: Array<{ data?: string }> }).attachments;
    expect(attachments.map((a) => Buffer.from(a.data ?? '', 'base64').length)).toEqual([each, each, 0]);
    expect(requests.map((request) => request.url)).toEqual(urls.slice(0, fetched));
    expect(each).toBeGreaterThan(25 * MiB);
  });

  it('posts an agent reply into its thread through chat.postMessage', async () => {
    const adapter = registry.getChannelAdapterExact('slack')!;
    const id = await adapter.deliver(`slack:${CHANNEL}`, `slack:${CHANNEL}:1790000001.000100`, {
      kind: 'chat',
      content: { text: 'a reply from the agent' },
    });

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ channel: CHANNEL, thread_ts: '1790000001.000100' });
    expect(JSON.stringify(posted[0])).toContain('a reply from the agent');
    expect(id).toBe('1790000099.000100');
  });

  it('posts an agent card in its thread as the Block Kit it was checked against, rich pieces included', async () => {
    const adapter = registry.getChannelAdapterExact('slack')!;
    posted.length = 0;
    const id = await adapter.deliver(`slack:${CHANNEL}`, `slack:${CHANNEL}:1790000001.000100`, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        fallbackText: 'Deploys: ledger-api 9',
        spec: {
          root: 'card',
          elements: {
            card: { type: 'Card', props: {}, children: ['title', 'rows', 'links'] },
            title: {
              type: 'Text',
              props: { content: 'Deploys', button: { label: 'Open', url: 'https://example.com/deploys' } },
              children: [],
            },
            rows: {
              type: 'Table',
              props: {
                headers: ['Service', 'Deploys'],
                rows: [
                  [
                    { text: 'ledger-api', url: 'https://example.com/ledger' },
                    { text: '9', value: 9 },
                  ],
                ],
              },
              children: [],
            },
            links: { type: 'Actions', props: {}, children: ['all'] },
            all: {
              type: 'LinkButton',
              props: { label: 'All services', url: 'https://example.com/all', style: 'primary' },
              children: [],
            },
          },
        },
      },
    });

    expect(id).toBe('1790000099.000100');
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ channel: CHANNEL, thread_ts: '1790000001.000100' });
    const blocks = JSON.parse(posted[0]!.blocks as string) as Array<Record<string, unknown>>;
    expect(blocks.map((block) => block.type)).toEqual(['section', 'data_table', 'actions']);
    expect(blocks[0]!.accessory).toMatchObject({ type: 'button', url: 'https://example.com/deploys' });
    expect((blocks[1]!.rows as unknown[][])[1]).toEqual([
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [{ type: 'link', url: 'https://example.com/ledger', text: 'ledger-api' }],
          },
        ],
      },
      { type: 'raw_number', value: 9, text: '9' },
    ]);
    expect((blocks[2]!.elements as unknown[])[0]).toMatchObject({ url: 'https://example.com/all', style: 'primary' });
  });

  it('hands the agent Slack’s reason when Slack refuses a card’s blocks', async () => {
    const adapter = registry.getChannelAdapterExact('slack')!;
    const refused = adapter.deliver(`slack:${CHANNEL}`, `slack:${CHANNEL}:1790000001.000100`, {
      kind: 'chat-sdk',
      content: {
        type: 'card',
        fallbackText: 'Report',
        spec: {
          root: 'card',
          elements: {
            card: { type: 'Card', props: {}, children: ['note'] },
            note: {
              type: 'Text',
              props: { content: REFUSED_BLOCKS, button: { label: 'Open', url: 'https://example.com/report' } },
              children: [],
            },
          },
        },
      },
    });

    await expect(refused).rejects.toThrow(
      'Slack rejected blocks (invalid_blocks): ["must be a valid url [json-pointer:/blocks/0/accessory/url]"',
    );
  });

  it('answers every Web API call the host made, so no step ran on a faked failure', () => {
    expect([...unfaked]).toEqual([]);
  });
});
