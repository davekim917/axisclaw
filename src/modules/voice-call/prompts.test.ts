import { describe, expect, it } from 'vitest';

import { groupCallEndedText, groupRequestText, relayedWords, voiceRequestText } from './prompts.js';

describe('groupRequestText', () => {
  it('keeps both the start and the end of a relay too long for one message', () => {
    const request = `Pixel, stop the production deploy. ${'Lunch talk. '.repeat(600)}Pixel, then check the nightly.`;
    const text = groupRequestText({ speaker: null, request, first: false, solo: false });
    expect(text).toContain('Pixel, stop the production deploy.');
    expect(text).toContain('Pixel, then check the nightly.');
    expect(text).toContain('…truncated…');
  });
});

describe('relayedWords', () => {
  const said = 'is 3 < 5 & why did <it> move?';

  it.each([
    ['a first group relay', groupRequestText({ speaker: 'Riley', request: said, first: true, solo: false })],
    ['a later group relay', groupRequestText({ speaker: null, request: said, first: false, solo: true })],
    ['a one-to-one relay', voiceRequestText({ callerName: 'Riley', request: said, transcript: '', first: true })],
  ])('reads the words back out of %s', (_name, relay) => {
    expect(relayedWords(relay)).toBe(said);
  });

  it.each([
    ['an ordinary message that happens to carry the tag', 'see <request>this</request> in the docs'],
    ['a call notice with no request', groupCallEndedText()],
  ])('is null for %s', (_name, text) => {
    expect(relayedWords(text)).toBeNull();
  });
});
