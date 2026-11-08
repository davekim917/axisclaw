import { describe, expect, it } from 'vitest';

import {
  FRAME_SECONDS,
  UNNAMED_SHOWN,
  nameMatcher,
  requestFromTurn,
  speakerOf,
  type ActivityFrames,
  type TranscriptPiece,
} from './attribution.js';

const isName = nameMatcher('Pixel');
const SLOTS = { marcus: 0, jordan: 1 };
const LOUD = -200;
const QUIET = -1200;

/** Frames from `from` to `to` seconds with the given people speaking. */
function activity(spans: Array<{ from: number; to: number; who: Array<keyof typeof SLOTS> }>): ActivityFrames {
  const frames: ActivityFrames = new Map();
  const last = Math.max(...spans.map((s) => s.to));
  for (let frame = 0; frame <= last / FRAME_SECONDS; frame++) frames.set(frame, [QUIET, QUIET]);
  for (const span of spans)
    for (let frame = Math.floor(span.from / FRAME_SECONDS); frame < span.to / FRAME_SECONDS; frame++)
      for (const who of span.who) frames.get(frame)![SLOTS[who]] = LOUD;
  return frames;
}

/** The request "Pixel, can you check the nightly", spoken from 10.0 s to 12.5 s, its transcript arriving at `at`. */
const request = (at: number): TranscriptPiece[] => [
  { at: at - 2, startMs: 30_000, endMs: 31_000, text: ' Pixel, can you' },
  { at, startMs: 31_000, endMs: 32_500, text: ' check the nightly' },
];

describe('speakerOf', () => {
  it('names the one person speaking while the request was said', () => {
    const frames = activity([
      { from: 2, to: 6, who: ['jordan'] },
      { from: 10, to: 12.5, who: ['marcus'] },
    ]);
    expect(speakerOf({ pieces: request(13.1), frames, slots: SLOTS, isName })).toBe('marcus');
  });

  it.each([
    ['two people spoke over the request', [{ from: 10, to: 12.5, who: ['marcus', 'jordan'] as const }]],
    ['nobody was speaking where the transcript places it', [{ from: 2, to: 5, who: ['marcus'] as const }]],
  ])('names nobody when %s', (_what, spans) => {
    const frames = activity(spans.map((s) => ({ ...s, who: [...s.who] })));
    expect(speakerOf({ pieces: request(13.1), frames, slots: SLOTS, isName })).toBeNull();
  });

  it('names nobody when the transcript never names the agent', () => {
    const frames = activity([{ from: 10, to: 12.5, who: ['marcus'] }]);
    const pieces = [{ at: 13.1, startMs: 30_000, endMs: 32_500, text: 'somebody should check the nightly' }];
    expect(speakerOf({ pieces, frames, slots: SLOTS, isName })).toBeNull();
  });
});

describe('requestFromTurn', () => {
  it('shows the only person on the call everything they said, and still drops an exact re-send', () => {
    const turn = 'Can you check whether the deploy finished?';
    expect(requestFromTurn(turn, isName, null, 0, true)).toEqual({ text: turn, shown: turn });
    const named = 'Stop the deployment. Pixel, check the logs.';
    expect(requestFromTurn(named, isName, null, 0, true)).toEqual({ text: named, shown: named });
    expect(requestFromTurn(turn, isName, { turn, atMs: 0 }, 1_000, true)).toBe('duplicate');
    expect(requestFromTurn('   ', isName, null, 0, true)).toBeNull();
  });

  it.each([
    [
      'chatter before the request, shown from where the agent is spoken to',
      "Tacos it is. I think Pixel broke the build. Pixel, can you check whether last night's nightly passed?",
      "Pixel, can you check whether last night's nightly passed?",
    ],
    [
      'a request with the name at its end',
      'Okay. Can you check the nightly, Pixil?',
      'Can you check the nightly, Pixil?',
    ],
    [
      'two instructions with no comma after the name',
      'Pixel can you stop the deploy. Can you confirm, Pixel?',
      'Can you confirm, Pixel?',
    ],
    [
      'a request that only mentions the agent',
      'Lunch was great. Can Pixel check the nightly?',
      'Can Pixel check the nightly?',
    ],
  ])('hands over the whole turn for %s', (_what, turn, shown) => {
    expect(requestFromTurn(turn, isName)).toEqual({ text: turn, shown });
  });

  it('hands over a turn whose text never names the agent, and shows the thread a placeholder', () => {
    const turn = 'Pickle, rerun the tests';
    expect(requestFromTurn(turn, isName)).toEqual({ text: turn, shown: UNNAMED_SHOWN });
  });

  it.each([
    ['a name in Cyrillic', 'Ну что. Алиса, проверь сборку.', 'Алиса'],
    ['a Latin name in unspaced Japanese', 'Pixel、ビルドを確認して。', 'Pixel'],
  ])('hears %s', (_what, turn, name) => {
    expect(requestFromTurn(turn, nameMatcher(name))).toMatchObject({ text: turn });
  });

  it('hands over only the new words when the voice sends the same turn again with more', () => {
    const previous = { turn: 'Pixel, deploy the build.', atMs: 1_000 };
    expect(requestFromTurn("Pixel, deploy the build. Actually no, don't.", isName, previous, 2_000)).toEqual({
      text: "Actually no, don't.",
      shown: UNNAMED_SHOWN,
    });
  });

  it('keeps unnamed words out of the thread while the agent still gets them', () => {
    const previous = { turn: 'Pixel, check the nightly.', atMs: 1_000 };
    const turn = 'Pixel, check the nightly. Marcus, did HR send you the review?';
    expect(requestFromTurn(turn, isName, previous, 2_000)).toEqual({
      text: 'Marcus, did HR send you the review?',
      shown: UNNAMED_SHOWN,
    });
  });

  it('treats a changed number as new words, not as the turn already handed over', () => {
    const previous = { turn: 'Pixel, refund 105', atMs: 1_000 };
    const turn = 'Pixel, refund 10.5. Thanks';
    expect(requestFromTurn(turn, isName, previous, 2_000)).toMatchObject({ text: turn });
  });

  it('caps what the thread shows, never what the agent gets', () => {
    const turn = `Pixel, ${'check the nightly and '.repeat(60)}report back.`;
    const request = requestFromTurn(turn, isName);
    expect(request).toMatchObject({ text: turn });
    expect((request as { shown: string }).shown.length).toBeLessThanOrEqual(601);
  });

  it('hands over the whole turn when it only starts like the last one', () => {
    const previous = { turn: 'Pixel, check the nightly', atMs: 1_000 };
    const turn = 'Pixel, check the weekly';
    expect(requestFromTurn(turn, isName, previous, 2_000)).toEqual({ text: turn, shown: turn });
  });
});

describe('requestFromTurn, repeats', () => {
  const previous = { turn: "Pixel, check whether last night's nightly passed", atMs: 1_000 };
  it.each([
    ['the same turn a moment later', "Pixel, check whether last night's nightly passed.", 2_000, true],
    ['the same turn after the window', "Pixel, check whether last night's nightly passed", 30_000, false],
    ['a different request', 'Pixel, what did we decide about Friday', 2_000, false],
    ['a correction that reverses it', "Pixel, don't check whether last night's nightly passed", 2_000, false],
  ])('treats %s as a duplicate: %s', (_what, text, now, expected) => {
    expect(requestFromTurn(text, isName, previous, now) === 'duplicate').toBe(expected);
  });

  it('lets a request through again once a different one came after it', () => {
    const latest = { turn: 'Pixel, please do not deploy the latest build to production now', atMs: 2_000 };
    const deploy = 'Pixel, please deploy the latest build to production now';
    expect(requestFromTurn(deploy, isName, latest, 3_000)).toEqual({ text: deploy, shown: deploy });
    expect(requestFromTurn(latest.turn, isName, latest, 3_000)).toBe('duplicate');
  });
});
