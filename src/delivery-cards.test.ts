/**
 * Agent cards through the delivery drain: the real `deliverSessionMessages`, the real Chat SDK bridge, and a fake
 * Slack adapter that records what it was asked to post. The converter the real adapter posts with reads the posted card,
 * so a pass means Slack would receive native blocks, not a text fallback.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { cardToBlockKit } from '@chat-adapter/slack';
import type { Adapter, AdapterPostableMessage, CardElement } from 'chat';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups`, TASK_LIST_ENABLED: false };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-delivery-cards') }));

import { createChatSdkBridge } from './channels/chat-sdk-bridge.js';
import { closeDb, createAgentGroup, createMessagingGroup, initMigratedTestDb } from './db/index.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { __resetArchiveConnectionForTest, threadMessageById } from './message-archive.js';
import { openInboundDb } from './modules/mailbox/openers.js';
import { resolveSession } from './session-manager.js';

const CHANNEL = 'slack:C0CARDS';

const report = {
  root: 'card',
  elements: {
    card: { type: 'Card', props: { title: 'Weekly deploys' }, children: ['kpis', 'chart', 'table', 'links'] },
    kpis: { type: 'Fields', props: {}, children: ['deploys'] },
    deploys: { type: 'Field', props: { label: 'Deploys', value: 1284 }, children: [] },
    chart: {
      type: 'Chart',
      props: {
        title: 'Deploys per day',
        chart: { type: 'bar', categories: ['Mon', 'Tue'], series: [{ name: 'Deploys', values: [180, 210] }] },
      },
      children: [],
    },
    table: {
      type: 'Table',
      props: { headers: ['Project', 'Deploys'], rows: [['web', '412']], align: ['left', 'right'] },
      children: [],
    },
    links: { type: 'Actions', props: {}, children: ['open'] },
    open: { type: 'LinkButton', props: { label: 'Open dashboard', url: 'https://example.com/deploys' }, children: [] },
  },
};

const posts: AdapterPostableMessage[] = [];

function fakeSlackAdapter(): Adapter {
  return {
    name: 'slack',
    postMessage: async (threadId: string, message: AdapterPostableMessage) => {
      posts.push(message);
      return { id: '1790000100.000100', threadId, raw: {} };
    },
  } as unknown as Adapter;
}

function writeCard(sessionId: string, id: string, content: object): void {
  const db = new Database(outboundDbPath('ag-cards', sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, ?, 'chat-sdk', ?, 'slack', ?)`,
  ).run(id, new Date().toISOString(), CHANNEL, JSON.stringify(content));
  db.close();
}

function deliveredRow(sessionId: string, id: string): unknown {
  const db = openInboundDb(inboundDbPath('ag-cards', sessionId));
  try {
    return db.prepare('SELECT status, error FROM delivered WHERE message_out_id = ?').get(id);
  } finally {
    db.close();
  }
}

async function cardSession() {
  const createdAt = new Date().toISOString();
  await createAgentGroup({
    id: 'ag-cards',
    name: 'Card Agent',
    folder: 'card-agent',
    agent_provider: null,
    created_at: createdAt,
  });
  await createMessagingGroup({
    id: 'mg-cards',
    channel_type: 'slack',
    platform_id: CHANNEL,
    name: 'deploys',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: createdAt,
  });
  return (await resolveSession('ag-cards', 'mg-cards', null, 'shared')).session;
}

beforeEach(async () => {
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  posts.length = 0;
  const bridge = createChatSdkBridge({ adapter: fakeSlackAdapter(), channelType: 'slack', supportsThreads: true });
  setDeliveryAdapter({
    deliver: (_channelType, platformId, threadId, kind, content, files) =>
      bridge.deliver(platformId, threadId, { kind, content: JSON.parse(content), files }),
  });
});

afterEach(async () => {
  __resetArchiveConnectionForTest();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('agent cards through delivery', () => {
  it('posts a valid spec once as native Slack blocks, with its fallback text for clients without cards', async () => {
    const session = await cardSession();
    writeCard(session.id, 'card-ok', { type: 'card', spec: report, fallbackText: 'Weekly deploys: 1,284' });

    await deliverSessionMessages(session);

    expect(posts).toHaveLength(1);
    const posted = posts[0] as { card: CardElement; fallbackText: string };
    expect(posted.fallbackText).toBe('Weekly deploys: 1,284');
    expect(cardToBlockKit(posted.card).map((block) => block.type)).toEqual([
      'header',
      'section',
      'data_visualization',
      'data_table',
      'actions',
    ]);
    expect(deliveredRow(session.id, 'card-ok')).toEqual({ status: 'delivered', error: null });
  });

  it('keeps a posted card in the archive as its fallback text', async () => {
    const session = await cardSession();
    writeCard(session.id, 'card-archived', { type: 'card', spec: report, fallbackText: '  Weekly deploys: 1,284\n' });

    await deliverSessionMessages(session);

    expect(threadMessageById('card-archived')).toMatchObject({ role: 'assistant', text: 'Weekly deploys: 1,284' });
  });

  it('posts nothing for an invalid spec and records every issue where the agent’s tool reads it', async () => {
    const session = await cardSession();
    const spec = structuredClone(report) as { elements: Record<string, { props: Record<string, unknown> }> };
    spec.elements.deploys.props.label = '';
    spec.elements.open = { type: 'Button', props: { id: 'ship', label: 'Ship' }, children: [] } as never;
    writeCard(session.id, 'card-bad', { type: 'card', spec, fallbackText: ' ' });

    await deliverSessionMessages(session);

    expect(posts).toEqual([]);
    const row = deliveredRow(session.id, 'card-bad') as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toContain('- fallbackText is required');
    expect(row.error).toContain('- open: unknown component "Button"');
    expect(row.error).toContain('- deploys.props.label:');
    expect(threadMessageById('card-bad')).toBeNull();
  });

  it('refuses a card past Slack’s caps instead of letting the adapter degrade it', async () => {
    const session = await cardSession();
    const spec = structuredClone(report) as { elements: Record<string, unknown> };
    spec.elements.table2 = spec.elements.table;
    (spec.elements.card as { children: string[] }).children.push('table2');
    writeCard(session.id, 'card-two-tables', { type: 'card', spec, fallbackText: 'Two tables' });

    await deliverSessionMessages(session);

    expect(posts).toEqual([]);
    expect(deliveredRow(session.id, 'card-two-tables')).toEqual({
      status: 'failed',
      error: expect.stringContaining('- at most 1 Table per message'),
    });
  });
});
