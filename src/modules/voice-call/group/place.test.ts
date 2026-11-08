import fs from 'fs';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../env.js', async (orig) => ({
  ...(await orig<object>()),
  readEnvFile: (keys: string[]) => Object.fromEntries(keys.map((key) => [key, 'bot-test'])),
}));

const { DiscordBusy, discordPermissions, discordPostMessage, discordPoster, discordThreadKind, placeOf, whoCanSee } =
  await import('./place.js');

const VIEW = String(1 << 10);
const guild = {
  id: 'G1',
  owner_id: 'OWNER',
  roles: [
    { id: 'G1', permissions: VIEW },
    { id: 'R-staff', permissions: '0' },
    { id: 'R-admin', permissions: String(1 << 3) },
  ],
};
const sees = (perms: bigint) => (perms & (1n << 10n)) !== 0n;

afterEach(() => vi.unstubAllGlobals());

describe('placeOf', () => {
  it.each([
    [
      'a Slack channel',
      { channel_type: 'slack-test', platform_id: 'slack:C0TEST' },
      null,
      { platform: 'slack', channelId: 'C0TEST' },
    ],
    ['a Slack DM', { channel_type: 'slack-test', platform_id: 'slack:D0DM' }, null, 'dm'],
    [
      'a Discord channel',
      { channel_type: 'discord', platform_id: 'discord:G1:C1' },
      'discord:G1:C1',
      { platform: 'discord', guildId: 'G1', channelId: 'C1', threadId: null },
    ],
    [
      'a Discord thread',
      { channel_type: 'discord-codex', platform_id: 'discord:G1:C1' },
      'discord:G1:C1:T1',
      { platform: 'discord', guildId: 'G1', channelId: 'C1', threadId: 'T1' },
    ],
    ['a Discord DM', { channel_type: 'discord', platform_id: 'discord:@me:D1' }, null, 'dm'],
    ['another platform', { channel_type: 'telegram', platform_id: 'telegram:1' }, null, null],
  ])('places %s', (_what, mg, thread, expected) => {
    expect(placeOf(mg, thread)).toEqual(expected);
  });
});

describe('discordPermissions', () => {
  it.each([
    ['everyone may view', [], [], true],
    ['the channel hides it from everyone', [], [{ id: 'G1', type: 0, allow: '0', deny: VIEW }], false],
    [
      'a role brings it back after everyone is denied',
      ['R-staff'],
      [
        { id: 'G1', type: 0, allow: '0', deny: VIEW },
        { id: 'R-staff', type: 0, allow: VIEW, deny: '0' },
      ],
      true,
    ],
    [
      'the member is denied over their role',
      ['R-staff'],
      [
        { id: 'R-staff', type: 0, allow: VIEW, deny: '0' },
        { id: 'U1', type: 1, allow: '0', deny: VIEW },
      ],
      false,
    ],
    ['an administrator ignores the channel', ['R-admin'], [{ id: 'G1', type: 0, allow: '0', deny: VIEW }], true],
  ])('%s', (_what, roles, overwrites, visible) => {
    expect(sees(discordPermissions({ guild, member: { roles }, userId: 'U1', overwrites }))).toBe(visible);
  });

  it('lets the guild owner see a channel hidden from everyone', () => {
    const overwrites = [{ id: 'G1', type: 0, allow: '0', deny: VIEW }];
    expect(sees(discordPermissions({ guild, member: { roles: [] }, userId: 'OWNER', overwrites }))).toBe(true);
  });
});

describe('discordThreadKind', () => {
  it.each([
    ['a private thread', { type: 12 }, 'private'],
    ['a public thread', { type: 11 }, 'public'],
    ['a thread this bot gets a 404 for', null, null],
  ])('reads %s as %s', async (_name, thread, kind) => {
    vi.stubGlobal('fetch', async () => (thread ? Response.json(thread) : new Response('{}', { status: 404 })));

    expect(await discordThreadKind('T1', 'discord-kind')).toBe(kind);
  });
});

describe('whoCanSee', () => {
  it('gives up on a platform read that never answers after twenty seconds', async () => {
    vi.stubGlobal('fetch', () => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const check = whoCanSee({ platform: 'slack', channelId: 'C1' }, 'slack', ['slack:U1']).then(
        () => 'answered',
        (err: Error) => err.message,
      );
      await vi.advanceTimersByTimeAsync(20_000);
      expect(await check).toBe('No answer in 20000 ms');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('whoCanSee on Discord', () => {
  it('needs a private thread membership, and skips someone not in the server', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url).pathname.replace('/api/v10', '');
      paths.push(path);
      const body: Record<string, unknown> = {
        '/guilds/G1': guild,
        '/channels/C1': { permission_overwrites: [] },
        '/channels/T1': { type: 12 },
        '/guilds/G1/members/U1': { roles: [] },
        '/guilds/G1/members/U2': { roles: [] },
        '/channels/T1/thread-members/U1': { id: 'T1' },
      };
      return path in body ? Response.json(body[path]) : new Response('{}', { status: 404 });
    });
    const place = { platform: 'discord' as const, guildId: 'G1', channelId: 'C1', threadId: 'T1' };
    const seen = await whoCanSee(place, 'discord-codex', ['discord-codex:U1', 'discord-codex:U2', 'discord-codex:U3']);
    expect([...seen]).toEqual(['U1']);
    expect(paths).toContain('/channels/T1/thread-members/U2');
  });

  const place = { platform: 'discord' as const, guildId: 'G1', channelId: 'C1', threadId: null };
  const answers = (path: string): Response => {
    const body: Record<string, unknown> = {
      '/guilds/G1': guild,
      '/channels/C1': { permission_overwrites: [] },
      '/channels/T1': { type: 11 },
      '/channels/T2': { type: 11 },
      '/guilds/G1/members/U1': { roles: [] },
    };
    return path in body ? Response.json(body[path]) : new Response('{}', { status: 404 });
  };

  it('fetches a guild, channel and member once across a batch, and each thread for itself', async () => {
    const paths: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url).pathname.replace('/api/v10', '');
      paths.push(path);
      return answers(path);
    });
    const reads = new Map<string, Promise<unknown>>();
    for (const threadId of ['T1', 'T2'])
      await whoCanSee({ ...place, threadId }, 'discord-batch', ['discord-batch:U1'], reads);
    expect(paths.sort()).toEqual([
      '/channels/C1',
      '/channels/T1',
      '/channels/T2',
      '/guilds/G1',
      '/guilds/G1/members/U1',
    ]);
  });

  it('spaces its reads on one bot at 20 a second, however many checks run at once', async () => {
    const started: number[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      started.push(Date.now());
      return answers(new URL(url).pathname.replace('/api/v10', ''));
    });
    await Promise.all([1, 2].map(() => whoCanSee(place, 'discord-paced', ['discord-paced:U1'])));
    const gaps = started.sort((a, b) => a - b).map((at, index) => at - (started[index - 1] ?? at));
    expect(started).toHaveLength(6);
    expect(Math.min(...gaps.slice(1))).toBeGreaterThanOrEqual(40);
  });

  it('holds the next read past a 429’s Retry-After', async () => {
    const started: number[] = [];
    vi.stubGlobal('fetch', async () => {
      started.push(Date.now());
      return new Response('{}', { status: 429, headers: { 'retry-after': '0.3' } });
    });
    await expect(whoCanSee(place, 'discord-limited', ['discord-limited:U1'])).rejects.toThrow('429');
    await expect(whoCanSee(place, 'discord-limited', ['discord-limited:U1'])).rejects.toThrow('429');
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(280);
  });

  it('holds reads already waiting when a 429 lands', async () => {
    const started: number[] = [];
    vi.stubGlobal('fetch', async () => {
      started.push(Date.now());
      return new Response('{}', { status: 429, headers: { 'retry-after': '0.3' } });
    });
    const checks = [1, 2].map(() => whoCanSee(place, 'discord-queued', ['discord-queued:U1']));
    await Promise.all(checks.map((check) => expect(check).rejects.toThrow('429')));
    expect(started).toHaveLength(2);
    expect(started[1] - started[0]).toBeGreaterThanOrEqual(280);
  });

  it('keeps the longer cooldown when a shorter 429 lands after it', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      const first = calls === 1;
      if (first) await new Promise((resolve) => setTimeout(resolve, 120));
      return new Response('{}', { status: 429, headers: { 'retry-after': first ? '0.1' : '30' } });
    });
    const checks = [1, 2].map(() => whoCanSee(place, 'discord-overlap', ['discord-overlap:U1']));
    await Promise.all(checks.map((check) => expect(check).rejects.toThrow('429')));

    await expect(whoCanSee(place, 'discord-overlap', ['discord-overlap:U1'])).rejects.toThrow('too many waiting');
    expect(calls).toBe(2);
  });

  it('refuses without calling Discord while a long Retry-After runs', async () => {
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls += 1;
      return new Response('{}', { status: 429, headers: { 'retry-after': '30' } });
    });
    await expect(whoCanSee(place, 'discord-banned', ['discord-banned:U1'])).rejects.toBeInstanceOf(DiscordBusy);
    await expect(whoCanSee(place, 'discord-banned', ['discord-banned:U1'])).rejects.toThrow('too many waiting');
    expect(calls).toBe(1);
  });
});

describe('discordPoster', () => {
  const SEND_IN_THREADS = String((1n << 10n) | (1n << 38n));
  const ATTACH_FILES = 1n << 15n;
  const MANAGE_THREADS = String(1n << 34n);
  const place = { platform: 'discord' as const, guildId: 'G1', channelId: 'C1', threadId: 'T1' };
  const serve = (
    thread: Record<string, unknown>,
    member: Record<string, unknown>,
    roles = SEND_IN_THREADS,
    overwrites: unknown[] = [],
  ) =>
    vi.stubGlobal('fetch', async (url: string) => {
      const body: Record<string, unknown> = {
        '/guilds/G1': {
          ...guild,
          roles: [
            { id: 'G1', permissions: roles },
            { id: 'R-mod', permissions: MANAGE_THREADS },
          ],
        },
        '/channels/C1': { permission_overwrites: overwrites },
        '/channels/T1': thread,
        '/guilds/G1/members/U1': { roles: [], ...member },
      };
      const path = new URL(url).pathname.replace('/api/v10', '');
      return path in body ? Response.json(body[path]) : new Response('{}', { status: 404 });
    });
  const user = { username: 'ana.example', global_name: 'Ana Global' };

  it.each<[string, Record<string, unknown>, Record<string, unknown>, string | undefined, unknown]>([
    [
      'by their server nickname',
      { type: 11 },
      { nick: 'Ana Example', user },
      undefined,
      { name: 'Ana Example', files: false },
    ],
    [
      'by their display name without one',
      { type: 11 },
      { nick: null, user },
      undefined,
      { name: 'Ana Global', files: false },
    ],
    [
      'by their username without either',
      { type: 11 },
      { user: { username: 'ana.example' } },
      undefined,
      { name: 'ana.example', files: false },
    ],
    [
      'with files where they may attach them',
      { type: 11 },
      { user },
      String(BigInt(SEND_IN_THREADS) | ATTACH_FILES),
      { name: 'Ana Global', files: true },
    ],
    ['not where they may only read', { type: 11 }, { user }, String(1n << 10n), null],
    ['not in a locked thread', { type: 11, thread_metadata: { locked: true } }, { user }, undefined, null],
    [
      'in a locked thread they may manage',
      { type: 11, thread_metadata: { locked: true } },
      { user, roles: ['R-mod'] },
      undefined,
      { name: 'Ana Global', files: false },
    ],
    ['not in a private thread they are not in', { type: 12 }, { user }, undefined, null],
    [
      'not while timed out',
      { type: 11 },
      { user, communication_disabled_until: '2999-01-01T00:00:00.000Z' },
      undefined,
      null,
    ],
    [
      'once a timeout has ended',
      { type: 11 },
      { user, communication_disabled_until: '2020-01-01T00:00:00.000Z' },
      undefined,
      { name: 'Ana Global', files: false },
    ],
  ])('lets a person reply %s', async (_case, thread, member, roles, expected) => {
    serve(thread, member, roles);
    expect(await discordPoster(place, 'discord-poster', 'U1')).toEqual(expected);
  });

  it('lets no file through where the channel denies the person attaching one, though their roles allow it', async () => {
    serve({ type: 11 }, { user }, String(BigInt(SEND_IN_THREADS) | ATTACH_FILES), [
      { id: 'U1', type: 1, allow: '0', deny: String(ATTACH_FILES) },
    ]);
    expect(await discordPoster(place, 'discord-poster', 'U1')).toEqual({ name: 'Ana Global', files: false });
  });

  /** Serves the thread a person may post in, each answer after `ms`, counting the reads at once and in all. */
  function slowly(ms: number) {
    const seen = { paths: [] as string[], open: 0, most: 0 };
    const body: Record<string, unknown> = {
      '/guilds/G1': { ...guild, roles: [{ id: 'G1', permissions: SEND_IN_THREADS }] },
      '/channels/C1': { permission_overwrites: [] },
      '/channels/T1': { type: 11 },
      '/guilds/G1/members/U1': { roles: [], user },
    };
    vi.stubGlobal('fetch', async (url: string) => {
      const path = new URL(url).pathname.replace('/api/v10', '');
      seen.paths.push(path);
      seen.most = Math.max(seen.most, (seen.open += 1));
      await new Promise((resolve) => setTimeout(resolve, ms));
      seen.open -= 1;
      return path in body ? Response.json(body[path]) : new Response('{}', { status: 404 });
    });
    return seen;
  }

  it('asks for the guild, channel, thread and member at once, not each after the last', async () => {
    const seen = slowly(300);
    expect(await discordPoster(place, 'discord-poster-together', 'U1')).toEqual({ name: 'Ana Global', files: false });
    expect([seen.paths.length, seen.most]).toEqual([4, 4]);
  });

  it('reads nothing again that a check through the same reads already read', async () => {
    const seen = slowly(5);
    const reads = new Map<string, Promise<unknown>>();
    expect([...(await whoCanSee(place, 'discord-poster-shared', ['discord-poster-shared:U1'], reads))]).toEqual(['U1']);
    expect(await discordPoster(place, 'discord-poster-shared', 'U1', reads)).toEqual({
      name: 'Ana Global',
      files: false,
    });
    expect(seen.paths.sort()).toEqual(['/channels/C1', '/channels/T1', '/guilds/G1', '/guilds/G1/members/U1']);
  });
});

describe('discordPostMessage', () => {
  const body = { content: 'hello', allowed_mentions: { parse: [] }, nonce: 'nonce-example-01', enforce_nonce: true };

  it('posts the body once as the bot, in the thread', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ id: '123456789000000001' });
    });

    expect(await discordPostMessage('discord-post', 'T1', body)).toEqual({ messageId: '123456789000000001' });
    expect(calls).toHaveLength(1);
    expect(new URL(calls[0].url).pathname).toBe('/api/v10/channels/T1/messages');
    expect(calls[0].init).toMatchObject({ method: 'POST', headers: { Authorization: 'Bot bot-test' } });
    expect(JSON.parse(String(calls[0].init.body))).toEqual(body);
  });

  it('sends files with the body as Discord’s multipart form: the body and each file’s place in payload_json, then files[n]', async () => {
    const dir = uniqueTmpRoot('discord-post-files');
    fs.mkdirSync(dir, { recursive: true });
    const files = [
      { path: path.join(dir, 'a'), name: 'shot.png', type: 'image/png', bytes: 'png bytes' },
      { path: path.join(dir, 'b'), name: 'notes.pdf', type: 'application/pdf', bytes: '%PDF-1.7' },
    ];
    for (const file of files) fs.writeFileSync(file.path, file.bytes);
    let form: FormData | undefined;
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      form = init.body as FormData;
      return Response.json({ id: '123456789000000002' });
    });

    expect(await discordPostMessage('discord-files', 'T1', body, files)).toEqual({ messageId: '123456789000000002' });
    expect(JSON.parse(String(form!.get('payload_json')))).toEqual({
      ...body,
      attachments: [
        { id: 0, filename: 'shot.png' },
        { id: 1, filename: 'notes.pdf' },
      ],
    });
    const sent = await Promise.all(
      [0, 1].map(async (n) => {
        const file = form!.get(`files[${n}]`) as File;
        return [file.name, file.type, await file.text()];
      }),
    );
    expect(sent).toEqual([
      ['shot.png', 'image/png', 'png bytes'],
      ['notes.pdf', 'application/pdf', '%PDF-1.7'],
    ]);
  });

  it.each<[string, () => Promise<Response>, unknown]>([
    ['no answer at all', () => Promise.reject(new TypeError('fetch failed')), { unknown: true }],
    ['a server error', async () => new Response('{}', { status: 503 }), { unknown: true }],
    ['a success it cannot read', async () => new Response('not json', { status: 200 }), { unknown: true }],
    [
      'a refusal',
      async () => Response.json({ message: 'Missing Permissions' }, { status: 403 }),
      { error: 'Missing Permissions' },
    ],
    [
      'a rate limit',
      async () => Response.json({ message: 'You are being rate limited.' }, { status: 429 }),
      { error: 'You are being rate limited.' },
    ],
  ])('reads %s as what it says about whether the message posted', async (_case, answer, expected) => {
    vi.stubGlobal('fetch', answer);
    expect(await discordPostMessage('discord-answers', 'T1', body)).toEqual(expected);
  });
});
