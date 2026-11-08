import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { ARCHIVE_DIR } = vi.hoisted(() => ({ ARCHIVE_DIR: uniqueTmpRoot('voice-call-feed-archive') }));
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  DATA_DIR: ARCHIVE_DIR,
}));

const { notifyOutboundDelivered } = await import('../../delivery-events.js');
const { __resetArchiveConnectionForTest, archiveMessage } = await import('../../message-archive.js');
const { _clearSecretsForTest, registerSecrets } = await import('../../secret-scrubber.js');
const { ensureSchema } = await import('../mailbox/schema.js');
const { followSessionFeed } = await import('./session-feed.js');
import type { CallRoute } from './registry.js';
import type { FeedEvent } from './session-feed.js';

const route: CallRoute = {
  channelType: 'slack-acme',
  instance: 'slack-acme',
  platformId: 'slack:C1',
  threadId: 'slack:C1:111.1',
  messagingGroupId: 'mg-1',
};
const location = { agentGroupId: 'ag-atlas', sessionId: 'sess-1', dataDir: '' };

let out: Database.Database;
let inbound: Database.Database;
let seq = 0;

function sent(kind: string, content: object, extra: { inReplyTo?: string; threadId?: string | null } = {}) {
  out
    .prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `out-${++seq}`,
      seq * 2 + 1,
      extra.inReplyTo ?? null,
      new Date().toISOString(),
      kind,
      route.platformId,
      route.channelType,
      extra.threadId === undefined ? route.threadId : extra.threadId,
      JSON.stringify(content),
    );
}

function received(id: string, content: object, kind = 'chat-sdk', threadId: string | null = route.threadId) {
  inbound
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      ++seq * 2,
      kind,
      new Date().toISOString(),
      route.platformId,
      route.channelType,
      threadId,
      JSON.stringify(content),
    );
}

beforeEach(() => {
  vi.useFakeTimers();
  location.dataDir = uniqueTmpRoot('voice-call-feed');
  const dir = path.join(location.dataDir, 'v2-sessions', location.agentGroupId, location.sessionId);
  fs.mkdirSync(dir, { recursive: true });
  ensureSchema(path.join(dir, 'outbound.db'), 'outbound');
  ensureSchema(path.join(dir, 'inbound.db'), 'inbound');
  out = new Database(path.join(dir, 'outbound.db'));
  inbound = new Database(path.join(dir, 'inbound.db'));
  seq = 0;
});

afterEach(() => {
  vi.useRealTimers();
  out.close();
  inbound.close();
  fs.rmSync(location.dataDir, { recursive: true, force: true });
  __resetArchiveConnectionForTest();
  fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true });
});

let archiveCount = 0;
function inArchive(
  role: 'user' | 'assistant',
  text: string,
  threadId: string | null = route.threadId,
  senderName?: string,
) {
  archiveMessage(
    {
      id: `arch-${++archiveCount}`,
      agentGroupId: location.agentGroupId,
      messagingGroupId: route.messagingGroupId,
      channelType: route.channelType,
      channelName: null,
      platformId: route.platformId,
      threadId,
      role,
      senderId: null,
      senderName: senderName ?? (role === 'assistant' ? 'assistant' : null),
      text,
      sentAt: new Date(Date.UTC(2026, 9, 26, 12, 0, archiveCount)).toISOString(),
    },
    { workgroupId: null },
  );
}

const posted = (text: string, extra: { sessionId?: string; inReplyTo?: string; threadId?: string | null } = {}) =>
  notifyOutboundDelivered({
    sessionId: extra.sessionId ?? location.sessionId,
    outboundId: `posted-${text}`,
    inReplyTo: extra.inReplyTo ?? null,
    post: {
      text,
      channelType: route.channelType,
      platformId: route.platformId,
      threadId: extra.threadId === undefined ? route.threadId : extra.threadId,
    },
  });
const ran = (action: string, sessionId = location.sessionId) =>
  notifyOutboundDelivered({ sessionId, outboundId: `ran-${action}`, inReplyTo: null, action });

describe('followSessionFeed', () => {
  it('opens with the thread as it was posted, from the archive', () => {
    inArchive('user', 'earlier question', route.threadId, 'Sam Roe');
    inArchive('assistant', 'earlier answer');
    inArchive('user', 'a different thread', 'slack:C1:999.9', 'Sam Roe');
    archiveMessage(
      {
        id: 'arch-sibling',
        agentGroupId: 'ag-sibling',
        messagingGroupId: route.messagingGroupId,
        channelType: route.channelType,
        channelName: null,
        platformId: route.platformId,
        threadId: route.threadId,
        role: 'assistant',
        senderId: null,
        senderName: 'assistant',
        text: 'a sibling agent’s own copy',
        sentAt: new Date().toISOString(),
      },
      { workgroupId: null },
    );
    archiveMessage(
      {
        id: 'arch-elsewhere',
        agentGroupId: location.agentGroupId,
        messagingGroupId: route.messagingGroupId,
        channelType: route.channelType,
        channelName: null,
        platformId: 'slack:C9',
        threadId: route.threadId,
        role: 'assistant',
        senderId: null,
        senderName: 'assistant',
        text: 'posted to another channel from this conversation',
        sentAt: new Date().toISOString(),
      },
      { workgroupId: null },
    );
    sent('chat', { text: 'written but never posted' });
    const feed = followSessionFeed(location, route, 'voice-call1-', () => undefined);
    expect(feed.recent).toEqual([
      { type: 'inbound', sender: 'Sam Roe', text: 'earlier question' },
      { type: 'reply', text: 'earlier answer', inReplyTo: null },
    ]);
    feed.close();
  });

  it('speaks what delivery posts to the call’s thread, and only that', () => {
    const seen: FeedEvent[] = [];
    const feed = followSessionFeed(location, route, 'voice-call1-', (e) => seen.push(e));
    sent('chat', { text: 'written, not yet posted' }, { inReplyTo: 'voice-call1-1' });
    vi.advanceTimersByTime(600);
    expect(seen).toEqual([]);

    posted('Two tests fail.', { inReplyTo: 'voice-call1-1' });
    posted('posted elsewhere', { threadId: 'slack:C1:999.9' });
    posted('another session', { sessionId: 'sess-other' });
    ran('turn_end', 'sess-other');
    ran('wiki_admission');
    ran('turn_end');
    expect(seen).toEqual([
      { type: 'reply', text: 'Two tests fail.', inReplyTo: 'voice-call1-1' },
      { type: 'turn-end' },
    ]);

    feed.close();
    posted('after hang-up');
    expect(seen).toHaveLength(2);
  });

  it('gives the call the agent’s progress and what people wrote in its thread, in order, after it starts', () => {
    received('m-before', { text: 'earlier question', sender: 'Sam Roe' });
    sent('status', { text: 'earlier progress', reporting: { purpose: 'progress' } });
    const seen: FeedEvent[] = [];
    const feed = followSessionFeed(location, route, 'voice-call1-', (e) => seen.push(e));

    received('voice-call1-1', { text: '[Voice call] check the tests', sender: 'Rae Doe' }, 'chat');
    sent('status', { text: 'Accepted · working', reporting: { purpose: 'liveness' } }, { inReplyTo: 'voice-call1-1' });
    sent('status', { text: '🔧 Running vitest', reporting: { purpose: 'progress' } }, { inReplyTo: 'voice-call1-1' });
    received('m-peer', { text: 'is lint green too?', author: { fullName: 'Ida Vale', isBot: false } });
    sent(
      'work_log',
      { text: 'the whole turn output, <message to="ops">elsewhere</message>' },
      { inReplyTo: 'voice-call1-1' },
    );
    sent('status', { text: '🔧 Reading the auth log' }, { inReplyTo: 'voice-call1-1' });
    sent('status', { text: 'other thread work', reporting: { purpose: 'progress' } }, { threadId: 'slack:C1:999.9' });
    received('m-elsewhere', { text: 'other thread chat', sender: 'Sam Roe' }, 'chat-sdk', 'slack:C1:999.9');
    received('host-note', { text: 'restarted', origin: 'host' }, 'chat');
    sent('system', { action: 'turn_end' });
    vi.advanceTimersByTime(600);

    expect(seen).toEqual([
      { type: 'progress', text: '🔧 Running vitest', inReplyTo: 'voice-call1-1' },
      { type: 'inbound', sender: 'Ida Vale', text: 'is lint green too?' },
      { type: 'progress', text: '🔧 Reading the auth log', inReplyTo: 'voice-call1-1' },
    ]);
    vi.advanceTimersByTime(600);
    expect(seen).toHaveLength(3);
    feed.close();
  });

  it('never hands the voice a registered secret from progress, the thread, or its history', () => {
    registerSecrets({ FAKE_API_KEY: 'zx-fake-9f8e7d6c5b4a' });
    try {
      inArchive('user', 'my key is zx-fake-9f8e7d6c5b4a', route.threadId, 'Ida Vale');
      const seen: FeedEvent[] = [];
      const feed = followSessionFeed(location, route, 'voice-call1-', (e) => seen.push(e));
      sent('status', { text: 'curl -H "Bearer zx-fake-9f8e7d6c5b4a"', reporting: { purpose: 'progress' } });
      received('m-peer', { text: 'use zx-fake-9f8e7d6c5b4a', sender: 'Ida Vale' });
      vi.advanceTimersByTime(600);
      expect(JSON.stringify([feed.recent, seen])).not.toContain('zx-fake-9f8e7d6c5b4a');
      expect([...feed.recent, ...seen].map((e) => ('text' in e ? e.text : ''))).toEqual([
        'my key is [REDACTED]',
        'curl -H "Bearer [REDACTED]"',
        'use [REDACTED]',
      ]);
      feed.close();
    } finally {
      _clearSecretsForTest();
    }
  });

  it('keeps up when more rows arrive between polls than one read takes', () => {
    const seen: FeedEvent[] = [];
    const feed = followSessionFeed(location, route, 'voice-call1-', (e) => seen.push(e));
    out.transaction(() => {
      for (let i = 0; i < 450; i++) sent('status', { text: `r${i}` });
    })();
    vi.advanceTimersByTime(500 * 4);
    expect(seen).toHaveLength(450);
    expect(seen[449]).toEqual({ type: 'progress', text: 'r449', inReplyTo: null });
    feed.close();
  });

  it('stays empty and quiet on a session with no mailbox yet', () => {
    const fresh = { ...location, sessionId: 'sess-new' };
    const seen: FeedEvent[] = [];
    const feed = followSessionFeed(fresh, route, 'voice-call1-', (e) => seen.push(e));
    expect(feed.recent).toEqual([]);
    vi.advanceTimersByTime(600);
    expect(seen).toEqual([]);
    feed.close();
  });
});
