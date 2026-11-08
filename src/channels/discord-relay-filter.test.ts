import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Adapter, Message as ChatMessage } from 'chat';

vi.mock('../webhook-server.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../webhook-server.js')>()),
  registerWebhookAdapter: vi.fn(),
}));

import { closeDb, initMigratedTestDb } from '../db/index.js';
import { _resetRelayPostsForTest, recordRelayPost } from '../discord-relay-posts.js';
import type { ChannelSetup } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { isDiscordInbound } from './discord.js';

const BOT = '111111111111111111';
const THREAD = '333333333333333333';
const TEXT = '**Ana Example** · from the Anderton app\nOn it.';

beforeEach(async () => {
  _resetRelayPostsForTest();
  await initMigratedTestDb();
  await recordRelayPost({ botUserId: BOT, channelId: THREAD, text: TEXT, nonce: 'nonce-example-01' });
});

afterEach(() => closeDb());

/** A message by `author` in the thread, as the Discord adapter hands it to the bridge. */
function fromDiscord(id: string, author: string, content: string, live = false): ChatMessage {
  const raw = { id, type: 0, channel_id: THREAD, content, ...(live ? { nonce: 'nonce-example-01' } : {}) };
  const authorFields = { userId: author, userName: 'sibling', fullName: 'Sibling', isBot: true, isMe: false };
  return {
    id,
    threadId: `discord:G1:C1:${THREAD}`,
    text: content,
    formatted: { type: 'root', children: [] },
    raw,
    author: authorFields,
    metadata: { dateSent: new Date('2026-07-21T18:18:00Z'), edited: false },
    attachments: [],
    links: [],
    toJSON: () => ({ id, text: content, author: authorFields }),
  } as unknown as ChatMessage;
}

describe('a sibling bot’s copy of a reply the host posted for someone', () => {
  it('is dropped live, while the bot’s other posts and a person’s message with the same words pass', () => {
    expect(isDiscordInbound(fromDiscord('555555555555555555', BOT, 'edited away', true))).toBe(false);
    expect(isDiscordInbound(fromDiscord('666666666666666666', BOT, 'Its next post.'))).toBe(true);
    expect(isDiscordInbound(fromDiscord('777777777777777777', '999999999999999999', TEXT))).toBe(true);
  });

  it('is dropped when the sibling catches up on what it missed, and everything else is recovered', async () => {
    const bridge = createChatSdkBridge({
      adapter: {
        name: 'discord-sibling',
        initialize: async () => {},
        channelIdFromThreadId: () => 'discord:G1:C1',
        fetchMessages: vi.fn(async () => ({
          messages: [
            fromDiscord('555555555555555555', BOT, TEXT),
            fromDiscord('666666666666666666', BOT, 'An agent’s own post.'),
          ],
        })),
      } as unknown as Adapter,
      supportsThreads: true,
      allowRecoveredBotMessage: () => true,
      inboundFilter: isDiscordInbound,
    });
    const routed: string[] = [];
    await bridge.setup({
      onInbound: async (_platformId, _threadId, message) => void routed.push(message.id),
      onInboundEvent: async () => {},
      onMetadata: () => {},
      onAction: () => {},
    } as ChannelSetup);

    await bridge.recoverMissedMessages!({
      since: '2026-07-21T18:16:00Z',
      reason: 'event-loop-stall',
      targets: [{ platformId: 'discord:G1:C1', threadId: `discord:G1:C1:${THREAD}`, isDM: false }],
    });

    expect(routed).toEqual(['666666666666666666']);
  });
});
