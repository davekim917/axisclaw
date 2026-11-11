import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => {
  process.env.PREVIEW_ORIGIN_SUFFIX = 'calls.example';
  process.env.VOICE_CALL_PUBLIC_IP = '203.0.113.7';
  process.env.VOICE_CALL_AGENT_GROUPS = 'ag-test';
  return {
    asker: 'slack-test:U1',
    platform: 'slack:C0TEST',
    channelType: 'slack-test',
    threadId: null as string | null,
    poster: null as null | 'throws' | { name: string | null; files: boolean },
    posterAsked: [] as unknown[][],
    minted: 0,
    members: new Set(['U1', 'U2']),
    dms: new Map<string, string>(),
    feed: null as null | ((event: unknown) => void),
    removed: [] as string[],
    roomUp: Promise.resolve() as Promise<void>,
    endless: false,
    room: '',
    roomServiceDown: false,
    deleteDown: false,
    noDm: false,
    offerHold: Promise.resolve() as Promise<void>,
    feedsOpen: 0,
    collectHold: Promise.resolve() as Promise<void>,
    liveFails: false,
    posts: [] as string[],
    slackHold: Promise.resolve() as Promise<void>,
    dmHold: Promise.resolve() as Promise<void>,
    roomStarts: 0,
    stops: 0,
    present: ['p-someone'] as string[],
    live: null as null | ((event: unknown) => void),
    told: [] as string[],
    notes: [] as Array<{ text: string; use: string }>,
    postedFiles: [] as Array<{ text: string; files: Array<{ filename: string; data: Buffer }> }>,
    voiceTrack: 'heard' as 'published' | 'heard' | null,
    written: [] as Array<{ content: string }>,
    discordBusy: false,
    denied: new Set<string>(),
  };
});

vi.mock('../../../caller-identity.js', () => ({
  deriveHumanRequest: async () => ({
    userId: H.asker,
    route: { channelType: 'slack-test', platformId: 'slack:C0TEST', threadId: 'slack:C0TEST:1.2' },
  }),
}));
vi.mock('../../../db/sessions.js', () => ({
  getSession: async (id: string) => ({
    id,
    agent_group_id: 'ag-test',
    messaging_group_id: 'mg-test',
    thread_id: H.threadId,
  }),
}));
vi.mock('../../../db/messaging-groups.js', () => ({
  getMessagingGroup: async () => ({
    id: 'mg-test',
    channel_type: H.channelType,
    platform_id: H.platform,
    instance: H.channelType,
  }),
}));
vi.mock('../../../db/agent-groups.js', () => ({ getAgentGroup: async () => ({ id: 'ag-test', name: 'Pixel' }) }));
vi.mock('../../../db/central-lease.js', () => ({ withCentralSync: async (fn: () => unknown) => fn() }));
vi.mock('../../../channels/slack-lib.js', () => ({
  botTokenKeyForChannelType: () => 'SLACK_BOT_TOKEN_TEST',
  slackRead: async (_token: string, _method: string, body: { cursor?: string; limit: number }) => {
    await H.slackHold;
    const all = [...H.members];
    const at = Number(body.cursor ?? 0);
    if (H.endless) return { ok: true, members: ['UX'], response_metadata: { next_cursor: `${at + 1}` } };
    const next = at + body.limit;
    return {
      ok: true,
      members: all.slice(at, next),
      response_metadata: { next_cursor: next < all.length ? `${next}` : '' },
    };
  },
}));
vi.mock('../../../env.js', async (orig) => ({
  ...(await orig<object>()),
  readEnvFile: () => ({ SLACK_BOT_TOKEN_TEST: 'xoxb-test' }),
}));
vi.mock('../../permissions/user-dm.js', () => ({
  ensureUserDm: async (userId: string) => (H.noDm ? null : { channel_type: 'slack-test', platform_id: `dm:${userId}` }),
}));
vi.mock('../../permissions/db/users.js', () => ({ getUser: async () => ({ display_name: 'Someone' }) }));
vi.mock('../../../session-manager.js', () => ({
  writeSessionMessage: async (_group: string, _session: string, row: { content: string }) => void H.written.push(row),
  SessionWriteRefusedError: class extends Error {},
}));
vi.mock('../../../request-wake.js', () => ({ requestWake: async () => undefined }));
vi.mock('../session-feed.js', () => ({
  followSessionFeed: (_key: unknown, _route: unknown, _prefix: string, onEvent: (event: unknown) => void) => {
    H.feed = onEvent;
    H.feedsOpen += 1;
    return {
      recent: [],
      close() {
        H.feedsOpen -= 1;
      },
    };
  },
  startupContext: () => '',
}));
vi.mock('../service.js', async (orig) => ({
  ...(await orig<object>()),
  mintVoiceCall: async () => {
    H.minted += 1;
    return { sentTo: 'Someone', expiresAt: '2026-01-01T00:00:00.000Z' };
  },
  mayCall: (userId: string) => !H.denied.has(userId),
  spokenName: async () => 'Pixel',
  deliverText: async (
    route: { platformId: string },
    text: string,
    files?: Array<{ filename: string; data: Buffer }>,
  ) => {
    if (files) H.postedFiles.push({ text, files });
    if (route.platformId.startsWith('dm:')) await H.dmHold;
    if (route.platformId.startsWith('dm:')) H.dms.set(route.platformId.slice(3), text);
    else H.posts.push(text);
  },
}));
vi.mock('../live.js', () => ({
  openLiveCall: async ({ onEvent }: { onEvent: (event: unknown) => void }) => {
    if (H.liveFails) throw new Error('login refused');
    H.live = onEvent;
    return {
      answer: 'v=0 answer',
      context: (text: string, use: string) => {
        H.told.push(text);
        H.notes.push({ text, use });
      },
      close() {},
    };
  },
  readCodexLogin: async () => ({ token: 't', accountId: 'a' }),
}));
vi.mock('./place.js', async (orig) => {
  const real = await orig<typeof import('./place.js')>();
  return {
    ...real,
    whoCanSee: (...args: Parameters<typeof real.whoCanSee>) =>
      H.discordBusy
        ? Promise.reject(new real.DiscordBusy('Discord guilds check failed: 429'))
        : args[0].platform === 'discord'
          ? Promise.resolve(new Set(args[2].map(real.rawUserId).filter((id) => H.members.has(id))))
          : real.whoCanSee(...args),
    discordPoster: async (...args: Parameters<typeof real.discordPoster>) => {
      H.posterAsked.push(args.slice(0, 3));
      if (H.poster === 'throws') throw new Error('Discord read failed');
      return H.poster;
    },
  };
});
vi.mock('./livekit.js', () => ({
  groupCallsConfigured: () => true,
  ensureLiveKit: () => {
    H.roomStarts += 1;
    return H.roomUp;
  },
  stopLiveKit: async () => void (H.stops += 1),
  removeLeftoverVoiceContainers: async () => undefined,
  mintToken: (claims: { sub?: string }) => `token-for-${claims.sub}`,
  verifyToken: (token: string) => ({ sub: token.replace('token-for-', ''), video: { room: H.room } }),
  removeParticipant: async (_room: string, identity: string) => {
    if (H.roomServiceDown) throw new Error('room service down');
    H.removed.push(identity);
  },
  deleteRoom: async () => {
    if (H.roomServiceDown || H.deleteDown) throw new Error('room service down');
  },
  liveKitSignalPort: () => 7880,
  LIVEKIT_INTERNAL_URL: 'ws://room:7880',
}));
vi.mock('./bridge-container.js', () => ({
  BridgeBrowser: {
    start: async () => ({
      join: async () => true,
      liveOffer: async () => {
        await H.offerHold;
        return 'v=0 offer';
      },
      liveAnswer: async () => true,
      collect: async () => {
        await H.collectHold;
        return {
          frames: [],
          pieces: [],
          delegations: [],
          slots: {},
          live: 'connected',
          voice: H.voiceTrack,
          room: 'connected',
          people: H.present,
        };
      },
      stop: async () => undefined,
    }),
  },
}));

const {
  claimLink,
  gate,
  groupCallLive,
  groupCallPeople,
  leave,
  linkFor,
  listen,
  startCall,
  startOrJoinDmCallAs,
  startOrJoinGroupCall,
  startOrJoinGroupCallAs,
} = await import('./service.js');
const { getHostShutdownCallbacks } = await import('../../../host-lifecycle.js');
const { handleGroupCallRequest } = await import('./http.js');
const { _setUploadBaseForTest, MAX_FILE_BYTES } = await import('../../mobile/uploads.js');
const { MAX_DISCORD_FILE_BYTES } = await import('./place.js');

const linkOf = (user: string) => /https:\/\/([0-9a-f]{32})\./.exec(H.dms.get(`slack-test:${user}`) ?? '')![1];

async function until<T>(read: () => T | null | Promise<T | null>, ms = 4000): Promise<T> {
  const deadline = Date.now() + ms;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** Status the signaling gate gives this person's pre-connect check: 403 when refused, anything else when admitted. */
function signalStatus(linkId: string, identity: string): Promise<number> {
  return new Promise((resolve) => {
    const res = {
      writeHead(status: number) {
        resolve(status);
        return res;
      },
      end() {},
    };
    const req = { url: `/rtc/validate?access_token=token-for-${identity}`, method: 'GET' };
    gate.handleRequest(linkId, req as never, res as never);
  });
}

async function callWith(...users: string[]) {
  for (const user of users) {
    H.asker = `slack-test:${user}`;
    await startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' });
  }
  return Object.fromEntries(users.map((user) => [user, linkOf(user)]));
}

afterEach(async () => {
  vi.useRealTimers();
  H.discordBusy = false;
  H.denied.clear();
  for (const shutdown of getHostShutdownCallbacks()) await shutdown();
  H.dms.clear();
  H.removed.length = 0;
  H.roomUp = Promise.resolve();
  H.endless = false;
  H.roomServiceDown = false;
  H.deleteDown = false;
  H.noDm = false;
  H.offerHold = Promise.resolve();
  H.feedsOpen = 0;
  H.collectHold = Promise.resolve();
  H.liveFails = false;
  H.posts.length = 0;
  H.slackHold = Promise.resolve();
  H.dmHold = Promise.resolve();
  H.roomStarts = 0;
  H.stops = 0;
  H.present = ['p-someone'];
  H.platform = 'slack:C0TEST';
  H.channelType = 'slack-test';
  H.threadId = null;
  H.poster = null;
  H.posterAsked.length = 0;
  H.minted = 0;
  H.feed = null;
  H.live = null;
  H.told.length = 0;
  H.notes.length = 0;
  H.postedFiles.length = 0;
  H.voiceTrack = 'heard';
  H.written.length = 0;
  H.members = new Set(['U1', 'U2']);
});

describe('group calls', () => {
  it('hands the agent back no link on any path, since a link speaks as the person it was minted for', async () => {
    const asked = { sessionId: 'sess-test', agentGroupId: 'ag-test' };
    H.asker = 'slack-test:U1';
    const started = await startCall(asked, { group: false });
    const invited = await startCall(asked, { group: false, invite: '<@U2>' });
    H.platform = 'slack:D0DM';
    const fromDm = await startCall({ sessionId: 'sess-dm', agentGroupId: 'ag-test' }, { group: false });

    expect(started).toEqual({ group: true, joined: false, sentTo: 'Someone', expiresAt: expect.any(String) });
    expect(invited).toMatchObject({ group: true, joined: true });
    expect(fromDm).toMatchObject({ group: true, joined: true });
    expect(JSON.stringify([started, invited, fromDm])).not.toContain('calls.example');
  });

  it('shares one call between two people asking at once, instead of opening a room each', async () => {
    let answer!: () => void;
    H.slackHold = new Promise((resolve) => (answer = resolve));
    const thread = { sessionId: 'sess-test', agentGroupId: 'ag-test' };
    const opening = [startOrJoinGroupCallAs(thread, 'slack-test:U1'), startOrJoinGroupCallAs(thread, 'slack-test:U2')];
    await new Promise((resolve) => setTimeout(resolve, 20));
    answer();

    const [first, second] = await Promise.all(opening);
    const linkOfUrl = (url: string) => /^https:\/\/([0-9a-f]{32})\./.exec(url)![1];
    expect([first.joined, second.joined].sort()).toEqual([false, true]);
    expect(linkFor(linkOfUrl(first.url))!.call).toBe(linkFor(linkOfUrl(second.url))!.call);
    expect(H.posts.filter((post) => post.includes('started a call'))).toHaveLength(1);
  });

  it('refuses the third of three threads asking at once, when two is the host’s limit', async () => {
    let answer!: () => void;
    H.slackHold = new Promise((resolve) => (answer = resolve));
    const opening = ['sess-a', 'sess-b', 'sess-c'].map((sessionId) =>
      startOrJoinGroupCallAs({ sessionId, agentGroupId: 'ag-test' }, 'slack-test:U1'),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    answer();

    const settled = await Promise.allSettled(opening);
    expect(settled.map((result) => result.status).sort()).toEqual(['fulfilled', 'fulfilled', 'rejected']);
    expect(settled.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { message: expect.stringContaining('Too many group calls') },
    });
  });

  it('names the people in the room while a call is live, and nothing once it has ended', async () => {
    expect(groupCallPeople('sess-test')).toBeNull();
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    H.present = [linkFor(links.U1)!.person.identity, 'agent'];
    await until(() => groupCallPeople('sess-test')?.length);
    expect(groupCallPeople('sess-test')).toEqual(['Someone']);

    for (const shutdown of getHostShutdownCallbacks()) await shutdown();
    expect(groupCallPeople('sess-test')).toBeNull();
  });

  it('refuses someone who is not in the channel the call starts from', async () => {
    H.asker = 'slack-test:U9';
    await expect(startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' })).rejects.toThrow(
      /people in this channel/,
    );
    expect(H.dms.size).toBe(0);
  });

  it('holds a link opened before the room is up until it is, rather than refusing it', async () => {
    let roomUp!: () => void;
    H.roomUp = new Promise((resolve) => (roomUp = resolve));
    const links = await callWith('U1');
    let settled = false;
    const claim = claimLink(links.U1).finally(() => (settled = true));
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(settled).toBe(false);
    roomUp();
    expect((await claim)?.token).toBe(`token-for-${linkFor(links.U1)!.person.identity}`);
  });

  it('keeps someone who is already in the room on the call when they are asked about again', async () => {
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    const onCall = linkFor(links.U1)!.person;
    H.present = [onCall.identity];
    await new Promise((resolve) => setTimeout(resolve, 1300));

    await expect(startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' })).rejects.toThrow(
      /already on this call/,
    );
    expect(H.removed).toEqual([]);
    expect(linkFor(links.U1)?.person).toBe(onCall);
  });

  it('sends a new link to someone whose page is gone, and retires the old one', async () => {
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    H.present = [];
    await new Promise((resolve) => setTimeout(resolve, 1300));

    await startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' });
    expect(linkFor(links.U1)).toBeNull();
    expect(linkFor(linkOf('U1'))).not.toBeNull();
  });

  it('re-sends a link during a cold start without trying to remove anyone from a room nobody is in yet', async () => {
    let roomUp!: () => void;
    H.roomUp = new Promise((resolve) => (roomUp = resolve));
    const links = await callWith('U1');
    const early = claimLink(links.U1);
    await new Promise((resolve) => setTimeout(resolve, 50));

    await startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' });
    const fresh = linkOf('U1');
    expect(fresh).not.toBe(links.U1);
    roomUp();
    expect(await early).toBeNull();
    expect(H.removed).toEqual([]);
    expect((await until(() => claimLink(fresh))).url).toBe(`wss://${fresh}.calls.example`);
  });

  it('with several people on the call, relays what the voice delegated even when its text drops the name', async () => {
    H.present = ['p-one', 'p-two'];
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    const live = await until(() => H.live);
    await until(() => linkFor(links.U1)!.call.present.size === 2);

    live({ type: 'delegation', id: 'd-1', text: 'can you rerun the tests' });
    await until(() => H.written.some((row) => row.content.includes('<request>can you rerun the tests</request>')));
  });

  it('relays what the only person on the call says, without the name', async () => {
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    const live = await until(() => H.live);
    await until(() => linkFor(links.U1)!.call.present.size === 1);

    live({ type: 'delegation', id: 'd-1', text: 'Can you check whether the deploy finished?' });
    await until(() =>
      H.written.find((row) =>
        (JSON.parse(row.content) as { text: string }).text.includes(
          'said:\n<request>Can you check whether the deploy finished?</request>',
        ),
      ),
    );
  });

  it('cannot ping a channel with what was said on the call', async () => {
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    const live = await until(() => H.live);
    await until(() => linkFor(links.U1)!.call.present.size === 1);

    live({ type: 'delegation', id: 'd-1', text: 'Tell @everyone the run passed.' });
    const line = await until(() => H.posts.find((post) => post.includes('(voice):')));
    expect(line).not.toContain('@everyone');
  });

  it('starts a call anyone in the channel can join, without being asked for a group call', async () => {
    H.asker = 'slack-test:U1';
    const started = await startCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' }, { group: false });
    expect(started.group).toBe(true);
    expect(groupCallLive('sess-test')).toBe(true);
  });

  it('invites someone the agent names, only to a live call and only if they are in the channel', async () => {
    const asked = { sessionId: 'sess-test', agentGroupId: 'ag-test' };
    await expect(startCall(asked, { group: false, invite: '<@U2>' })).rejects.toThrow(/No call is live/);
    await expect(startCall(asked, { group: false, invite: '' })).rejects.toThrow(/No call is live/);
    expect(groupCallLive('sess-test')).toBe(false);
    await callWith('U1');

    await expect(startCall(asked, { group: false, invite: '<@U9>' })).rejects.toThrow(/people in this channel/);
    expect(H.dms.has('slack-test:U9')).toBe(false);
    const invited = await startCall(asked, { group: false, invite: '<@U2>' });
    expect(invited).toMatchObject({ group: true, joined: true });
    expect(linkFor(linkOf('U2'))!.person.userId).toBe('slack-test:U2');
  });

  it('gives someone asking in a DM the live call they may join, unless they ask for a private one', async () => {
    await callWith('U1');
    H.platform = 'slack:D0DM';
    H.asker = 'slack-test:U2';
    const fromDm = { sessionId: 'sess-dm', agentGroupId: 'ag-test' };

    expect(await startCall(fromDm, { group: false })).toMatchObject({ group: true, joined: true });
    expect(linkFor(linkOf('U2'))).not.toBeNull();
    expect(H.minted).toBe(0);
    expect(await startCall(fromDm, { group: false, direct: true })).toMatchObject({ group: false });
    expect(H.minted).toBe(1);
  });

  it('gives a channel a direct call rather than refusing it when the host has no room for another joinable one', async () => {
    H.asker = 'slack-test:U1';
    await startOrJoinGroupCall({ sessionId: 'sess-a', agentGroupId: 'ag-test' });
    await startOrJoinGroupCall({ sessionId: 'sess-b', agentGroupId: 'ag-test' });
    const started = await startCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' }, { group: false });
    expect(started.group).toBe(false);
    expect(H.minted).toBe(1);
  });

  it('keeps a direct call in a DM', async () => {
    H.platform = 'slack:D0TEST';
    H.asker = 'slack-test:U1';
    const started = await startCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' }, { group: false });
    expect(started.group).toBe(false);
    expect(groupCallLive('sess-test')).toBe(false);
    expect(H.minted).toBe(1);
  });

  describe('in a person’s own DM', () => {
    const dm = { sessionId: 'sess-dm', agentGroupId: 'ag-test' };
    const linkIn = (url: string) => /^https:\/\/([0-9a-f]{32})\./.exec(url)![1];

    async function dmRoom(owner = 'slack-test:U1') {
      H.platform = 'slack:D0DM';
      const opened = await startOrJoinDmCallAs(dm, owner);
      return linkIn(opened.url);
    }

    it('opens a room only its person may join: another person asking, or invited by the agent, is refused', async () => {
      const link = await dmRoom();

      await expect(startOrJoinDmCallAs(dm, 'slack-test:U2')).rejects.toThrow(
        'Only the person whose DM this is can join this call.',
      );
      await expect(startCall(dm, { group: false, invite: '<@U2>' })).rejects.toThrow(
        'Only the person whose DM this is can join this call.',
      );
      const { call } = linkFor(link)!;
      expect([...call.people.keys()]).toEqual(['slack-test:U1']);
      expect([H.posts, [...H.dms.keys()]]).toEqual([[], []]);
    });

    it('opens one room when two threads of the DM ask at once', async () => {
      H.platform = 'slack:D0DM';
      const asks = await Promise.all(
        ['sess-dm-a', 'sess-dm-b'].map((sessionId) =>
          startOrJoinDmCallAs({ sessionId, agentGroupId: 'ag-test' }, 'slack-test:U1'),
        ),
      );

      expect(asks.map((ask) => ask.joined).sort()).toEqual([false, true]);
      expect(['sess-dm-a', 'sess-dm-b'].filter(groupCallLive)).toHaveLength(1);
    });

    it('still refuses a group call into it, by the app or the agent, even while its room is live', async () => {
      await dmRoom();
      H.asker = 'slack-test:U1';

      await expect(startOrJoinGroupCallAs(dm, 'slack-test:U1')).rejects.toThrow(/Group calls start from a channel/);
      await expect(startOrJoinGroupCall(dm)).rejects.toThrow(/Group calls start from a channel/);
      await expect(startCall(dm, { group: true })).rejects.toThrow(/Group calls start from a channel/);
    });

    it('gives the person the room when they ask the agent for a call in the DM while it is live', async () => {
      const link = await dmRoom();
      H.asker = 'slack-test:U1';

      const room = linkFor(link)!.call;
      expect(await startCall(dm, { group: false })).toMatchObject({ group: true, joined: true });
      expect([linkFor(linkOf('U1'))!.call, H.minted]).toEqual([room, 0]);
    });

    it('tells the agent the call is the DM’s, which only the person in it can join', async () => {
      const link = await dmRoom();
      await until(() => claimLink(link));
      const live = await until(() => H.live);
      await until(() => linkFor(link)!.call.present.size === 1);

      live({ type: 'delegation', id: 'd-1', text: 'Is the deploy done?' });
      await until(() =>
        H.written.find((row) =>
          (JSON.parse(row.content) as { text: string }).text.includes(
            'live voice call from this DM, which only the person in it can join',
          ),
        ),
      );
    });
  });

  it('finds a channel member past the first ten pages of a large channel’s member list', async () => {
    H.members = new Set([...Array.from({ length: 12_000 }, (_, i) => `UX${i}`), 'U1']);
    const links = await callWith('U1');
    expect((await until(() => claimLink(links.U1))).url).toBe(`wss://${links.U1}.calls.example`);
  });

  it('refuses rather than loops when the member list never ends', async () => {
    H.endless = true;
    H.asker = 'slack-test:U1';
    await expect(startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' })).rejects.toThrow(
      /could not check who is in this channel/,
    );
  });

  it('refuses a reconnect from someone who has left the channel, before the minute check', async () => {
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    const { call, person } = linkFor(links.U1)!;
    H.room = call.id;
    expect(await signalStatus(links.U1, person.identity)).not.toBe(403);
    H.members = new Set(['U2']);
    expect(await signalStatus(links.U1, person.identity)).toBe(403);
  });

  it('rides out a Discord rate limit on its minute check, and acts on the next real answer', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true,
    });
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));

    H.discordBusy = true;
    await vi.advanceTimersByTimeAsync(65_000);
    expect(H.posts.join('\n')).not.toContain('could not be checked');
    expect(groupCallLive('sess-test')).toBe(true);
    expect(H.removed).toEqual([]);

    H.discordBusy = false;
    H.members = new Set(['U2']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(H.removed).toHaveLength(1);
  });

  it('still removes someone who lost access in the central DB while Discord is rate limiting', async () => {
    vi.useFakeTimers({
      toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'],
      shouldAdvanceTime: true,
    });
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));

    H.discordBusy = true;
    H.denied.add('slack-test:U1');
    await vi.advanceTimersByTimeAsync(65_000);

    expect(H.removed).toHaveLength(1);
  });

  it('stops the room server when someone could not be removed and the room could not be deleted', async () => {
    const first = await callWith('U1');
    await until(() => claimLink(first.U1));
    H.asker = 'slack-test:U2';
    await startOrJoinGroupCall({ sessionId: 'sess-other', agentGroupId: 'ag-test' });
    const other = linkOf('U2');
    await until(() => claimLink(other));

    H.roomServiceDown = true;
    await leave(first.U1);

    expect(linkFor(other)).toBeNull();
    expect(H.stops).toBeGreaterThan(0);
  }, 15_000);

  it('leaves other calls alone when an ordinary call end cannot delete its room', async () => {
    const first = await callWith('U1');
    await until(() => claimLink(first.U1));

    H.deleteDown = true;
    H.noDm = true;
    H.asker = 'slack-test:U2';
    await expect(startOrJoinGroupCall({ sessionId: 'sess-other', agentGroupId: 'ag-test' })).rejects.toThrow(/DM/);

    expect(linkFor(first.U1)).not.toBeNull();
    expect(H.stops).toBe(0);
  });

  it('leaves no thread feed open when the call ends while its voice is connecting', async () => {
    let connect!: () => void;
    H.offerHold = new Promise((resolve) => (connect = resolve));
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    await new Promise((resolve) => setTimeout(resolve, 1300));

    for (const shutdown of getHostShutdownCallbacks()) await shutdown();
    connect();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(H.feedsOpen).toBe(0);
  });

  it('starts no voice for a call that ended while a poll was reading the room', async () => {
    H.present = [];
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    let answer!: () => void;
    H.collectHold = new Promise((resolve) => (answer = resolve));
    H.present = ['p-someone'];
    await new Promise((resolve) => setTimeout(resolve, 1300));

    for (const shutdown of getHostShutdownCallbacks()) await shutdown();
    answer();
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect([H.live, H.feedsOpen]).toEqual([null, 0]);
  });

  it('tells the thread whose call ended, and why, when the voice cannot start', async () => {
    H.liveFails = true;
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    await until(() => H.posts.find((post) => post.includes('ended')));
    expect(H.posts).toContain('📞 Call with Pixel ended: The voice could not join the call.');
  });

  const greeted = () => H.told.some((text) => text.startsWith('The call just connected.'));

  it('greets only once someone in the room has the voice’s track, since the voice connects before anyone can hear it', async () => {
    H.voiceTrack = 'published';
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    await until(() => H.live);
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(greeted()).toBe(false);

    H.voiceTrack = 'heard';
    await until(greeted);
  }, 10_000);

  it('greets anyway once the voice’s track has been up a while with no word that anyone has it', async () => {
    H.voiceTrack = 'published';
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    await until(() => H.live);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(greeted()).toBe(false);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 5000);
    await until(greeted);
  }, 10_000);

  it('refuses to add someone to a call that ends while their channel check runs, and sends no link', async () => {
    const links = await callWith('U1');
    await until(() => claimLink(links.U1));
    let answer!: () => void;
    H.slackHold = new Promise((resolve) => (answer = resolve));
    H.asker = 'slack-test:U2';
    const adding = startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    for (const shutdown of getHostShutdownCallbacks()) await shutdown();
    answer();
    await expect(adding).rejects.toThrow(/just ended/);
    expect(H.dms.has('slack-test:U2')).toBe(false);
  });

  it('never starts the room for a call that ended while its first link was being sent', async () => {
    let delivered!: () => void;
    H.dmHold = new Promise((resolve) => (delivered = resolve));
    H.asker = 'slack-test:U1';
    const starting = startOrJoinGroupCall({ sessionId: 'sess-test', agentGroupId: 'ag-test' });
    await new Promise((resolve) => setTimeout(resolve, 50));

    for (const shutdown of getHostShutdownCallbacks()) await shutdown();
    delivered();
    await expect(starting).rejects.toThrow(/ended before it started/);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(H.roomStarts).toBe(0);
  });

  it('lets a link join once', async () => {
    const links = await callWith('U1');
    const claim = await until(() => claimLink(links.U1));
    expect(claim.url).toBe(`wss://${links.U1}.calls.example`);
    expect(await claimLink(links.U1)).toBeNull();
  });

  it('ends a removed person’s event stream, and the call no longer reaches them', async () => {
    const links = await callWith('U1', 'U2');
    await until(() => claimLink(links.U1));
    await until(() => claimLink(links.U2));
    const heard: Record<string, unknown[]> = { U1: [], U2: [] };
    listen(linkFor(links.U1)!.person, (event) => heard.U1.push(event));
    const stays = linkFor(links.U2)!.person;
    listen(stays, (event) => heard.U2.push(event));
    await until(() => H.feed);

    await leave(links.U2);
    H.feed!({ type: 'turn-end' });

    expect(H.removed).toHaveLength(1);
    expect(heard.U2).toEqual([{ type: 'ended', text: 'You were removed from the call.' }]);
    expect(heard.U1).toContainEqual({ type: 'status', text: 'Live' });
    const late: unknown[] = [];
    listen(stays, (event) => late.push(event));
    expect(late).toEqual([{ type: 'ended', text: 'You are no longer on this call.' }]);
  });
});

describe('sharing a file on a group call', () => {
  const UPLOADS = uniqueTmpRoot('group-call-uploads');
  const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(5000, 7)]);
  const PROGRAM = Buffer.concat([Buffer.from('MZ\x90\x00\x03\x00', 'latin1'), Buffer.alloc(5000, 0)]);
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    fs.mkdirSync(UPLOADS, { recursive: true });
    _setUploadBaseForTest(UPLOADS);
    server = http.createServer((req, res) => {
      const link = (req.headers.host ?? '').split('.')[0];
      if (!handleGroupCallRequest(link, req, res)) res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    _setUploadBaseForTest(null);
    fs.rmSync(UPLOADS, { recursive: true, force: true });
  });

  const onDisk = () => fs.readdirSync(UPLOADS).flatMap((dir) => fs.readdirSync(`${UPLOADS}/${dir}`));
  const fileRows = () => H.written.filter((row) => JSON.parse(row.content).attachments);

  function attach(
    link: string,
    body: Buffer | ((req: http.ClientRequest) => void),
    opts: { token?: string; origin?: string; headers?: http.OutgoingHttpHeaders } = {},
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const token = opts.token ?? linkFor(link)?.person.pageToken ?? '';
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          method: 'POST',
          path: `/attach?t=${token}`,
          headers: {
            host: `${link}.calls.example`,
            origin: opts.origin ?? `https://${link}.calls.example`,
            'content-type': 'image/png',
            'x-file-name': 'shot.png',
            ...opts.headers,
          },
        },
        (res) => {
          let text = '';
          res.on('data', (chunk) => (text += chunk));
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : {} }));
        },
      );
      req.on('error', (err: NodeJS.ErrnoException) =>
        err.code === 'EPIPE' || err.code === 'ECONNRESET' ? undefined : reject(err),
      );
      if (typeof body === 'function') body(req);
      else req.end(body);
    });
  }

  async function liveCallWith(...users: string[]) {
    H.present = users.map((user) => `p-${user}`);
    const links = await callWith(...users);
    for (const user of users) await until(() => claimLink(links[user]));
    await until(() => H.live);
    return links;
  }

  it.each([
    { refused: 'a wrong page token', opts: { token: 'f'.repeat(32) } },
    { refused: 'no page token', opts: { token: '' } },
    { refused: 'another origin', opts: { origin: 'https://other.calls.example' } },
  ])('refuses $refused and shares nothing', async ({ opts }) => {
    const links = await liveCallWith('U1');
    expect((await attach(links.U1, PNG, opts)).status).toBe(403);
    expect([fileRows(), H.postedFiles, onDisk()]).toEqual([[], [], []]);
  });

  it('refuses a file over the size cap, and one whose bytes are not the kind its name claims', async () => {
    const links = await liveCallWith('U1');
    const oversized = await attach(links.U1, (req) => req.end(), {
      headers: { 'content-length': String(MAX_FILE_BYTES + 1) },
    });
    const disguised = await attach(links.U1, PROGRAM);
    expect([oversized.status, disguised.status]).toEqual([413, 415]);
    expect([fileRows(), H.postedFiles, onDisk()]).toEqual([[], [], []]);
  });

  it('gives the file to the agent for its next turn, tells the voice once, and shows everyone on the call', async () => {
    const links = await liveCallWith('U1', 'U2');
    const seen: Record<string, unknown[]> = { U1: [], U2: [] };
    for (const user of ['U1', 'U2']) listen(linkFor(links[user])!.person, (event) => seen[user].push(event));

    const res = await attach(links.U1, PNG);

    expect(res).toEqual({ status: 200, body: { ok: true, name: 'shot.png', inThread: true } });
    const [row] = fileRows() as Array<{ id: string; trigger: number; content: string }>;
    expect(fileRows()).toHaveLength(1);
    expect(row.id.startsWith(`voice-${linkFor(links.U1)!.call.id}-`)).toBe(true);
    expect(row.trigger).toBe(0);
    expect(JSON.parse(row.content)).toEqual({
      text: 'Someone shared shot.png on the call, to look at when someone on the call asks about it.',
      sender: 'Someone (on the call)',
      attachments: [
        { type: 'image', name: 'shot.png', mimeType: 'image/png', size: PNG.length, data: PNG.toString('base64') },
      ],
    });
    expect(H.notes.filter((note) => note.text.includes('shot.png'))).toEqual([
      {
        text: expect.stringMatching(/^Someone shared a file on the call: "shot\.png"\. Pixel can see it\./),
        use: 'know',
      },
    ]);
    const shared = { type: 'shared', speaker: 'Someone', file: 'shot.png' };
    expect([seen.U1, seen.U2]).toEqual([[shared], [shared]]);
    await until(() => H.postedFiles.length);
    expect(H.postedFiles).toEqual([
      { text: '📎 Someone shared shot.png on the call', files: [{ filename: 'shot.png', data: PNG }] },
    ]);
    expect(onDisk()).toEqual([]);
  });

  const allowed = { name: 'Ana', files: true };
  it.each([
    {
      row: 'may attach files',
      threadId: 'discord:G1:C1:T1',
      poster: allowed,
      over: false,
      inThread: true,
      asked: true,
    },
    {
      row: 'may post but not attach',
      threadId: 'discord:G1:C1:T1',
      poster: { name: 'Ana', files: false },
      over: false,
      inThread: false,
      asked: true,
    },
    { row: 'may not post', threadId: 'discord:G1:C1:T1', poster: null, over: false, inThread: false, asked: true },
    {
      row: 'whose permissions cannot be read',
      threadId: 'discord:G1:C1:T1',
      poster: 'throws' as const,
      over: false,
      inThread: false,
      asked: true,
    },
    { row: 'in a channel, not a thread', threadId: null, poster: allowed, over: false, inThread: false, asked: false },
    {
      row: 'with a file over Discord’s cap',
      threadId: 'discord:G1:C1:T1',
      poster: allowed,
      over: true,
      inThread: false,
      asked: false,
    },
  ])(
    'on Discord, posts the file only where the uploader could attach it: $row',
    async ({ threadId, poster, over, inThread, asked }) => {
      H.channelType = 'discord';
      H.platform = 'discord:G1:C1';
      H.threadId = threadId;
      H.poster = poster;
      H.present = ['p-someone'];
      const thread = { sessionId: 'sess-test', agentGroupId: 'ag-test' };
      await startOrJoinGroupCallAs(thread, 'discord:U1');
      const joined = await startOrJoinGroupCallAs(thread, 'discord:U2');
      const link = /^https:\/\/([0-9a-f]{32})\./.exec(joined.url)![1];
      await until(() => claimLink(link));
      await until(() => H.live);
      const body = over ? Buffer.concat([PNG, Buffer.alloc(MAX_DISCORD_FILE_BYTES + 1 - PNG.length)]) : PNG;

      const res = await attach(link, body);

      await until(() => H.posts.find((post) => post.startsWith('📎')));
      expect(H.postedFiles.map(({ files }) => files.map(({ filename }) => filename))).toEqual(
        inThread ? [['shot.png']] : [],
      );
      expect(H.posts.filter((post) => post.startsWith('📎'))).toEqual(['📎 Someone shared shot.png on the call']);
      expect(H.posterAsked).toEqual(
        asked ? [[{ platform: 'discord', guildId: 'G1', channelId: 'C1', threadId: 'T1' }, 'discord', 'U2']] : [],
      );
      expect(fileRows()).toHaveLength(1);
      expect(res).toEqual({ status: 200, body: { ok: true, name: 'shot.png', inThread } });
    },
  );

  it('refuses a file whose call ends while it arrives, and any file once the call is over', async () => {
    const links = await liveCallWith('U1');
    let finish!: () => void;
    const arriving = attach(links.U1, (req) => {
      req.write(PNG.subarray(0, 4096));
      finish = () => req.end(PNG.subarray(4096));
    });
    await until(() => onDisk().length > 0);
    for (const shutdown of getHostShutdownCallbacks()) await shutdown();
    finish();

    expect((await arriving).status).toBe(409);
    expect((await attach(links.U1, PNG, { token: 'f'.repeat(32) })).status).toBe(404);
    expect([fileRows(), H.postedFiles, onDisk()]).toEqual([[], [], []]);
  });
  it('counts a person’s files as a phone’s replies are counted, and refuses past ten a minute', async () => {
    const links = await liveCallWith('U2');
    const answers: number[] = [];
    for (let n = 0; n < 11; n++) answers.push((await attach(links.U2, PNG)).status);

    expect(answers).toEqual([...Array<number>(10).fill(200), 429]);
    expect(fileRows()).toHaveLength(10);
    expect(onDisk()).toEqual([]);
  });
});
