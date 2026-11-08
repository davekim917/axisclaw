import { describe, expect, it } from 'vitest';

import { VoiceCallBridge, type CallPorts } from './call.js';
import type { ContextChannel, LiveEvent } from './live.js';
import type { FeedEvent } from './session-feed.js';

interface Harness {
  bridge: VoiceCallBridge;
  live: (event: LiveEvent) => void;
  agent: (event: FeedEvent) => void;
  appended: Array<{ text: string; channel: ContextChannel; delegationId?: string }>;
  injected: Array<{ text: string; wake: boolean }>;
  mirrored: string[];
  ended: string[];
  captions: string[];
  instructions: string;
  liveClosed: boolean;
  written: Promise<void>;
}

async function connect(recent: FeedEvent[] = [], group = false): Promise<Harness> {
  const h = {
    appended: [],
    injected: [],
    mirrored: [],
    ended: [],
    captions: [],
    instructions: '',
    liveClosed: false,
    written: Promise.resolve(),
  } as unknown as Harness;
  const ports: CallPorts = {
    openLive: async ({ instructions, onEvent }) => {
      h.instructions = instructions;
      h.live = onEvent;
      return {
        answer: 'v=0 answer',
        context: (text, channel, delegationId) => h.appended.push({ text, channel, delegationId }),
        close: () => {
          h.liveClosed = true;
        },
      };
    },
    feed: (onEvent) => {
      h.agent = onEvent;
      return { recent, close: () => undefined };
    },
    inject: (text, wake) => {
      h.injected.push({ text, wake });
      return { id: `m${h.injected.length}`, written: h.written };
    },
    mirror: (text) => h.mirrored.push(text),
    status: () => undefined,
    caption: (role, text, done) => h.captions.push(done ? `${role}:done` : `${role}:${text}`),
    ended: (text) => h.ended.push(text),
  };
  h.bridge = new VoiceCallBridge(
    group
      ? { agentName: 'Atlas', callerName: 'the group', group: true, platform: 'Slack' }
      : { agentName: 'Atlas', callerName: 'Rae Doe', platform: 'Slack' },
    ports,
  );
  expect(await h.bridge.start('v=0 offer')).toBe('v=0 answer');
  return h;
}

const say = (h: Harness, text: string) => {
  h.live({ type: 'transcript', role: 'caller', text });
  h.live({ type: 'turn-done', role: 'caller', transcript: text });
};

describe('VoiceCallBridge', () => {
  it('tells a group voice who is on the call, greets one person by name, and announces only one-to-several crossings', async () => {
    const h = await connect([], true);
    h.live({ type: 'started' });
    h.bridge.peopleOnCall(['Rae']);
    h.bridge.audioConnected();
    h.bridge.peopleOnCall(['Sam', 'Rae']);
    h.bridge.peopleOnCall(['Rae', 'Sam']);
    h.bridge.peopleOnCall(['Rae', 'Sam', 'Lee']);
    h.bridge.peopleOnCall(['Rae']);
    expect(h.appended.map(({ text, channel }) => [channel, text])).toEqual([
      ['commentary', 'On the call: Rae. One person: everything they say is to you.'],
      ['speakable', 'The call just connected. Greet Rae with exactly: "Hi Rae, it\'s Atlas."'],
      ['commentary', 'On the call: Rae and Sam. 2 people: respond only when someone says your name.'],
      ['speakable', 'Sam joined the call. In one short sentence, tell everyone to say your name when they need you.'],
      ['commentary', 'On the call: Lee, Rae and Sam. 3 people: respond only when someone says your name.'],
      ['commentary', 'On the call: Rae. One person: everything they say is to you.'],
      ['speakable', 'Lee and Sam left the call. In one short sentence, tell Rae they no longer need to say your name.'],
    ]);
  });

  it('greets only once the voice is up and the caller can hear it', async () => {
    const h = await connect();
    h.live({ type: 'started' });
    expect(h.appended).toEqual([]);
    h.bridge.audioConnected();
    h.live({ type: 'started' });
    expect(h.appended).toEqual([
      {
        text: expect.stringContaining('"Hi, it\'s Atlas. What can I do?"'),
        channel: 'speakable',
        delegationId: undefined,
      },
    ]);
  });

  it('keeps what the agent sends while the call is still connecting, in order', async () => {
    const h = { appended: [] as Array<{ text: string }> } as unknown as Harness;
    let release!: () => void;
    const opened = new Promise<void>((r) => (release = r));
    let agent!: (event: FeedEvent) => void;
    const bridge = new VoiceCallBridge(
      { agentName: 'Atlas', callerName: 'Rae Doe', platform: 'Slack' },
      {
        openLive: async () => {
          await opened;
          return {
            answer: 'v=0 answer',
            context: (text) => h.appended.push({ text } as never),
            close: () => undefined,
          };
        },
        feed: (onEvent) => {
          agent = onEvent;
          return { recent: [], close: () => undefined };
        },
        inject: () => ({ id: 'm1', written: Promise.resolve() }),
        mirror: () => undefined,
        status: () => undefined,
        caption: () => undefined,
        ended: () => undefined,
      },
    );
    const started = bridge.start('v=0 offer');
    agent({ type: 'reply', text: 'first', inReplyTo: null });
    agent({ type: 'inbound', sender: 'Sam Roe', text: 'second' });
    release();
    await started;
    agent({ type: 'reply', text: 'third', inReplyTo: null });
    expect(h.appended.map((a) => a.text)).toEqual([
      'Atlas posted in the thread: first',
      'In the thread, Sam Roe: second',
      'Atlas posted in the thread: third',
    ]);
  });

  it('gives the voice the recent thread as opening context', async () => {
    const h = await connect([{ type: 'inbound', sender: 'Sam Roe', text: 'deploy is red' }]);
    expect(h.instructions).toContain('Sam Roe: deploy is red');
  });

  it('captions both sides as they are spoken, closing each line at the end of its turn', async () => {
    const h = await connect();
    h.live({ type: 'transcript', role: 'caller', text: 'Is the nightly ' });
    h.live({ type: 'transcript', role: 'caller', text: 'green?' });
    h.live({ type: 'turn-done', role: 'caller', transcript: 'Is the nightly green?' });
    h.live({ type: 'transcript', role: 'voice', text: 'Checking now.' });
    h.live({ type: 'turn-done', role: 'voice', transcript: 'Checking now.' });
    expect(h.captions).toEqual([
      'caller:Is the nightly ',
      'caller:green?',
      'caller:done',
      'voice:Checking now.',
      'voice:done',
    ]);
  });

  it('sends a delegated request with what was said, and mirrors it into the thread', async () => {
    const h = await connect();
    say(h, 'can you check if the tests pass');
    h.live({ type: 'delegation', id: 'd1', text: 'Check whether the tests pass.' });
    say(h, 'and the lint too');
    h.live({ type: 'delegation', id: 'd2', text: 'Also check lint.' });

    expect(h.injected).toHaveLength(2);
    expect(h.injected[0].wake).toBe(true);
    expect(h.injected[0].text).toContain('[Voice call] Rae Doe started a live voice call');
    expect(h.injected[0].text).toContain('<request>Check whether the tests pass.</request>');
    expect(h.injected[0].text).toContain('Caller: can you check if the tests pass');
    expect(h.injected[1].text).toMatch(/^\[Voice call\] Rae Doe, on the live call:/);
    expect(h.injected[1].text).toContain('Caller: and the lint too');
    expect(h.injected[1].text).not.toContain('can you check if the tests pass');
    await new Promise((r) => setTimeout(r, 0));
    expect(h.mirrored).toContain('🎙️ *Rae Doe* (voice): Check whether the tests pass.');
  });

  it('mirrors a request into the thread only once the session has taken it', async () => {
    const h = await connect();
    h.written = new Promise(() => undefined);
    h.live({ type: 'delegation', id: 'd1', text: 'Delete the staging bucket.' });
    h.written = Promise.reject(new Error('refused'));
    h.written.catch(() => undefined);
    h.live({ type: 'delegation', id: 'd2', text: 'Rotate the deploy key.' });
    await new Promise((r) => setTimeout(r, 0));
    expect(h.mirrored.filter((m) => m.startsWith('🎙️'))).toEqual([]);
    expect(h.appended.map((a) => a.text)).toContain(
      'That request may not have reached Atlas. Ask the caller to check the thread before asking again.',
    );
  });

  it('ties the agent’s progress and replies to the request they answer, then releases it at turn end', async () => {
    const h = await connect();
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    h.agent({ type: 'progress', text: '🔧 Running vitest', inReplyTo: 'm1' });
    h.agent({ type: 'reply', text: 'Two tests fail.', inReplyTo: 'm1' });
    h.agent({ type: 'turn-end' });
    h.agent({ type: 'reply', text: 'Also, the nightly is green.', inReplyTo: 'other-message' });

    expect(h.appended).toEqual([
      { text: '🔧 Running vitest', channel: 'commentary', delegationId: 'd1' },
      { text: 'Two tests fail.', channel: 'speakable', delegationId: 'd1' },
      {
        text: 'Atlas posted in the thread: Also, the nightly is green.',
        channel: 'speakable',
        delegationId: undefined,
      },
    ]);
  });

  it('matches a reply to its request even when the reply lands before the write settles', async () => {
    const h = await connect();
    h.written = new Promise(() => undefined);
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    h.agent({ type: 'reply', text: 'Two tests fail.', inReplyTo: 'm1' });
    expect(h.appended).toEqual([{ text: 'Two tests fail.', channel: 'speakable', delegationId: 'd1' }]);
  });

  it('drops progress polled after its turn ended, so it cannot revive the request or claim a later reply', async () => {
    const h = await connect();
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    h.agent({ type: 'reply', text: 'Two tests fail.', inReplyTo: 'm1' });
    h.agent({ type: 'turn-end' });
    h.agent({ type: 'progress', text: '🔧 Running vitest', inReplyTo: 'm1' });
    h.agent({ type: 'reply', text: 'Lint is clean.', inReplyTo: 'typed-7' });
    expect(h.appended).toEqual([
      { text: 'Two tests fail.', channel: 'speakable', delegationId: 'd1' },
      { text: 'Atlas posted in the thread: Lint is clean.', channel: 'speakable', delegationId: undefined },
    ]);
  });

  it('never gives a finished request’s late progress or reply to the request now active', async () => {
    const h = await connect();
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    h.live({ type: 'delegation', id: 'd2', text: 'Then check lint.' });
    h.agent({ type: 'reply', text: 'Two tests fail.', inReplyTo: 'm1' });
    h.agent({ type: 'turn-end' });
    h.agent({ type: 'reply', text: 'Looking at lint now.', inReplyTo: 'm2' });
    h.agent({ type: 'progress', text: '🔧 Re-running the failing tests', inReplyTo: 'm1' });
    h.agent({ type: 'reply', text: 'Correction: three tests fail.', inReplyTo: 'm1' });
    expect(h.appended.map((a) => [a.text, a.delegationId])).toEqual([
      ['Two tests fail.', 'd1'],
      ['Looking at lint now.', 'd2'],
      ['Atlas posted in the thread: Correction: three tests fail.', undefined],
    ]);
  });

  it('keeps a request open when its progress arrives before the previous turn’s end', async () => {
    const h = await connect();
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    h.live({ type: 'delegation', id: 'd2', text: 'Then check lint.' });
    h.agent({ type: 'reply', text: 'Two tests fail.', inReplyTo: 'm1' });
    h.agent({ type: 'progress', text: '🔧 Running eslint', inReplyTo: 'm2' });
    h.agent({ type: 'turn-end' });
    h.agent({ type: 'reply', text: 'Lint is clean.', inReplyTo: 'm2' });
    expect(h.appended.map((a) => [a.text, a.delegationId])).toEqual([
      ['Two tests fail.', 'd1'],
      ['🔧 Running eslint', 'd2'],
      ['Lint is clean.', 'd2'],
    ]);
  });

  it('answers the request a reply names, even while an earlier one is in progress', async () => {
    const h = await connect();
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    h.live({ type: 'delegation', id: 'd2', text: 'Also check lint.' });
    h.agent({ type: 'progress', text: 'tests running', inReplyTo: 'm1' });
    h.agent({ type: 'reply', text: 'Lint is clean.', inReplyTo: 'm2' });
    h.agent({ type: 'reply', text: 'Tests pass too.', inReplyTo: 'unknown' });
    expect(h.appended.map((a) => [a.text, a.delegationId])).toEqual([
      ['tests running', 'd1'],
      ['Lint is clean.', 'd2'],
      ['Tests pass too.', 'd2'],
    ]);
  });

  it('keeps taking requests however the agent batches them', async () => {
    const h = await connect();
    for (let i = 1; i <= 9; i++) {
      h.live({ type: 'delegation', id: `d${i}`, text: `request ${i}` });
      h.agent({ type: 'reply', text: `done ${i}`, inReplyTo: `typed-${i}` });
      h.agent({ type: 'turn-end' });
    }
    expect(h.injected).toHaveLength(9);
  });

  it('passes what others write in the thread as labelled background, never as a request', async () => {
    const h = await connect();
    h.agent({ type: 'inbound', sender: 'Sam Roe', text: 'is the backfill done?' });
    h.agent({ type: 'progress', text: 'not tied to the call', inReplyTo: 'other-message' });
    expect(h.appended).toEqual([
      { text: 'In the thread, Sam Roe: is the backfill done?', channel: 'commentary', delegationId: undefined },
    ]);
    expect(h.injected).toEqual([]);
  });

  it('on hang-up, wakes the agent with what was said after the last request', async () => {
    const h = await connect();
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    say(h, 'oh and open a PR when done');
    h.bridge.end({ dropped: false, reason: 'Call ended.' });

    expect(h.liveClosed).toBe(true);
    expect(h.injected[1]).toEqual({ text: expect.stringContaining('Caller: oh and open a PR when done'), wake: true });
    expect(h.injected[1].text).toContain('Rae Doe ended the voice call.');
    expect(h.mirrored[h.mirrored.length - 1]).toBe('📞 Voice call with Atlas ended.');
    expect(h.ended).toEqual(['Call ended.']);
  });

  it('on hang-up with nothing new said, leaves the end note as context without waking the agent', async () => {
    const h = await connect();
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    h.bridge.end({ dropped: true, reason: 'The call dropped.' });
    expect(h.injected[1]).toEqual({
      text: expect.stringContaining('The voice call with Rae Doe dropped.'),
      wake: false,
    });
  });

  it('sends the agent nothing for a call where nothing was asked or said', async () => {
    const h = await connect();
    h.bridge.end({ dropped: false, reason: 'Call ended.' });
    h.live({ type: 'delegation', id: 'late', text: 'too late' });
    expect(h.injected).toEqual([]);
  });

  it('relays group requests in the order they were spoken, however long each takes to admit', async () => {
    const injected: string[] = [];
    const arrivals: number[] = [];
    let release!: () => void;
    const slow = new Promise<void>((resolve) => (release = resolve));
    let live!: (event: LiveEvent) => void;
    const ports: CallPorts = {
      openLive: async ({ onEvent }) => {
        live = onEvent;
        return { answer: 'v=0 answer', context: () => undefined, close: () => undefined };
      },
      feed: () => ({ recent: [], close: () => undefined }),
      admit: async (_id, turn, arrivedAtMs) => {
        arrivals.push(arrivedAtMs);
        if (turn.startsWith('Pixel, deploy')) await slow;
        return { text: turn, sender: 'Someone on the call (voice)', mirror: turn };
      },
      inject: (text) => {
        injected.push(text);
        return { id: `m${injected.length}`, written: Promise.resolve() };
      },
      mirror: () => undefined,
      status: () => undefined,
      caption: () => undefined,
      ended: () => undefined,
    };
    const bridge = new VoiceCallBridge(
      { agentName: 'Pixel', callerName: 'the group', group: true, platform: 'Slack' },
      ports,
    );
    await bridge.start('v=0 offer');

    live({ type: 'delegation', id: 'd-1', text: 'Pixel, deploy the build.' });
    live({ type: 'delegation', id: 'd-2', text: "Actually no, don't." });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(injected).toEqual([]);
    const releasedAt = Date.now();
    release();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(injected).toEqual(['Pixel, deploy the build.', "Actually no, don't."]);
    expect(arrivals[1]).toBeLessThan(releasedAt);
  });

  it('opens nothing for a call that ended before it connected', async () => {
    let feeds = 0;
    let lives = 0;
    const ports: CallPorts = {
      openLive: async () => {
        lives += 1;
        return { answer: 'v=0 answer', context: () => undefined, close: () => undefined };
      },
      feed: () => {
        feeds += 1;
        return { recent: [], close: () => undefined };
      },
      inject: () => ({ id: 'm1', written: Promise.resolve() }),
      mirror: () => undefined,
      status: () => undefined,
      caption: () => undefined,
      ended: () => undefined,
    };
    const bridge = new VoiceCallBridge(
      { agentName: 'Pixel', callerName: 'the group', group: true, platform: 'Slack' },
      ports,
    );
    bridge.end({ dropped: false, reason: 'ended' });
    await expect(bridge.start('v=0 offer')).rejects.toThrow(/ended/);
    expect([feeds, lives]).toEqual([0, 0]);
  });

  it('ends when the voice service closes the call', async () => {
    const h = await connect();
    h.live({ type: 'closed', reason: null });
    expect(h.ended).toEqual(['The voice service ended the call.']);
  });
});
