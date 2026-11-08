import { describe, expect, it } from 'vitest';

import { joinMicFirst, keepPinned } from './join-page.js';

describe('keepPinned', () => {
  it.each([
    { reader: 'at the bottom', scrollTop: 600, followed: true },
    { reader: '40px above the bottom', scrollTop: 560, followed: true },
    { reader: '41px above the bottom', scrollTop: 559, followed: false },
    { reader: 'scrolled up to reread', scrollTop: 100, followed: false },
  ])('a reader $reader is followed to the new line: $followed', ({ scrollTop, followed }) => {
    const box = { scrollTop, scrollHeight: 1000, clientHeight: 400 };
    keepPinned(box, () => {
      box.scrollHeight += 300;
    });
    expect(box.scrollTop).toBe(followed ? 1300 : scrollTop);
  });
});

describe('joinMicFirst', () => {
  const shipped = new Function(`return ${joinMicFirst.toString()}`)() as typeof joinMicFirst;

  function fakes(connectFails = false) {
    const steps: string[] = [];
    const mic = { stop: () => steps.push('mic stopped') };
    const L = {
      Track: { Source: { Microphone: 'microphone' } },
      createLocalAudioTrack: async (options: object) => (steps.push(`mic opened ${JSON.stringify(options)}`), mic),
    };
    const room = {
      connect: async (url: string) => {
        steps.push(`connected ${url}`);
        if (connectFails) throw new Error('room unreachable');
      },
      startAudio: async () => void steps.push('audio started'),
      localParticipant: {
        publishTrack: async (track: unknown, options: { source: string }) =>
          void steps.push(`published ${track === mic ? 'the mic' : 'something else'} as ${options.source}`),
      },
    };
    return { steps, mic, L, room };
  }

  it('opens the mic before the room connects or plays anything, then publishes it as the microphone', async () => {
    const { steps, mic, L, room } = fakes();
    expect(await shipped(L, room, { url: 'wss://room.example', token: 't' })).toBe(mic);
    expect(steps).toEqual([
      'mic opened {"echoCancellation":true,"noiseSuppression":true,"autoGainControl":true}',
      'connected wss://room.example',
      'audio started',
      'published the mic as microphone',
    ]);
  });

  it('releases the mic when the room cannot be reached', async () => {
    const { steps, L, room } = fakes(true);
    await expect(shipped(L, room, { url: 'wss://room.example', token: 't' })).rejects.toThrow('room unreachable');
    expect(steps.at(-1)).toBe('mic stopped');
  });
});
