import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../env.js', async (orig) => ({
  ...(await orig<object>()),
  readEnvFile: (keys: string[]) => Object.fromEntries(keys.map((key) => [key, 'bot-test'])),
}));
vi.mock('../../log.js', async (orig) => {
  const actual = await orig<typeof import('../../log.js')>();
  return { ...actual, log: { ...actual.log, warn: vi.fn() } };
});

const { log } = await import('../../log.js');
const { registerSlackBot, registerSlackWorkspaceHumans, unregisterSlackBot } =
  await import('../../channels/slack-mentions.js');
const { AVATAR_FETCHES_AT_ONCE, AVATAR_FETCHES_PER_READ, avatarCache, peoplePictures, personAvatars, personOf } =
  await import('./avatars.js');
type Person = import('./avatars.js').Person;

const SLACK_BOT = { userId: 'U0BOTEXAMPLE', username: 'quill-bot', teamId: 'T0EXAMPLE' };
beforeEach(() => registerSlackBot('slack-acme', SLACK_BOT));
afterEach(() => {
  unregisterSlackBot('slack-acme', SLACK_BOT);
  vi.unstubAllGlobals();
});

const person = (n: number): Person => ({
  key: `slack:T0EXAMPLE:U0EXAMPLE${n}`,
  channelType: 'slack-acme',
  userId: `U0EXAMPLE${n}`,
});
const urlOf = (p: Person) => `https://avatars.example/${p.userId}.png`;
const WEEK_MS = 7 * 24 * 60 * 60_000;
const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

function clock(start = Date.UTC(2026, 10, 1)) {
  let at = start;
  return { now: () => at, pass: (ms: number) => void (at += ms) };
}

describe('personOf', () => {
  it('keys a Slack person within the workspace of the bot that archived them, and a Discord person globally', () => {
    expect(personOf('slack-acme:U0EXAMPLE1')).toEqual({
      key: 'slack:T0EXAMPLE:U0EXAMPLE1',
      channelType: 'slack-acme',
      userId: 'U0EXAMPLE1',
      teamId: 'T0EXAMPLE',
    });
    expect(personOf('discord-ops:123456789012345678')).toEqual({
      key: 'discord:123456789012345678',
      channelType: 'discord-ops',
      userId: '123456789012345678',
    });
  });

  it('names nobody for a Slack bot whose workspace is not registered, or a sender id with no platform', () => {
    expect(personOf('slack-unregistered:U0EXAMPLE1')).toBeNull();
    expect(personOf('U0EXAMPLE1')).toBeNull();
  });
});

describe('avatarCache', () => {
  it('answers a miss with nothing at once, fetches it in the background, and the next lookup has it', async () => {
    const fetch = vi.fn(async (p: Person) => urlOf(p));
    const cache = avatarCache(fetch);

    expect(cache.lookup([person(1)])).toEqual(new Map());
    await cache.settled();

    expect(cache.lookup([person(1)])).toEqual(new Map([[person(1).key, urlOf(person(1))]]));
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('starts no fetch inside the lookup that queued it, never waits on one, and does not ask again while it is out', async () => {
    const fetch = vi.fn(() => new Promise<string | null>(() => {}));
    const cache = avatarCache(fetch);

    expect(cache.lookup([person(1)])).toEqual(new Map());
    expect(fetch).not.toHaveBeenCalled();
    await nextTurn();
    expect(cache.lookup([person(1)])).toEqual(new Map());
    await nextTurn();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('keeps a picture for the refresh age, then shows the old one while it fetches again', async () => {
    const time = clock();
    let version = 1;
    const cache = avatarCache(async (p) => `${urlOf(p)}?v=${version}`, time.now);
    cache.lookup([person(1)]);
    await cache.settled();

    version = 2;
    time.pass(WEEK_MS - 1);
    cache.lookup([person(1)]);
    await cache.settled();
    expect(cache.lookup([person(1)]).get(person(1).key)).toBe(`${urlOf(person(1))}?v=1`);

    time.pass(1);
    expect(cache.lookup([person(1)]).get(person(1).key)).toBe(`${urlOf(person(1))}?v=1`);
    await cache.settled();
    expect(cache.lookup([person(1)]).get(person(1).key)).toBe(`${urlOf(person(1))}?v=2`);
  });

  it('remembers that someone has no picture, so it does not ask again until the refresh age', async () => {
    const time = clock();
    const fetch = vi.fn(async () => null);
    const cache = avatarCache(fetch, time.now);
    cache.lookup([person(1)]);
    await cache.settled();
    time.pass(WEEK_MS - 1);
    cache.lookup([person(1)]);
    await nextTurn();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('holds 5,000 people, dropping the one fetched longest ago', async () => {
    const fetch = vi.fn(async (p: Person) => urlOf(p));
    const cache = avatarCache(fetch);
    const everyone = Array.from({ length: 5_001 }, (_, n) => person(n));
    for (let at = 0; at < everyone.length; at += 10) {
      cache.lookup(everyone.slice(at, at + 10));
      await cache.settled();
    }

    expect(cache.lookup([everyone[1]!, everyone[5_000]!]).size).toBe(2);
    expect(cache.lookup([everyone[0]!]).size).toBe(0);
    await cache.settled();
    expect(fetch).toHaveBeenCalledTimes(5_002);
  });

  it('queues at most its per-read share and runs at most its concurrency at once', async () => {
    const pending: Array<() => void> = [];
    let running = 0;
    let most = 0;
    const fetch = vi.fn(
      (p: Person) =>
        new Promise<string>((resolve) => {
          running += 1;
          most = Math.max(most, running);
          pending.push(() => {
            running -= 1;
            resolve(urlOf(p));
          });
        }),
    );
    const cache = avatarCache(fetch);
    const crowd = Array.from({ length: 15 }, (_, n) => person(n));

    cache.lookup(crowd);
    await nextTurn();
    while (pending.length > 0) {
      pending.shift()!();
      await Promise.resolve();
      await Promise.resolve();
    }
    await cache.settled();

    expect(fetch).toHaveBeenCalledTimes(AVATAR_FETCHES_PER_READ);
    expect(most).toBe(AVATAR_FETCHES_AT_ONCE);
    expect(cache.lookup(crowd).size).toBe(AVATAR_FETCHES_PER_READ);
  });

  it('backs off a failed fetch, doubling the wait each time it fails again', async () => {
    const time = clock();
    const fetch = vi.fn(async () => {
      throw new Error('platform down');
    });
    const cache = avatarCache(fetch, time.now);
    const ask = async () => {
      cache.lookup([person(1)]);
      await cache.settled();
      return fetch.mock.calls.length;
    };

    expect(await ask()).toBe(1);
    time.pass(59_999);
    expect(await ask()).toBe(1);
    time.pass(1);
    expect(await ask()).toBe(2);
    time.pass(119_999);
    expect(await ask()).toBe(2);
    time.pass(1);
    expect(await ask()).toBe(3);
  });
});

describe('peoplePictures', () => {
  const rostered = {
    userId: 'U0ROSTERUSER1',
    username: 'rae',
    teamId: 'T0EXAMPLE',
    imageUrl: 'https://avatars.example/rae.png',
  };
  const defaultPicture = { userId: 'U0ROSTERUSER2', username: 'sol', teamId: 'T0EXAMPLE' };
  beforeEach(() => registerSlackWorkspaceHumans('T0EXAMPLE', [rostered, defaultPicture]));
  afterEach(() => registerSlackWorkspaceHumans('T0EXAMPLE', []));

  it('answers a Slack member from the workspace roster at once, and asks the cache only for someone it does not list', async () => {
    const fetch = vi.fn(async (p: Person) => urlOf(p));
    const cache = avatarCache(fetch);
    const people = ['slack-acme:U0ROSTERUSER1', 'slack-acme:U0ROSTERUSER2', 'slack-acme:U0GUESTUSER1'].map(
      (id) => personOf(id)!,
    );

    expect(peoplePictures(people, cache)).toEqual(new Map([[people[0]!.key, 'https://avatars.example/rae.png']]));
    await cache.settled();
    expect(fetch.mock.calls.map(([asked]) => asked.userId)).toEqual(['U0GUESTUSER1']);
  });
});

describe('fetching through the archiving bot', () => {
  const answer = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('takes a Slack guest’s own 72 px picture from users.info with that bot’s token, and none for Slack’s default', async () => {
    const calls: Array<{ url: string; auth: string | undefined; body: string }> = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, auth: (init.headers as Record<string, string>).Authorization, body: String(init.body) });
      const own = String(init.body).includes('U0ANAEXAMPLE');
      const profile = { is_custom_image: own, image_72: 'https://avatars.example/72.png', image_48: 'x' };
      return answer({ ok: true, user: { profile } });
    });
    const ana = personOf('slack-acme:U0ANAEXAMPLE')!;
    const noPhoto = personOf('slack-acme:U0NOPHOTOUSER')!;

    personAvatars.lookup([ana, noPhoto]);
    await personAvatars.settled();

    expect(personAvatars.lookup([ana, noPhoto])).toEqual(new Map([[ana.key, 'https://avatars.example/72.png']]));
    expect(calls).toEqual([
      { url: expect.stringMatching(/users\.info$/), auth: 'Bearer bot-test', body: 'user=U0ANAEXAMPLE' },
      { url: expect.stringMatching(/users\.info$/), auth: 'Bearer bot-test', body: 'user=U0NOPHOTOUSER' },
    ]);
  });

  it('shows initials for a Slack bot without the scope, and says so once per bot', async () => {
    vi.stubGlobal('fetch', async () => answer({ ok: false, error: 'missing_scope' }));
    const people = [personOf('slack-acme:U0NOSCOPEUSER1')!, personOf('slack-acme:U0NOSCOPEUSER2')!];

    personAvatars.lookup(people);
    await personAvatars.settled();

    expect(personAvatars.lookup(people).size).toBe(0);
    expect(vi.mocked(log.warn).mock.calls.filter(([message]) => message.includes('cannot read people'))).toEqual([
      [expect.any(String), { channelType: 'slack-acme', code: 'missing_scope' }],
    ]);
  });

  it('takes a Discord person’s picture from the CDN, and none for someone with Discord’s default', async () => {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      asked.push(url);
      return answer(url.endsWith('/users/111111111111111111') ? { avatar: 'a1b2c3' } : { avatar: null });
    });
    const withPicture = personOf('discord:111111111111111111')!;
    const without = personOf('discord:222222222222222222')!;

    personAvatars.lookup([withPicture, without]);
    await personAvatars.settled();

    expect(personAvatars.lookup([withPicture, without])).toEqual(
      new Map([[withPicture.key, 'https://cdn.discordapp.com/avatars/111111111111111111/a1b2c3.png?size=128']]),
    );
    expect(asked.map((url) => url.replace(/^.*\/users\//, '/users/'))).toEqual([
      '/users/111111111111111111',
      '/users/222222222222222222',
    ]);
  });
});
