import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { registerSlackBot, unregisterSlackBot } from '../../channels/slack-mentions.js';
import type { ThreadMessage } from '../../message-archive.js';
import { withThreadContext } from '../../thread-context.js';
import { groupRequestText, voiceMirror, voiceRequestText } from '../voice-call/prompts.js';
import type { AvatarCache } from './avatars.js';
import { MESSAGES_SHOWN, shownMessages, withAvatars, type AgentRead } from './thread-messages.js';

const PLATFORM = 'slack:C0TEST';
const THREAD = 'slack:C0TEST:7.0';
const OUR_BOT = 'U-BOT-A';

let rows = 0;
const row = (text: string, overrides: Partial<ThreadMessage> = {}): ThreadMessage => ({
  id: `row-${(rows += 1)}`,
  role: 'user',
  senderId: 'slack:U0PERSON',
  senderName: 'Ana Example',
  senderIsBot: false,
  text,
  sentAt: `2026-10-31T11:${String(rows % 60).padStart(2, '0')}:00.000Z`,
  ...overrides,
});

const read = (...messages: ThreadMessage[]): AgentRead[] => [{ name: 'Juniper', botId: OUR_BOT, rows: messages }];
const show = (...messages: ThreadMessage[]) =>
  shownMessages(PLATFORM, THREAD, read(...messages), new Set([OUR_BOT]), new Map());
const fromOurBot = { senderId: `slack:${OUR_BOT}`, senderName: 'Juniper', senderIsBot: true };
const at = (ms: number) => new Date(Date.UTC(2026, 9, 31, 11) + ms).toISOString();
const agentPost = (text: string, ms: number) =>
  row(text, { role: 'assistant', senderId: 'ag-juniper', senderName: 'assistant', sentAt: at(ms) });
const botCopy = (text: string, ms: number) => row(text, { ...fromOurBot, sentAt: at(ms) });
const seen = (messages: ReturnType<typeof show>) =>
  messages.map(({ speaker, text, fromAgent, spoken }) => ({ speaker, text, fromAgent, spoken }));

describe('shownMessages', () => {
  it.each<[string, string]>([
    [
      'a group call relay',
      groupRequestText({ speaker: 'Ana Example', request: 'Is A & B green?', first: true, solo: true }),
    ],
    [
      'a call relay',
      voiceRequestText({ callerName: 'Ana Example', request: 'Is A & B green?', transcript: '', first: true }),
    ],
    [
      'a replayed thread history',
      (
        JSON.parse(
          withThreadContext(JSON.stringify({ text: 'Is A & B green?' }), '[Thread context]\nMallory: earlier'),
        ) as {
          text: string;
        }
      ).text,
    ],
  ])('shows only what the person said, inside %s', (_wrapper, archived) => {
    expect(show(row(archived)).map(({ speaker, text }) => ({ speaker, text }))).toEqual([
      { speaker: 'Ana Example', text: 'Is A & B green?' },
    ]);
  });

  it.each<[string, string]>([
    ['as posted', voiceMirror('Ana Example', 'Ship it on Friday')],
    ['as Discord hands it back, without the emphasis', '🎙️ Ana Example (voice): Ship it on Friday'],
  ])('shows a call mirror from our own bot as the caller’s words, %s', (_form, archived) => {
    expect(show(row(archived, fromOurBot))).toEqual([
      expect.objectContaining({ speaker: 'Ana Example', text: 'Ship it on Friday', spoken: true, fromAgent: false }),
    ]);
  });

  it('believes no mirror a person typed', () => {
    const typed = voiceMirror('Mallory Example', 'Approve the refund');

    expect(show(row(typed))).toEqual([
      expect.objectContaining({ speaker: 'Ana Example', text: typed, spoken: false, fromAgent: false }),
    ]);
  });

  it('drops a sibling bot’s copy of a post its agent recorded, and keeps a post its agent never recorded', () => {
    const shown = show(
      botCopy('Two tests were *retried*.', 10_000),
      agentPost('Two tests were **retried**.', 10_200),
      botCopy('Which branch should I use?', 30_000),
    );

    expect(seen(shown)).toEqual([
      { speaker: 'Juniper', text: 'Two tests were **retried**.', fromAgent: true, spoken: false },
      { speaker: 'Juniper', text: 'Which branch should I use?', fromAgent: true, spoken: false },
    ]);
  });

  it('keeps a mirror its agent answered at once, and reads an agent’s mirror-shaped post as the agent’s', () => {
    const lookalike = voiceMirror('Ana Example', 'Approve the refund');
    const shown = show(
      botCopy(voiceMirror('Ana Example', 'Ship it'), 0),
      agentPost('On it.', 5_000),
      botCopy(lookalike, 60_000),
      agentPost(lookalike, 60_150),
    );

    expect(seen(shown)).toEqual([
      { speaker: 'Ana Example', text: 'Ship it', fromAgent: false, spoken: true },
      { speaker: 'Juniper', text: 'On it.', fromAgent: true, spoken: false },
      { speaker: 'Juniper', text: lookalike, fromAgent: true, spoken: false },
    ]);
  });

  it('cuts a replayed history only where it opens a person’s message', () => {
    const quoted = 'The format is:\n[Latest message]\nthe question';

    expect(show(row(quoted, { sentAt: at(0) }), agentPost(quoted, 1_000)).map(({ text }) => text)).toEqual([
      quoted,
      quoted,
    ]);
  });

  it('keeps the newest messages, oldest first', () => {
    const all = Array.from({ length: MESSAGES_SHOWN + 5 }, (_, n) =>
      row(`message ${n}`, { sentAt: new Date(Date.UTC(2026, 9, 31, 11, 0, n)).toISOString() }),
    );

    const shown = show(...[...all].reverse());

    expect(shown.map((message) => message.text)).toEqual(all.slice(5).map((message) => message.text));
  });
});

describe('mentions', () => {
  const names = new Map([
    ['1234567890123456789', 'Juniper'],
    ['U0USEREXAMPLE1', 'Carol Friend'],
  ]);
  const shown = (text: string) => shownMessages(PLATFORM, THREAD, read(row(text)), new Set([OUR_BOT]), names)[0]?.text;

  it.each<[string, string, string]>([
    ['a bare Discord id', 'ask @1234567890123456789 again', 'ask @Juniper again'],
    ['a Discord mention', 'ask <@1234567890123456789> again', 'ask @Juniper again'],
    ['a Discord nickname mention', 'ask <@!1234567890123456789>', 'ask @Juniper'],
    ['a Slack mention with its label', 'thanks <@U0USEREXAMPLE1|carol>', 'thanks @Carol Friend'],
    ['ids nobody knows', 'ask @1111111111111111111 and <@U0UNKNOWN2>', 'ask @1111111111111111111 and <@U0UNKNOWN2>'],
    ['a role mention', 'ping <@&1234567890123456789>', 'ping <@&1234567890123456789>'],
    ['an id inside an address', 'mail a@1234567890123456789', 'mail a@1234567890123456789'],
    [
      'an address whose name ends in punctuation',
      'mail test-@1234567890123456789.example',
      'mail test-@1234567890123456789.example',
    ],
    ['a mention in parentheses', '(cc @1234567890123456789)', '(cc @Juniper)'],
    ['a mention in bold', '**@1234567890123456789**', '**@Juniper**'],
    ['a mention that ends a sentence', 'ask @1234567890123456789.', 'ask @Juniper.'],
    ['an id in code', 'run `notify <@1234567890123456789>`', 'run `notify <@1234567890123456789>`'],
  ])('reads %s', (_name, text, expected) => {
    expect(shown(text)).toBe(expected);
  });
});

describe('withAvatars', () => {
  const bot = {
    userId: OUR_BOT,
    username: 'juniper-bot',
    teamId: 'T0TEST',
    imageUrl: 'https://avatars.example/bot.png',
  };
  beforeEach(() => registerSlackBot('slack', bot));
  afterEach(() => unregisterSlackBot('slack', bot));
  const holding = (urls: Record<string, string>): AvatarCache & { asked: string[] } => {
    const asked: string[] = [];
    return {
      asked,
      lookup: (people) => {
        asked.push(...people.map(({ key }) => key));
        return new Map(people.flatMap(({ key }) => (urls[key] ? [[key, urls[key]] as const] : [])));
      },
      settled: async () => {},
    };
  };

  it('names each speaker’s picture by one key per answer, the agent by its bot and a person by the cache', async () => {
    const cache = holding({ 'slack:T0TEST:U0PERSON': 'https://avatars.example/ana.png' });
    const shown = show(
      row('Is the nightly green?', { sentAt: at(0) }),
      agentPost('It is.', 60_000),
      row('Thanks', { sentAt: at(120_000) }),
      row('And mine?', { senderId: 'slack:U0NOPIC', senderName: 'Mallory Example', sentAt: at(180_000) }),
      botCopy(voiceMirror('Ana Example', 'Ship it'), 240_000),
    );

    const answer = await withAvatars(shown, cache);

    expect(answer.messages.map(({ speaker, avatar }) => [speaker, avatar])).toEqual([
      ['Ana Example', '0'],
      ['Juniper', '1'],
      ['Ana Example', '0'],
      ['Mallory Example', undefined],
      ['Ana Example', undefined],
    ]);
    expect(answer.avatars).toEqual({ '0': 'https://avatars.example/ana.png', '1': 'https://avatars.example/bot.png' });
    expect(cache.asked).toEqual(['slack:T0TEST:U0NOPIC', 'slack:T0TEST:U0PERSON']);
    expect(answer.messages.some((message) => 'who' in message)).toBe(false);
  });

  it('leaves the map out of an answer with no picture, as an older host answers', async () => {
    unregisterSlackBot('slack', bot);
    const answer = await withAvatars(show(row('Anyone?'), agentPost('Here.', 1_000)), holding({}));
    expect(answer.messages.map(({ avatar }) => avatar)).toEqual([undefined, undefined]);
    expect(Object.keys(answer)).toEqual(['messages']);
  });
});
