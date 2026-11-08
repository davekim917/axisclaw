import { describe, expect, it } from 'vitest';

import type { MessageTailRow } from './modules/mailbox/index.js';
import { voiceRequestText } from './modules/voice-call/prompts.js';
import { withThreadContext } from './thread-context.js';
import {
  inboundTurn,
  keepUnlessChanged,
  outboundTurn,
  titleInput,
  titlePrompt,
  type TitleTurn,
} from './title-input.js';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const LONG_REPLY =
  'The piece argues for retiring long-lived feature branches in favour of trunk-based releases. '.repeat(10);

let seq = 0;
const row = (kind: string, content: object | string, atMs = T0): MessageTailRow => ({
  seq: ++seq,
  kind,
  timestamp: new Date(atMs).toISOString(),
  content: typeof content === 'string' ? content : JSON.stringify(content),
});

const person = (text: string, opts: { atMs?: number; attachments?: object[]; links?: object[]; id?: string } = {}) =>
  inboundTurn(
    row(
      'chat-sdk',
      {
        id: opts.id ?? `id-${++seq}`,
        text,
        author: { isBot: false },
        attachments: opts.attachments ?? [],
        links: opts.links ?? [],
      },
      opts.atMs,
    ),
  )!;
const agent = (text: string, atMs = T0 + 60_000) => outboundTurn(row('chat', { text }, atMs))!;
const otherAgent = (text: string, atMs = T0 + 60_000) =>
  inboundTurn(row('chat-sdk', { id: `id-${++seq}`, text, author: { isBot: true } }, atMs))!;

const inputOf = (turns: TitleTurn[], nowMs = T0 + 120_000) => titleInput(turns, nowMs);

describe('titleInput', () => {
  it('keeps the first message, the first real reply and the latest people, and drops agent chatter', () => {
    const { text } = inputOf([
      person('let us discuss https://example.test/piece and what it means for us', { id: 'a' }),
      agent('Same page as HTML.', T0 + 10_000),
      otherAgent('Diagram attached.', T0 + 20_000),
      agent(LONG_REPLY, T0 + 30_000),
      otherAgent('Verified: ledger clean.', T0 + 40_000),
      person('so do we drop them this quarter?', { atMs: T0 + 50_000, id: 'b' }),
    ]);

    expect(text.split('\n')).toEqual([
      'First message: let us discuss https://example.test/piece and what it means for us',
      `First reply: ${LONG_REPLY.trim().slice(0, 600)}`,
      'Later message: so do we drop them this quarter?',
    ]);
  });

  it('keeps 600 characters of a reply, past where a subject can first appear', () => {
    const reply = `${'x'.repeat(500)} trunk-based ${'y'.repeat(300)}`;
    const { text } = inputOf([person('thoughts?'), agent(reply)]);

    expect(text).toContain('trunk-based');
    expect(text).not.toContain('y'.repeat(100));
  });

  it('falls back to the longest short reply when nothing runs long', () => {
    const { text } = inputOf([person('what is this?'), agent('Ok.'), agent('A failure email from CI.', T0 + 90_000)]);

    expect(text).toContain('First reply: A failure email from CI.');
  });

  it('shows only the last three people, and each once when sibling sessions both hold a message', () => {
    const turns = [1, 2, 3, 4].map((n) => person(`message ${n}`, { atMs: T0 + n * 1000, id: `m${n}` }));
    const { text } = inputOf([person('opening', { id: 'open' }), ...turns, ...turns]);

    expect(text.split('\n')).toEqual([
      'First message: opening',
      'Later message: message 2',
      'Later message: message 3',
      'Later message: message 4',
    ]);
  });

  it('reads what a link says about itself', () => {
    const links = [{ title: 'A long read', description: 'Why teams are retiring feature branches' }];
    const { text } = inputOf([person('thoughts? https://example.test/piece', { links })]);

    expect(text).toContain('Linked page says: Why teams are retiring feature branches');
    expect(text).not.toContain('A long read');
  });

  it('gives a late-joining agent the thread so far as its opener, and only the words of a catch-up', () => {
    const first = withThreadContext(
      JSON.stringify({ text: 'and you?', author: { isBot: false } }),
      '[Thread context]\nRiver: is the cutover on for Friday?',
    );
    const catchUp = withThreadContext(
      JSON.stringify({ text: 'ship it', author: { isBot: false } }),
      '[New in thread since last response]\nJuniper: a long report',
    );
    const { text } = inputOf([inboundTurn(row('chat-sdk', first))!, inboundTurn(row('chat-sdk', catchUp, T0 + 1000))!]);

    expect(text.split('\n')).toEqual([
      'First message: River: is the cutover on for Friday? and you?',
      'Later message: ship it',
    ]);
  });

  it('counts a call relay as a person, by the words said', () => {
    const relay = voiceRequestText({
      callerName: 'River',
      request: 'how is the cutover going',
      transcript: '',
      first: true,
    });
    const { text } = inputOf([person('the cutover'), inboundTurn(row('chat', { text: relay }, T0 + 1000))!]);

    expect(text.split('\n')).toEqual(['First message: the cutover', 'Later message: how is the cutover going']);
  });

  it('opens on the first prompt when no person is in the conversation', () => {
    const { text } = inputOf([inboundTurn(row('task', { prompt: 'summarise the night run' }))!, agent(LONG_REPLY)]);

    expect(text).toContain('First message: summarise the night run');
    expect(text).toContain('First reply:');
  });

  it('leaves status rows and system rows out altogether', () => {
    expect(outboundTurn(row('status', { text: 'Accepted · working' }))).toBeNull();
    expect(inboundTurn(row('system', { text: 'wake' }))).toBeNull();
  });

  it('is empty with nothing to read', () => {
    expect(inputOf([])).toEqual({ text: '', awaitingReply: false });
  });
});

describe('titleInput deciding whether a first title should wait', () => {
  const words = (n: number) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');
  const attachments = [{ name: 'shot.png' }];

  it.each([
    ['a link and a word', person('thoughts? https://example.test/piece'), true],
    ['a file and a question', person('what is this', { attachments }), true],
    ['a file alone', person('', { attachments }), true],
    ['fifty words of its own, past mentions', person(`@River ${words(50)} https://example.test`), true],
    ['fifty-one words of its own', person(`${words(51)} https://example.test`), false],
    [
      'a link with a preview, which is not what the agent made of it',
      person('why not? https://example.test', { links: [{ description: 'a teaser' }] }),
      true,
    ],
    ['no link and no file', person('thoughts?'), false],
  ])('%s', (_label, opener, waits) => {
    expect(inputOf([opener]).awaitingReply).toBe(waits);
  });

  it('ends with a real reply, not with a caption', () => {
    const opener = person('thoughts? https://example.test/piece');

    expect(inputOf([opener, agent('On it.')]).awaitingReply).toBe(true);
    expect(inputOf([opener, agent(LONG_REPLY)]).awaitingReply).toBe(false);
  });

  it('counts a reply that reached a sibling session', () => {
    const opener = person('thoughts? https://example.test/piece');

    expect(inputOf([opener, otherAgent(LONG_REPLY)]).awaitingReply).toBe(false);
  });

  it('ends at 30 minutes with no reply at all', () => {
    const opener = person('thoughts? https://example.test/piece');

    expect(titleInput([opener], T0 + 29 * 60_000).awaitingReply).toBe(true);
    expect(titleInput([opener], T0 + 30 * 60_000).awaitingReply).toBe(false);
  });

  it('says so when the file is all there is', () => {
    expect(titleInput([person('', { attachments })], T0 + 30 * 60_000).text).toBe(
      'First message: a file, with no words',
    );
  });
});

describe('keepUnlessChanged', () => {
  it.each([
    ['first title', null, 'Trunk-based releases', 'Trunk-based releases'],
    ['a kept label', 'Key rotation timing', 'KEEP', 'Key rotation timing'],
    ['a verdict in place of a new label', 'Key rotation timing', 'Replace', 'Key rotation timing'],
    ['a one-word first title', null, 'Kubernetes', 'Kubernetes'],
    ['case and punctuation', 'Key rotation timing', 'key-rotation timing!', 'Key rotation timing'],
    ['an added detail', 'Key rotation timing', 'Key rotation timing tonight', 'Key rotation timing'],
    ['a dropped word', 'Deploy freeze rule recording', 'Deploy freeze rule', 'Deploy freeze rule recording'],
    [
      'other forms of the same words',
      'Interpreting your survey results',
      'Survey result interpretation',
      'Interpreting your survey results',
    ],
    [
      'a swapped detail',
      'Group call failed: Acme bad_arguments',
      'Group call failed: Acme member lookup error',
      'Group call failed: Acme bad_arguments',
    ],
    ['a new subject', 'Key rotation timing', 'Billing cutover plan', 'Billing cutover plan'],
    [
      'a medium replaced by its subject',
      'Article about trunk-based releases',
      'Trunk-based releases vs branches',
      'Trunk-based releases vs branches',
    ],
  ])('%s', (_label, current, answer, shown) => {
    expect(keepUnlessChanged(current, answer)).toBe(shown);
  });
});

describe('titlePrompt', () => {
  it('asks for a first title with the input alone', () => {
    expect(titlePrompt(null, 'First message: hello')).toBe('First message: hello');
  });

  it('offers a refresh a one-word way to keep the label, ahead of the input', () => {
    const prompt = titlePrompt('Key rotation timing', 'First message: hello');

    expect(prompt.startsWith('Current label: Key rotation timing\n')).toBe(true);
    expect(prompt).toContain('the single word KEEP');
    expect(prompt.endsWith('First message: hello')).toBe(true);
  });
});
