/**
 * The terminal channel over its real Unix socket: the host's CLI adapter, registered and started the way the host
 * does it, with a socket client standing in for `pnpm run chat`.
 */
import fs from 'fs';
import net from 'net';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('cli-channel') }));

vi.mock('../config.js', async () => ({
  ...(await vi.importActual<typeof import('../config.js')>('../config.js')),
  DATA_DIR: TEST_DIR,
}));

import type { ChannelSetup } from './adapter.js';
import './cli.js';
import { getChannelAdapter, initChannelAdapters, teardownChannelAdapters } from './channel-registry.js';

let socket: net.Socket | null = null;

beforeEach(() => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(async () => {
  socket?.destroy();
  await teardownChannelAdapters();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('CLI channel', () => {
  it('prints an agent card as its fallback text, since a terminal cannot render cards', async () => {
    let heard!: () => void;
    const chatStarted = new Promise<void>((resolve) => (heard = resolve));
    const setup: ChannelSetup = {
      onInbound: () => heard(),
      onInboundEvent: () => heard(),
      onMetadata: () => {},
      onAction: () => {},
    };
    await initChannelAdapters(() => setup);

    const lines: string[] = [];
    socket = net.connect(path.join(TEST_DIR, 'cli.sock'));
    socket.on('data', (chunk) => lines.push(...chunk.toString().split('\n').filter(Boolean)));
    socket.write(`${JSON.stringify({ text: 'hello' })}\n`);
    await chatStarted;

    await getChannelAdapter('cli')!.deliver('local', null, {
      kind: 'chat-sdk',
      content: { type: 'card', spec: { root: 'card', elements: {} }, fallbackText: 'Deploys: 3 this week' },
    });

    await vi.waitFor(() => expect(lines).toEqual([JSON.stringify({ text: 'Deploys: 3 this week' })]));
  });
});
