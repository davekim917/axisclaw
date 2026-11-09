import { beforeEach, describe, expect, it, vi } from 'vitest';

const net = vi.hoisted(() => ({ sockets: [] as Array<{ sent: string[]; open(): void }> }));

vi.mock('undici', () => {
  class FakeSocket {
    static OPEN = 1;
    readyState = 0;
    sent: string[] = [];
    onopen: (() => void) | null = null;
    constructor() {
      net.sockets.push(this);
    }
    send(text: string) {
      this.sent.push(text);
    }
    close() {}
    open() {
      this.readyState = 1;
      this.onopen?.();
    }
  }
  return {
    WebSocket: FakeSocket,
    fetch: async () => ({
      ok: true,
      status: 201,
      text: async () => 'v=0 answer',
      headers: new Headers({ location: '/v1/realtime/calls/rtc_test123' }),
    }),
  };
});

const { openLiveCall } = await import('./live.js');

async function connect() {
  const call = await openLiveCall({
    offer: 'v=0 offer',
    instructions: 'be brief',
    login: async () => ({ token: 't', accountId: 'a' }),
    onEvent: () => undefined,
  });
  const socket = net.sockets[net.sockets.length - 1];
  socket.open();
  const frames = () => socket.sent.map((text) => JSON.parse(text) as Record<string, unknown>);
  return { call, frames };
}

beforeEach(() => {
  net.sockets.length = 0;
});

describe('openLiveCall context', () => {
  it.each([
    ['say', undefined, { type: 'session.context.append', channel: 'speakable' }],
    ['say', 'item_1', { type: 'delegation.context.append', delegation_item_id: 'item_1', channel: 'speakable' }],
    ['check-in', 'item_1', { type: 'delegation.context.append', delegation_item_id: 'item_1', channel: 'commentary' }],
    ['know', undefined, { type: 'session.context.append', channel: 'developer' }],
    ['know', 'item_1', { type: 'session.context.append', channel: 'developer' }],
  ] as const)('sends %s on delegation %s as the frame the service accepts', async (use, delegationId, expected) => {
    const { call, frames } = await connect();
    call.context('Shard 3 of 8 is running.', use, delegationId);
    expect(frames()).toEqual([
      {
        ...expected,
        event_id: expect.stringMatching(/^nc_/),
        content: [{ type: 'input_text', text: 'Shard 3 of 8 is running.' }],
      },
    ]);
  });

  it('splits text the service would refuse into appends of at most 500 bytes, each with its own event id', async () => {
    const { call, frames } = await connect();
    const text = 'é'.repeat(300) + 'x'.repeat(301);
    call.context(text, 'know');
    const sent = frames();
    const parts = sent.map((f) => (f.content as Array<{ text: string }>)[0].text);
    expect(parts.join('')).toBe(text);
    expect(Math.max(...parts.map((p) => Buffer.byteLength(p)))).toBeLessThanOrEqual(500);
    expect(new Set(sent.map((f) => f.event_id)).size).toBe(sent.length);
  });
});
