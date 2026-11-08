import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const calls: string[][] = [];

vi.mock('../../../config.js', () => ({
  INSTALL_SLUG: 'feedc0de',
  VOICE_CALL_PUBLIC_IP: '203.0.113.7',
  VOICE_GROUP_SIGNAL_PORT: 17880,
}));
vi.mock('../../../container-runtime.js', () => ({
  runRuntime: async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'network' && args[1] === 'inspect') return '[]';
    return '';
  },
}));

const { ensureLiveKit, stopLiveKit, deleteRoom, removeParticipant, LIVEKIT_INTERNAL_URL } =
  await import('./livekit.js');

beforeEach(() => {
  calls.length = 0;
  vi.stubGlobal('fetch', async () => new Response('ok'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('room server', () => {
  it("names, removes and reaches only its own install's room server", async () => {
    await ensureLiveKit();
    await stopLiveKit();

    const run = calls.find((args) => args[0] === 'run')!;
    const name = run[run.indexOf('--name') + 1];
    expect(name).toContain('feedc0de');
    expect(new URL(LIVEKIT_INTERNAL_URL).hostname).toBe(name);
    const removed = calls.filter((args) => args[0] === 'rm').map((args) => args.slice(2));
    expect(removed).toEqual([[name], [name]]);
  });

  it('signs each room-service call with the grant LiveKit checks for it', async () => {
    const grants: Record<string, unknown> = {};
    vi.stubGlobal('fetch', async (url: string, init: { headers?: Record<string, string> }) => {
      if (!init.headers) return new Response('ok');
      const token = init.headers.authorization.replace('Bearer ', '');
      grants[url.split('/').pop()!] = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString()).video;
      return new Response('{}');
    });
    await ensureLiveKit();
    await removeParticipant('room-1', 'p-1');
    await deleteRoom('room-1');
    await stopLiveKit();

    expect(grants.RemoveParticipant).toEqual({ room: 'room-1', roomAdmin: true });
    expect(grants.DeleteRoom).toEqual({ room: 'room-1', roomCreate: true });
  });
});
