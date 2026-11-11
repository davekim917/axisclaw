import { afterEach, describe, expect, it, vi } from 'vitest';

import { CHECK_IN_INTERVAL_MS, VoiceCallBridge, type CallPorts } from './call.js';
import type { ContextUse, LiveEvent } from './live.js';
import type { FeedEvent } from './session-feed.js';

interface Harness {
  bridge: VoiceCallBridge;
  live: (event: LiveEvent) => void;
  agent: (event: FeedEvent) => void;
  appended: Array<{ text: string; use: ContextUse; delegationId?: string }>;
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
        context: (text, use, delegationId) => h.appended.push({ text, use, delegationId }),
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
    expect(h.appended.map(({ text, use }) => [use, text])).toEqual([
      ['know', 'On the call: Rae. One person: everything they say is to you.'],
      ['say', 'The call just connected. Greet Rae with exactly: "Hi Rae, it\'s Atlas."'],
      ['know', 'On the call: Rae and Sam. 2 people: respond only when someone says your name.'],
      ['say', 'Sam joined the call. In one short sentence, tell everyone to say your name when they need you.'],
      ['know', 'On the call: Lee, Rae and Sam. 3 people: respond only when someone says your name.'],
      ['know', 'On the call: Rae. One person: everything they say is to you.'],
      ['say', 'Lee and Sam left the call. In one short sentence, tell Rae they no longer need to say your name.'],
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
        use: 'say',
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
      { text: 'Progress, not to be said: 🔧 Running vitest', use: 'know', delegationId: undefined },
      { text: 'Two tests fail.', use: 'say', delegationId: 'd1' },
      {
        text: 'Atlas posted in the thread: Also, the nightly is green.',
        use: 'say',
        delegationId: undefined,
      },
    ]);
  });

  it('matches a reply to its request even when the reply lands before the write settles', async () => {
    const h = await connect();
    h.written = new Promise(() => undefined);
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    h.agent({ type: 'reply', text: 'Two tests fail.', inReplyTo: 'm1' });
    expect(h.appended).toEqual([{ text: 'Two tests fail.', use: 'say', delegationId: 'd1' }]);
  });

  it('drops progress polled after its turn ended, so it cannot revive the request or claim a later reply', async () => {
    const h = await connect();
    h.live({ type: 'delegation', id: 'd1', text: 'Check the tests.' });
    h.agent({ type: 'reply', text: 'Two tests fail.', inReplyTo: 'm1' });
    h.agent({ type: 'turn-end' });
    h.agent({ type: 'progress', text: '🔧 Running vitest', inReplyTo: 'm1' });
    h.agent({ type: 'reply', text: 'Lint is clean.', inReplyTo: 'typed-7' });
    expect(h.appended).toEqual([
      { text: 'Two tests fail.', use: 'say', delegationId: 'd1' },
      { text: 'Atlas posted in the thread: Lint is clean.', use: 'say', delegationId: undefined },
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
      ['Progress, not to be said: 🔧 Running eslint', undefined],
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
      ['Progress, not to be said: tests running', undefined],
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
      { text: 'In the thread, Sam Roe: is the backfill done?', use: 'say', delegationId: undefined },
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

  describe('progress on a running request', () => {
    afterEach(() => vi.useRealTimers());
    const at = (ms: number) => vi.setSystemTime(new Date(Date.UTC(2026, 0, 1) + ms));

    it('stays silent and speaks one check-in per interval, however many notes arrive', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      at(0);
      const h = await connect([], true);
      h.live({ type: 'delegation', id: 'd1', text: 'Atlas, check the nightly.' });
      await new Promise((r) => setTimeout(r, 0));
      h.appended.length = 0;
      for (let i = 0; i < 55; i++) {
        at(Math.round((i * 7 * 60_000) / 54));
        h.agent({ type: 'progress', text: `💭 note ${i}`, inReplyTo: 'm1' });
      }
      expect(h.appended.filter((a) => a.use === 'know')).toHaveLength(52);
      expect(h.appended.filter((a) => a.use !== 'know')).toEqual([
        { text: expect.stringContaining('💭 note 16'), use: 'check-in', delegationId: 'd1' },
        { text: expect.stringContaining('💭 note 32'), use: 'check-in', delegationId: 'd1' },
        { text: expect.stringContaining('💭 note 48'), use: 'check-in', delegationId: 'd1' },
      ]);
    });

    it('counts the interval from the last spoken reply, and never checks in once the request is finished', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      at(0);
      const h = await connect();
      h.live({ type: 'delegation', id: 'd1', text: 'Check the nightly.' });
      at(CHECK_IN_INTERVAL_MS - 1);
      h.agent({ type: 'reply', text: 'Shard 3 failed; re-running it.', inReplyTo: 'm1' });
      at(CHECK_IN_INTERVAL_MS + 1);
      h.agent({ type: 'progress', text: 'still re-running', inReplyTo: 'm1' });
      at(2 * CHECK_IN_INTERVAL_MS - 2);
      h.agent({ type: 'progress', text: 'almost there', inReplyTo: 'm1' });
      at(2 * CHECK_IN_INTERVAL_MS - 1);
      h.agent({ type: 'progress', text: 'shard 3 is green', inReplyTo: 'm1' });
      h.agent({ type: 'turn-end' });
      at(10 * CHECK_IN_INTERVAL_MS);
      h.agent({ type: 'progress', text: 'a helper is still writing', inReplyTo: 'm1' });
      expect(h.appended.filter((a) => a.use !== 'know').map((a) => [a.use, a.text])).toEqual([
        ['say', 'Shard 3 failed; re-running it.'],
        ['check-in', expect.stringContaining('shard 3 is green')],
      ]);
    });

    const runningRequest = async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      at(0);
      const h = await connect();
      h.live({ type: 'delegation', id: 'd1', text: 'Check the nightly.' });
      return h;
    };
    const checkIns = (h: Harness) => h.appended.filter((a) => a.use === 'check-in').map((a) => a.text);
    const notes = (h: Harness) => h.appended.filter((a) => a.text.startsWith('Status updates')).map((a) => a.text);
    const pieces = (h: Harness, words: string) => {
      for (const word of words.split(' ')) h.live({ type: 'transcript', role: 'caller', text: ` ${word}` });
    };
    const sayWordByWord = (h: Harness, words: string) => {
      pieces(h, words);
      h.live({ type: 'turn-done', role: 'caller', transcript: ` ${words}` });
    };
    const answered = (h: Harness) => h.live({ type: 'turn-done', role: 'voice', transcript: 'Got it.' });

    it.each([
      'stop updating me',
      'Atlas, can you stop updating us?',
      'Stop giving me updates.',
      'No more updates for me, thanks',
      "I don't care about the logs, stop checking in with me.",
    ])('mutes the check-ins for the call when the caller says "%s"', async (words) => {
      const h = await runningRequest();
      at(10_000);
      sayWordByWord(h, words);
      answered(h);
      at(CHECK_IN_INTERVAL_MS + 1);
      h.agent({ type: 'progress', text: 'shard 3 of 8', inReplyTo: 'm1' });
      at(3 * CHECK_IN_INTERVAL_MS);
      h.agent({ type: 'progress', text: 'shard 7 of 8', inReplyTo: 'm1' });
      h.agent({ type: 'reply', text: 'The nightly passed.', inReplyTo: 'm1' });
      expect(checkIns(h)).toEqual([]);
      expect(h.appended.filter((a) => a.use === 'know').map((a) => a.text)).toEqual([
        expect.stringMatching(/^Status updates are now off for this call/),
        expect.stringContaining('shard 3 of 8'),
        expect.stringContaining('shard 7 of 8'),
      ]);
      expect(h.appended.filter((a) => a.use === 'say').map((a) => a.text)).toEqual(['The nightly passed.']);
    });

    it.each([
      'stop',
      'be quiet',
      "don't stop the update job",
      'the update failed, stop it',
      'Don’t stop updating me.',
      'stop checking in the code until review',
      'there are no more updates to the schema',
      'stop the updates to the dashboard',
      'no more updates are needed on the PR',
      'we should pause the updates to prod',
      'turn off the updates on the Windows box',
      'mute the updates channel in Slack',
      "we've had enough updates to the schema this week",
      "I don't want you to stop updating me",
      "you shouldn't stop updating me",
      'there is no need to stop updating me',
    ])('keeps the check-ins, and tells the voice nothing, when the caller says "%s" word by word', async (words) => {
      const h = await runningRequest();
      at(10_000);
      sayWordByWord(h, words);
      answered(h);
      at(CHECK_IN_INTERVAL_MS + 1);
      h.agent({ type: 'progress', text: 'shard 3 of 8', inReplyTo: 'm1' });
      expect(checkIns(h)).toEqual([expect.stringContaining('shard 3 of 8')]);
      expect(notes(h)).toEqual([]);
    });

    it.each(['keep me posted', 'Keep us updated.', 'Actually, start updating me'])(
      'brings the check-ins back when the caller says "%s"',
      async (words) => {
        const h = await runningRequest();
        sayWordByWord(h, 'stop updating me');
        answered(h);
        at(CHECK_IN_INTERVAL_MS + 1);
        h.agent({ type: 'progress', text: 'shard 3 of 8', inReplyTo: 'm1' });
        sayWordByWord(h, words);
        answered(h);
        sayWordByWord(h, words);
        answered(h);
        h.agent({ type: 'progress', text: 'shard 4 of 8', inReplyTo: 'm1' });
        expect(checkIns(h)).toEqual([expect.stringContaining('shard 4 of 8')]);
        expect(notes(h)).toEqual([
          expect.stringMatching(/^Status updates are now off/),
          expect.stringMatching(/^Status updates are back on/),
        ]);
      },
    );

    it('mutes as the words arrive, and tells the voice only once it has answered', async () => {
      const h = await runningRequest();
      pieces(h, 'Stop updating me');
      at(CHECK_IN_INTERVAL_MS + 1);
      h.agent({ type: 'progress', text: 'shard 3 of 8', inReplyTo: 'm1' });
      h.live({ type: 'turn-done', role: 'caller', transcript: ' Stop updating me' });
      expect([checkIns(h), notes(h)]).toEqual([[], []]);
      answered(h);
      answered(h);
      expect(notes(h)).toEqual([expect.stringMatching(/^Status updates are now off/)]);
    });

    it('holds the note while the caller talks over the voice, and sends it once they have finished', async () => {
      const h = await runningRequest();
      pieces(h, 'Stop updating me, and');
      answered(h);
      expect(notes(h)).toEqual([]);
      pieces(h, 'rerun the shard');
      h.live({ type: 'turn-done', role: 'caller', transcript: ' Stop updating me, and rerun the shard' });
      answered(h);
      expect(notes(h)).toEqual([expect.stringMatching(/^Status updates are now off/)]);
    });

    it('tells the voice nothing when a wish is taken back before it answers', async () => {
      const h = await runningRequest();
      sayWordByWord(h, 'stop updating me');
      sayWordByWord(h, 'actually no, keep me posted');
      answered(h);
      expect(notes(h)).toEqual([]);
    });

    it('keeps the opening words of a turn that began before the service ended the one before it', async () => {
      const h = await runningRequest();
      sayWordByWord(h, 'stop updating me');
      pieces(h, 'Thanks.');
      pieces(h, 'Actually keep me');
      h.live({ type: 'turn-done', role: 'caller', transcript: 'Thanks.' });
      pieces(h, 'posted');
      at(CHECK_IN_INTERVAL_MS + 1);
      h.agent({ type: 'progress', text: 'shard 3 of 8', inReplyTo: 'm1' });
      expect(checkIns(h)).toEqual([expect.stringContaining('shard 3 of 8')]);
    });
  });

  it('gives the voice a silent note at once, or once the caller has finished a sentence they are in', async () => {
    const h = await connect([], true);
    const notes = () => h.appended.filter((a) => a.text.includes('.pdf'));
    h.bridge.knowSoon('Rae shared plan.pdf.');
    h.live({ type: 'transcript', role: 'caller', text: 'Atlas, look at' });
    h.bridge.knowSoon('Sam shared notes.pdf.');
    expect(notes()).toEqual([{ text: 'Rae shared plan.pdf.', use: 'know', delegationId: undefined }]);

    h.live({ type: 'turn-done', role: 'caller', transcript: 'Atlas, look at this' });
    expect(notes()).toEqual([
      { text: 'Rae shared plan.pdf.', use: 'know', delegationId: undefined },
      { text: 'Sam shared notes.pdf.', use: 'know', delegationId: undefined },
    ]);
  });

  it('ends when the voice service closes the call', async () => {
    const h = await connect();
    h.live({ type: 'closed', reason: null });
    expect(h.ended).toEqual(['The voice service ended the call.']);
  });
});
