/**
 * The DM a thread-delivered card sends to the human who has to answer it: a copy of the card itself, then a note
 * pointing at the original, or the pointer alone when the copy cannot be posted. Real central DB and a real session
 * inbound.db; the delivery adapter and the channel registry are fakes, so each case reads what would have been DMed.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from '../../db/connection.js';
import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import {
  createPendingApproval,
  createSession,
  getPendingApproval,
  updatePendingApprovalStatus,
} from '../../db/sessions.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { setWorkgroupApprovalsChannel } from './approvals-channel.js';
import { sendCardPointer } from './card-pointer.js';
import { registerChoiceHandler, retireChoice } from './choices.js';
import { registerApprovalHandler, REJECT_WITH_REASON_VALUE } from './primitive.js';
import { handleApprovalsResponse } from './response-handler.js';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-card-pointer') }));

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

const CHANNEL = 'slack-example';
const WORK_PLATFORM = 'slack:C0WORK';
const THREAD = 'slack:C0WORK:1786621514.008659';
const CARD_TS = '1786621599.000100';
const CARD_LINK = `https://example-labs.slack.com/archives/C0WORK/p1786621599000100?thread_ts=1786621514.008659&cid=C0WORK`;

vi.mock('../../channels/channel-registry.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../channels/channel-registry.js')>();
  const { slackMessagePermalink, registerSlackBot } = await import('../../channels/slack-mentions.js');
  registerSlackBot('slack-example', {
    userId: 'U0BOT',
    username: 'bot',
    teamId: 'T0EXAMPLE',
    workspaceUrl: 'https://example-labs.slack.com/',
  });
  registerSlackBot('slack-example-queue', { userId: 'U0QBOT', username: 'queue', teamId: 'T0EXAMPLE' });
  registerSlackBot('slack-elsewhere', { userId: 'U0EBOT', username: 'elsewhere', teamId: 'T0OTHERTEAM' });
  const adapter = {
    messagePermalink: (platformId: string, threadId: string | null, messageId: string) =>
      slackMessagePermalink('slack-example', platformId, threadId, messageId),
  };
  return {
    ...actual,
    getChannelAdapter: (key: string) => (key.startsWith('slack-') ? adapter : undefined),
    getChannelAdapterExact: (key: string) => (key.startsWith('slack-') ? adapter : undefined),
  };
});

const CHOICE_ACTION = 'test_choice';
const GATE_ACTION = 'test_gate';
registerChoiceHandler(CHOICE_ACTION, async () => null);
const ADMIN_GATE_ACTION = 'test_admin_gate';
registerApprovalHandler(ADMIN_GATE_ACTION, async () => undefined, { adminClickOnly: true });

const QUEUE_BOT = 'slack-example-queue';
const QUEUE = 'slack:C0QUEUE2';

const REQUESTER = `${CHANNEL}:U0REQ`;
const ADMIN = `${CHANNEL}:U0ADMIN`;

interface Delivered {
  channelType: string;
  platformId: string;
  threadId: string | null;
  text: string;
  content: Record<string, unknown>;
}
let delivered: Delivered[];
let deleted: Array<{ channelType: string; platformId: string; messageId: string; instance?: string }>;
let session: Session;

function now(): string {
  return new Date().toISOString();
}

function insertInbound(content: Record<string, unknown>, opts: { kind?: string; timestamp?: string } = {}): void {
  const db = new Database(inboundDbPath('ag-1', 'sess-1'));
  try {
    db.prepare(`INSERT INTO messages_in (id, kind, timestamp, channel_type, content) VALUES (?, ?, ?, ?, ?)`).run(
      `in-${Math.random().toString(36).slice(2, 8)}`,
      opts.kind ?? 'chat-sdk',
      opts.timestamp ?? now(),
      CHANNEL,
      JSON.stringify(content),
    );
  } finally {
    db.close();
  }
}

function humanSays(userId: string, timestamp?: string): void {
  insertInbound({ text: 'please do the thing', author: { userId, fullName: 'Someone', isBot: false } }, { timestamp });
}

async function card(
  overrides: {
    action?: string;
    payload?: Record<string, unknown>;
    platformId?: string;
    threadId?: string | null;
    approver?: string;
    channelType?: string;
    question?: string;
  } = {},
): Promise<string> {
  const approvalId = `appr-${Math.random().toString(36).slice(2, 8)}`;
  await createPendingApproval({
    approval_id: approvalId,
    session_id: session.id,
    agent_group_id: 'ag-1',
    request_id: approvalId,
    action: overrides.action ?? GATE_ACTION,
    payload: JSON.stringify(overrides.payload ?? {}),
    created_at: now(),
    title: 'Run the migration?',
    question: overrides.question ?? 'It drops a column.',
    options_json: '[]',
    channel_type: overrides.channelType ?? CHANNEL,
    platform_id: overrides.platformId ?? WORK_PLATFORM,
    thread_id: overrides.threadId === undefined ? THREAD : overrides.threadId,
    platform_message_id: CARD_TS,
    ...(overrides.approver ? { approver_user_id: overrides.approver } : {}),
  });
  return approvalId;
}

async function dmRow(
  id: string,
  platformId: string,
  userId: string,
  isGroup = 0,
  channelType = CHANNEL,
): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: platformId,
    name: id,
    is_group: isGroup,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({ user_id: userId, channel_type: CHANNEL, messaging_group_id: id, resolved_at: now() });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();

  await getDb().run(`INSERT INTO workgroups (id, display_name, created_at) VALUES ('wg-1', 'Work', ?)`, now());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: now(),
    workgroup_id: 'wg-1',
  });
  await createMessagingGroup({
    id: 'mg-work',
    channel_type: CHANNEL,
    platform_id: WORK_PLATFORM,
    name: 'work',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-work',
    thread_id: THREAD,
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);
  initSessionFolder('ag-1', 'sess-1');

  await upsertUser({ id: REQUESTER, kind: CHANNEL, display_name: 'Riley Requester', created_at: now() });
  await upsertUser({ id: ADMIN, kind: CHANNEL, display_name: 'Avery Admin', created_at: now() });
  await grantRole({ user_id: ADMIN, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  await dmRow('mg-dm-req', 'slack:D0REQ', REQUESTER);
  await dmRow('mg-dm-admin', 'slack:D0ADMIN', ADMIN);

  delivered = [];
  deleted = [];
  const adapter: ChannelDeliveryAdapter = {
    async deliver(channelType, platformId, threadId, _kind, content) {
      const parsed = JSON.parse(content) as Record<string, unknown>;
      delivered.push({ channelType, platformId, threadId, text: parsed.text as string, content: parsed });
      return platformId === QUEUE ? 'pm-queue' : 'pm-dm';
    },
    async deleteMessage(channelType, platformId, _threadId, messageId, instance) {
      deleted.push({ channelType, platformId, messageId, instance });
    },
  };
  setDeliveryAdapter(adapter);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('sendCardPointer', () => {
  it('DMs the requester a copy of the card, records it, then links the original, when they can answer it', async () => {
    humanSays('U0REQ');
    const approvalId = await card();

    expect(await sendCardPointer(approvalId, session)).toBe('copied-requester');

    expect(delivered).toHaveLength(2);
    expect(delivered[0]).toMatchObject({ channelType: CHANNEL, platformId: 'slack:D0REQ', threadId: null });
    expect(delivered[0].content).toEqual({
      type: 'ask_question',
      questionId: approvalId,
      title: 'Run the migration?',
      question: 'It drops a column.',
      options: [],
    });
    expect(delivered[1]).toMatchObject({ platformId: 'slack:D0REQ', threadId: null });
    expect(delivered[1].text).toBe(`This is a copy of ${CARD_LINK}; answering either one closes both.`);
    expect(JSON.parse((await getPendingApproval(approvalId))?.card_copies ?? '[]')).toEqual([
      { channel_type: CHANNEL, platform_id: 'slack:D0REQ', instance: CHANNEL, platform_message_id: 'pm-dm' },
    ]);
  });

  it('names the latest human, not a bot that spoke after them', async () => {
    humanSays('U0REQ', '2026-01-01T00:00:00.000Z');
    insertInbound(
      { text: 'on it', author: { userId: 'sibling-bot', isBot: true } },
      { timestamp: '2026-01-01T00:00:01.000Z' },
    );
    insertInbound(
      { text: 'gate failed', sender: 'system', senderId: 'system' },
      { kind: 'chat', timestamp: '2026-01-01T00:00:02.000Z' },
    );

    expect(await sendCardPointer(await card(), session)).toBe('copied-requester');
    expect(delivered.map((d) => d.platformId)).toEqual(['slack:D0REQ', 'slack:D0REQ']);
  });

  it('copies a card nobody asked for to its answerer, without an "asked" line: only bots and host notes are in the session', async () => {
    insertInbound({ text: 'scheduled run', author: { userId: 'sibling-bot', isBot: true } });
    insertInbound({ text: 'note', sender: 'system', senderId: 'system' }, { kind: 'chat' });
    const approvalId = await card();

    expect(await sendCardPointer(approvalId, session)).toBe('copied-approver');
    expect(delivered.map((d) => d.platformId)).toEqual(['slack:D0ADMIN', 'slack:D0ADMIN']);
    expect(delivered[0].content).toMatchObject({ type: 'ask_question', questionId: approvalId });
    expect(delivered[1].text).toBe(`This is a copy of ${CARD_LINK}; answering either one closes both.`);
  });

  it('sends nothing when nobody asked and the only named approver cannot answer the card', async () => {
    const approvalId = await card({ action: CHOICE_ACTION, payload: { approvers: [REQUESTER] } });

    expect(await sendCardPointer(approvalId, session)).toBe('skipped-no-recipient');
    expect(delivered).toHaveLength(0);
  });

  it('copies a card once: a second pointer for the same card sends nothing', async () => {
    const approvalId = await card();
    expect(await sendCardPointer(approvalId, session)).toBe('copied-approver');

    expect(await sendCardPointer(approvalId, session)).toBe('skipped-already-copied');
    expect(delivered).toHaveLength(2);
  });

  it('DMs an approver the copy instead when the requester cannot answer a choice card', async () => {
    humanSays('U0REQ');
    const approvalId = await card({ action: CHOICE_ACTION });

    expect(await sendCardPointer(approvalId, session)).toBe('copied-approver');

    expect(delivered).toHaveLength(2);
    expect(delivered.map((d) => d.platformId)).toEqual(['slack:D0ADMIN', 'slack:D0ADMIN']);
    expect(delivered[0].content).toMatchObject({ type: 'ask_question', questionId: approvalId });
    expect(delivered[1].text).toBe(
      `This is a copy of ${CARD_LINK}; answering either one closes both.\nRiley Requester asked, and can't answer this card.`,
    );
  });

  it('DMs the requester of a choice card when they hold admin privilege on the group', async () => {
    humanSays('U0ADMIN');

    expect(await sendCardPointer(await card({ action: CHOICE_ACTION }), session)).toBe('copied-requester');
    expect(delivered.map((d) => d.platformId)).toEqual(['slack:D0ADMIN', 'slack:D0ADMIN']);
  });

  it('DMs a named approver when the card narrows its answerers past the requester', async () => {
    humanSays('U0ADMIN');
    const other = `${CHANNEL}:U0OTHER`;
    await upsertUser({ id: other, kind: CHANNEL, display_name: 'Other Admin', created_at: now() });
    await grantRole({ user_id: other, role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
    await dmRow('mg-dm-other', 'slack:D0OTHER', other);

    const approvalId = await card({ action: CHOICE_ACTION, payload: { approvers: [other] } });

    expect(await sendCardPointer(approvalId, session)).toBe('copied-approver');
    expect(delivered.map((d) => d.platformId)).toEqual(['slack:D0OTHER', 'slack:D0OTHER']);
  });

  it('sends nothing when nobody who can answer the card is reachable', async () => {
    humanSays('U0REQ');
    const approvalId = await card({ action: CHOICE_ACTION, payload: { approvers: [`${CHANNEL}:U0GONE`] } });

    expect(await sendCardPointer(approvalId, session)).toBe('skipped-no-recipient');
    expect(delivered).toHaveLength(0);
  });

  it('sends nothing for a card already posted into a DM', async () => {
    humanSays('U0REQ');
    await createMessagingGroup({
      id: 'mg-dm-thread',
      channel_type: CHANNEL,
      platform_id: 'slack:D0CARD',
      name: 'dm',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });

    expect(await sendCardPointer(await card({ platformId: 'slack:D0CARD', threadId: null }), session)).toBe(
      'skipped-card-in-dm',
    );
    expect(delivered).toHaveLength(0);
  });

  it('sends nothing for a card that was answered before the pointer ran', async () => {
    humanSays('U0REQ');
    const approvalId = await card();
    await updatePendingApprovalStatus(approvalId, 'approved');

    expect(await sendCardPointer(approvalId, session)).toBe('skipped-not-pending');
    expect(delivered).toHaveLength(0);
  });

  it('still names the original in words when no link can be built', async () => {
    humanSays('U0REQ');
    const approvalId = await card({ threadId: 'slack:C0WORK:not-a-ts' });

    expect(await sendCardPointer(approvalId, session)).toBe('copied-requester');
    expect(delivered[1].text).toBe('This is a copy of the card in work; answering either one closes both.');
  });

  /** A delivery adapter whose card posts behave as `onCard` says; every other post lands. */
  function cardPostsDo(onCard: () => Promise<string | undefined>): void {
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId, _kind, content) {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        delivered.push({ channelType, platformId, threadId, text: parsed.text as string, content: parsed });
        return parsed.type === 'ask_question' ? onCard() : 'pm-dm';
      },
    });
  }

  it.each([
    ['a Slack DM takes a card longer than Discord shows', 'slack', 2400, 'copied-approver'],
    ['a Slack DM takes a Slack card of any length, as the card itself was posted', 'slack', 2900, 'copied-approver'],
    ['a Discord DM takes a card that fits Discord', 'discord', 1700, 'copied-approver'],
    ['a Discord DM gets the link alone for a card longer than Discord shows', 'discord', 2400, 'sent-approver'],
  ] as const)('%s', async (_name, dmPlatform, questionLength, outcome) => {
    humanSays('U0REQ');
    const approver = dmPlatform === 'slack' ? `${CHANNEL}:U0APPR` : 'discord-example:U0APPR';
    await upsertUser({ id: approver, kind: 'fixture', display_name: 'Ash Approver', created_at: now() });
    await grantRole({ user_id: approver, role: 'admin', agent_group_id: 'ag-1', granted_by: null, granted_at: now() });
    await createMessagingGroup({
      id: 'mg-dm-appr',
      channel_type: dmPlatform === 'slack' ? CHANNEL : 'discord-example',
      platform_id: dmPlatform === 'slack' ? 'slack:D0APPR' : 'discord:@me:D0APPR',
      name: 'mg-dm-appr',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await upsertUserDm({
      user_id: approver,
      channel_type: dmPlatform === 'slack' ? CHANNEL : 'discord-example',
      messaging_group_id: 'mg-dm-appr',
      resolved_at: now(),
    });
    const question = 'q'.repeat(questionLength);
    const approvalId = await card({ action: CHOICE_ACTION, payload: { approvers: [approver] }, question });

    expect(await sendCardPointer(approvalId, session)).toBe(outcome);

    const copies = delivered.filter((d) => d.content.type === 'ask_question');
    expect(copies.map((d) => d.content.question)).toEqual(outcome === 'copied-approver' ? [question] : []);
    expect(delivered.at(-1)?.platformId).toBe(dmPlatform === 'slack' ? 'slack:D0APPR' : 'discord:@me:D0APPR');
    if (outcome === 'sent-approver') {
      expect(delivered.at(-1)?.text).toMatch(/^Your call is needed: Run the migration\? — /);
      expect((await getPendingApproval(approvalId))?.card_copies).toBe('[]');
    }
  });

  it('falls back to the link alone when the copy comes back with no message id, and records nothing', async () => {
    humanSays('U0REQ');
    const approvalId = await card();
    cardPostsDo(async () => undefined);

    expect(await sendCardPointer(approvalId, session)).toBe('sent-requester');
    expect(delivered.map((d) => d.text)).toEqual([undefined, `Your call is needed: Run the migration? — ${CARD_LINK}`]);
    expect((await getPendingApproval(approvalId))?.card_copies).toBe('[]');
  });

  it('falls back to the link alone when the copy fails to post', async () => {
    humanSays('U0REQ');
    const approvalId = await card({ action: CHOICE_ACTION });
    cardPostsDo(async () => {
      throw new Error('blocks rejected');
    });

    expect(await sendCardPointer(approvalId, session)).toBe('sent-approver');
    expect(delivered.at(-1)?.text).toBe(
      `Your call is needed: Run the migration? — ${CARD_LINK}\nRiley Requester asked, and can't answer this card.`,
    );
    expect((await getPendingApproval(approvalId))?.card_copies).toBe('[]');
  });

  it('keeps a posted copy when only the note after it fails to send', async () => {
    humanSays('U0REQ');
    const approvalId = await card();
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        if ((JSON.parse(content) as { type?: string }).type !== 'ask_question') throw new Error('rate limited');
        return 'pm-dm';
      },
    });

    expect(await sendCardPointer(approvalId, session)).toBe('copied-requester');
    expect(JSON.parse((await getPendingApproval(approvalId))?.card_copies ?? '[]')).toHaveLength(1);
  });

  it('still reports the copy when closing a late one fails', async () => {
    humanSays('U0REQ');
    const approvalId = await card();
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        const parsed = JSON.parse(content) as { type?: string; operation?: string };
        if (parsed.operation === 'edit') throw new Error('message deleted');
        if (parsed.type === 'ask_question') await updatePendingApprovalStatus(approvalId, 'approved');
        return 'pm-late';
      },
    });

    expect(await sendCardPointer(approvalId, session)).toBe('copied-requester');
  });

  it('closes a copy that lands after the card was answered, since the answer could not have reached it', async () => {
    humanSays('U0REQ');
    const approvalId = await card();
    cardPostsDo(async () => {
      await updatePendingApprovalStatus(approvalId, 'approved');
      return 'pm-late';
    });

    expect(await sendCardPointer(approvalId, session)).toBe('copied-requester');
    expect(delivered.find((d) => d.content.operation === 'edit')?.content).toEqual({
      operation: 'edit',
      messageId: 'pm-late',
      text: 'Run the migration?\n\nIt drops a column.\n\nNo longer open.',
      clearActions: true,
    });
  });

  it('never throws when the DM delivery fails', async () => {
    humanSays('U0REQ');
    setDeliveryAdapter({
      async deliver() {
        throw new Error('platform down');
      },
    });

    expect(await sendCardPointer(await card(), session)).toBe('failed');
  });
});

describe('sendCardPointer with a workgroup approvals channel', () => {
  const QUEUE_COPY = {
    channel_type: QUEUE_BOT,
    platform_id: QUEUE,
    instance: QUEUE_BOT,
    platform_message_id: 'pm-queue',
    queue: true,
  };

  beforeEach(async () => {
    await setWorkgroupApprovalsChannel('wg-1', { channelType: QUEUE_BOT, platformId: QUEUE });
  });

  async function queuedCard(overrides: Parameters<typeof card>[0] = { action: ADMIN_GATE_ACTION }): Promise<string> {
    const approvalId = await card(overrides);
    expect(await sendCardPointer(approvalId, session)).toBe('queued');
    delivered = [];
    return approvalId;
  }

  function click(approvalId: string, at: { channelType: string; platformId: string; messageId: string }, user: string) {
    return handleApprovalsResponse({ questionId: approvalId, value: 'approve', userId: user, threadId: null, ...at });
  }

  it('posts a card the requester cannot answer once into the channel, as a live card naming where it came from and who asked', async () => {
    humanSays('U0REQ');
    const approvalId = await card({ action: ADMIN_GATE_ACTION });

    expect(await sendCardPointer(approvalId, session)).toBe('queued');

    expect(delivered).toHaveLength(1);
    expect(delivered[0]).toMatchObject({ channelType: QUEUE_BOT, platformId: QUEUE, threadId: null });
    expect(delivered[0].content).toEqual({
      type: 'ask_question',
      questionId: approvalId,
      title: 'Run the migration?',
      question: `It drops a column.\n\nFrom ${CARD_LINK}.\n\nRiley Requester asked, and can't answer this card.`,
      options: [],
    });
    expect(JSON.parse((await getPendingApproval(approvalId))?.card_copies ?? '[]')).toEqual([QUEUE_COPY]);
  });

  it('posts a card nobody asked for into the channel, with no "asked" line', async () => {
    const approvalId = await card();

    expect(await sendCardPointer(approvalId, session)).toBe('queued');
    expect(delivered.map((d) => [d.platformId, d.content.question])).toEqual([
      [QUEUE, `It drops a column.\n\nFrom ${CARD_LINK}.`],
    ]);
  });

  it('keeps the DM copy for a requester who can answer the card', async () => {
    humanSays('U0REQ');

    expect(await sendCardPointer(await card(), session)).toBe('copied-requester');
    expect(delivered.map((d) => d.platformId)).toEqual(['slack:D0REQ', 'slack:D0REQ']);
  });

  it('falls back to the DM copy when the channel post fails, so the card is never stranded', async () => {
    humanSays('U0REQ');
    const approvalId = await card({ action: ADMIN_GATE_ACTION });
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId, _kind, content) {
        if (platformId === QUEUE) throw new Error('not_in_channel');
        const parsed = JSON.parse(content) as Record<string, unknown>;
        delivered.push({ channelType, platformId, threadId, text: parsed.text as string, content: parsed });
        return 'pm-dm';
      },
    });

    expect(await sendCardPointer(approvalId, session)).toBe('copied-approver');
    expect(delivered.map((d) => d.platformId)).toEqual(['slack:D0ADMIN', 'slack:D0ADMIN']);
    expect(JSON.parse((await getPendingApproval(approvalId))?.card_copies ?? '[]')).toEqual([
      { channel_type: CHANNEL, platform_id: 'slack:D0ADMIN', instance: CHANNEL, platform_message_id: 'pm-dm' },
    ]);
  });

  it('posts nothing into the channel for a card nobody can answer', async () => {
    const approvalId = await card({ action: CHOICE_ACTION, payload: { approvers: [REQUESTER] } });

    expect(await sendCardPointer(approvalId, session)).toBe('skipped-no-recipient');
    expect(delivered).toHaveLength(0);
  });

  it.each([
    ['a Slack bot in another team', { channelType: 'slack-elsewhere', platformId: QUEUE }, {}],
    [
      'the same non-Slack bot, which can span tenants',
      { channelType: 'teams-example', platformId: 'teams:queue' },
      { channelType: 'teams-example', platformId: 'teams:work' },
    ],
  ])('never posts into a channel the card may not share a tenant with: %s', async (_case, channel, at) => {
    await getDb().run(`UPDATE workgroups SET approvals_channel = ? WHERE id = 'wg-1'`, JSON.stringify(channel));

    expect(await sendCardPointer(await card({ action: ADMIN_GATE_ACTION, ...at }), session)).toBe('copied-approver');
    expect(delivered.map((d) => d.platformId)).toEqual(['slack:D0ADMIN', 'slack:D0ADMIN']);
  });

  it.each([
    [
      'an answer on the original card',
      (id: string) => click(id, { channelType: CHANNEL, platformId: WORK_PLATFORM, messageId: CARD_TS }, 'U0ADMIN'),
    ],
    [
      'an answer on the channel copy, posted by another bot than the card',
      (id: string) => click(id, { channelType: QUEUE_BOT, platformId: QUEUE, messageId: 'pm-queue' }, 'U0ADMIN'),
    ],
    [
      'expiry',
      async (id: string) => {
        const approval = await getPendingApproval(id);
        expect(await retireChoice(approval!, 'Expired')).toBe(true);
      },
    ],
  ])('deletes the channel copy on %s, and closes the original in place', async (_path, resolve) => {
    const approvalId = await queuedCard();

    await resolve(approvalId);

    expect(await getPendingApproval(approvalId)).toBeUndefined();
    expect(deleted).toEqual([
      { channelType: QUEUE_BOT, platformId: QUEUE, messageId: 'pm-queue', instance: QUEUE_BOT },
    ]);
    expect(
      delivered.filter((d) => d.content.operation === 'edit').map((d) => [d.platformId, d.content.messageId]),
    ).toEqual([[WORK_PLATFORM, CARD_TS]]);
  });

  it('closes the channel copy in place when it cannot be deleted', async () => {
    const approvalId = await queuedCard();
    setDeliveryAdapter({
      async deliver(channelType, platformId, threadId, _kind, content) {
        const parsed = JSON.parse(content) as Record<string, unknown>;
        delivered.push({ channelType, platformId, threadId, text: parsed.text as string, content: parsed });
        return 'pm-x';
      },
      async deleteMessage() {
        throw new Error('cant_delete_message');
      },
    });

    await click(approvalId, { channelType: CHANNEL, platformId: WORK_PLATFORM, messageId: CARD_TS }, 'U0ADMIN');

    const edits = delivered.filter((d) => d.content.operation === 'edit');
    expect(edits.map((d) => [d.channelType, d.platformId, d.content.messageId, d.content.clearActions])).toEqual([
      [CHANNEL, WORK_PLATFORM, CARD_TS, true],
      [QUEUE_BOT, QUEUE, 'pm-queue', true],
    ]);
  });

  it('deletes a channel copy that lands after the card was answered', async () => {
    const approvalId = await card({ action: ADMIN_GATE_ACTION });
    setDeliveryAdapter({
      async deliver() {
        await updatePendingApprovalStatus(approvalId, 'approved');
        return 'pm-queue';
      },
      async deleteMessage(channelType, platformId, _threadId, messageId, instance) {
        deleted.push({ channelType, platformId, messageId, instance });
      },
    });

    expect(await sendCardPointer(approvalId, session)).toBe('queued');
    expect(deleted).toEqual([
      { channelType: QUEUE_BOT, platformId: QUEUE, messageId: 'pm-queue', instance: QUEUE_BOT },
    ]);
  });

  it("asks for a reject's reason in the clicker's DM on the channel's bot, even when they never messaged that bot", async () => {
    const approvalId = await queuedCard();

    await handleApprovalsResponse({
      questionId: approvalId,
      value: REJECT_WITH_REASON_VALUE,
      userId: 'U0ADMIN',
      channelType: QUEUE_BOT,
      platformId: QUEUE,
      threadId: null,
      messageId: 'pm-queue',
    });

    expect((await getPendingApproval(approvalId))?.status).toBe('awaiting_reason');
    expect(delivered.map((d) => [d.channelType, d.platformId])).toEqual([
      [QUEUE_BOT, 'U0ADMIN'],
      [CHANNEL, WORK_PLATFORM],
    ]);
  });

  it("keeps the DM copy when nobody who can answer the card can answer through the channel's bot", async () => {
    const far = 'slack-elsewhere:U0FAR';
    await upsertUser({ id: far, kind: 'slack-elsewhere', display_name: 'Far Owner', created_at: now() });

    expect(await sendCardPointer(await card({ approver: far }), session)).toBe('copied-approver');
    expect(delivered.map((d) => [d.channelType, d.platformId])).toEqual([
      ['slack-elsewhere', 'U0FAR'],
      ['slack-elsewhere', 'U0FAR'],
    ]);
  });

  it("names the person, not the channel bot's id, on the card they answered from the channel", async () => {
    const approvalId = await queuedCard();

    await click(approvalId, { channelType: QUEUE_BOT, platformId: QUEUE, messageId: 'pm-queue' }, 'U0ADMIN');

    const original = delivered.find((d) => d.platformId === WORK_PLATFORM && d.content.operation === 'edit');
    expect(original?.text).toBe('Run the migration?\n\nIt drops a column.\n\napprove — Avery Admin');
  });

  it('refuses a channel click from someone who could answer only from the thread', async () => {
    const approvalId = await queuedCard({});

    await click(approvalId, { channelType: QUEUE_BOT, platformId: QUEUE, messageId: 'pm-queue' }, 'U0REQ');

    expect((await getPendingApproval(approvalId))?.status).toBe('pending');
    expect(deleted).toHaveLength(0);
  });

  it('lets a named approver answer the channel copy through the channel bot', async () => {
    const approvalId = await queuedCard({ approver: ADMIN });

    await click(approvalId, { channelType: QUEUE_BOT, platformId: QUEUE, messageId: 'pm-queue' }, 'U0ADMIN');

    expect(await getPendingApproval(approvalId)).toBeUndefined();
  });
});
