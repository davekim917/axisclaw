import fs from 'fs';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('nc-open-asks') }));

vi.mock('../../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../config.js')>()),
  DATA_DIR: TEST_DIR,
}));

import { closeDb, createAgentGroup, getDb, initMigratedTestDb } from '../../db/index.js';
import { __resetArchiveConnectionForTest, archiveMessage } from '../../message-archive.js';
import { setSiblingBotIdsProvider } from '../permissions/index.js';
import {
  leadingAddressees,
  outcomeAskText,
  planAlerts,
  UNANSWERED_REMINDER_MS,
  UNCLAIMED_ALERT_MS,
  type Ask,
  type AskMark,
} from './asks.js';
import { runBackstop, type BackstopDeps } from './index.js';
import { claimWorkOutcome, settleWorkOutcome } from '../../db/work-outcome-receipts.js';
import { flagNeedsInput } from '../orchestrator-dispatch/db/tasks.js';
import { getMarks, listAsks, resolveAsk } from './store.js';

afterAll(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

const NOW = Date.parse('2026-06-10T12:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const HOUR = 3_600_000;

describe('outcomeAskText', () => {
  it.each([
    ['Approve the draft, then send it', 'Approve the draft, then send it'],
    ['  Say merge  ', 'Say merge'],
    ['No action needed.', null],
    ['no action is needed', null],
    ['nothing', null],
    ['Nothing.', null],
    ['nothing for now', null],
    ['None', null],
    ['n/a', null],
    ['Nothing ships until you pick a window', 'Nothing ships until you pick a window'],
    ['', null],
    [42, null],
    [undefined, null],
  ])('%j → %j', (input, expected) => {
    expect(outcomeAskText(input)).toBe(expected);
  });
});

describe('leadingAddressees', () => {
  const people = new Set(['Avery', 'Jordan']);
  it.each([
    ['Avery: OK the prod token', ['Avery']],
    ['Jordan or Avery: approve the fix', ['Jordan', 'Avery']],
    ['Avery/Jordan, decide the window', ['Avery', 'Jordan']],
    ['Avery, before 04:00 tomorrow: pick one', ['Avery']],
    ['Optional: add a test', []],
    ['Approve the draft', []],
  ])('%j → %j', (text, expected) => {
    expect(leadingAddressees(text, people)).toEqual(expected);
  });
});

function ask(id: string, askedAgoMs: number, forOperator = true): Ask {
  return {
    id,
    cause: 'outcome',
    workgroupId: 'wg-alpha',
    agentGroupId: 'ag-alpha',
    sessionId: 'sess-1',
    threadId: null,
    askedAt: iso(-askedAgoMs),
    text: 'Approve the draft',
    forOperator,
  };
}

function mark(id: string, fields: Partial<AskMark>): AskMark {
  return {
    ask_id: id,
    claimed_by: null,
    claimed_at: null,
    resolved_by: null,
    resolved_at: null,
    resolution: null,
    alerted_at: null,
    reminded_at: null,
    ...fields,
  };
}

describe('planAlerts', () => {
  const since = NOW - 30 * 24 * HOUR;
  const plan = (asks: Ask[], marks: AskMark[] = [], sinceMs = since) => {
    const p = planAlerts(asks, new Map(marks.map((m) => [m.ask_id, m])), NOW, sinceMs);
    return { alert: p.alert.map((a) => a.id), remind: p.remind.map((a) => a.id) };
  };

  it('alerts an unclaimed operator ask once it passes 2h, not before', () => {
    expect(plan([ask('young', UNCLAIMED_ALERT_MS - 60_000), ask('due', UNCLAIMED_ALERT_MS + 60_000)])).toEqual({
      alert: ['due'],
      remind: [],
    });
  });

  it.each([
    ['claimed by an Anderton', [mark('a', { claimed_at: iso(-HOUR) })]],
    ['already alerted', [mark('a', { alerted_at: iso(-HOUR) })]],
    ['resolved elsewhere', [mark('a', { resolved_at: iso(-HOUR) })]],
  ])('does not alert an ask %s', (_label, marks) => {
    expect(plan([ask('a', 3 * HOUR)], marks)).toEqual({ alert: [], remind: [] });
  });

  it('never alerts an ask addressed to someone other than an operator', () => {
    expect(plan([ask('a', 30 * HOUR, false)])).toEqual({ alert: [], remind: [] });
  });

  it('does not alert asks raised before the backstop existed', () => {
    expect(plan([ask('a', 3 * HOUR)], [], NOW - 2 * HOUR)).toEqual({ alert: [], remind: [] });
  });

  it('reminds once at a day, claimed or not, and never again', () => {
    const old = UNANSWERED_REMINDER_MS + HOUR;
    expect(plan([ask('a', old)], [mark('a', { claimed_at: iso(-old) })])).toEqual({ alert: [], remind: ['a'] });
    expect(plan([ask('a', old)], [mark('a', { reminded_at: iso(-HOUR) })])).toEqual({ alert: [], remind: [] });
  });
});

describe('runBackstop', () => {
  function deps(notify: boolean): BackstopDeps & { sent: string[]; stamped: string[][] } {
    const sent: string[] = [];
    const stamped: string[][] = [];
    return {
      sent,
      stamped,
      now: () => NOW,
      listAsks: async () => [ask('due', 3 * HOUR)],
      getMarks: async () => new Map(),
      sinceMs: async () => NOW - 24 * HOUR,
      describe: async (a) => `• ${a.text} (${a.id})`,
      notify: async (text) => {
        sent.push(text);
        return notify;
      },
      stamp: async (ids, column) => {
        stamped.push([column, ...ids]);
      },
    };
  }

  it('stamps an alert only after a human was reached, so a failed delivery is retried next tick', async () => {
    const failed = deps(false);
    expect(await runBackstop(failed)).toEqual({ alerted: 0, reminded: 0 });
    expect(failed.sent).toHaveLength(1);
    expect(failed.stamped).toEqual([]);

    const delivered = deps(true);
    expect(await runBackstop(delivered)).toEqual({ alerted: 1, reminded: 0 });
    expect(delivered.sent[0]).toContain('Approve the draft (due)');
    expect(delivered.stamped).toEqual([['alerted_at', 'due']]);
  });

  it('does nothing before the marks migration has run', async () => {
    const d = { ...deps(true), sinceMs: async () => null };
    expect(await runBackstop(d)).toEqual({ alerted: 0, reminded: 0 });
    expect(d.sent).toEqual([]);
  });
});

describe('listAsks', () => {
  const ROOM = 'discord:guild-1:chan-1';
  const THREAD = `${ROOM}:thread-1`;

  beforeEach(async () => {
    await closeDb();
    __resetArchiveConnectionForTest();
    fs.rmSync(TEST_DIR, { recursive: true, force: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await initMigratedTestDb();
    setSiblingBotIdsProvider(() => new Set(['bot-agent']));
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    const db = getDb();
    await db.run(
      `INSERT INTO workgroups (id, display_name, created_at) VALUES ('wg-alpha', 'Alpha', ?)`,
      iso(-48 * HOUR),
    );
    for (const id of ['ag-alpha', 'ag-beta']) {
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: iso(-48 * HOUR) });
      await db.run(`UPDATE agent_groups SET workgroup_id = 'wg-alpha' WHERE id = ?`, id);
    }
    // Two agents wired to one room, each through its own channel type, as sibling bots are.
    for (const [id, channelType] of [
      ['mg-1', 'discord'],
      ['mg-2', 'discord-sibling'],
    ]) {
      await db.run(
        `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, created_at) VALUES (?, ?, ?, ?, ?)`,
        id,
        channelType,
        ROOM,
        channelType,
        iso(-48 * HOUR),
      );
    }
    for (const [id, name] of [
      ['discord:user-owner', 'Avery Lee'],
      ['discord:user-colleague', 'Jordan Park'],
    ]) {
      await db.run(
        `INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'human', ?, ?)`,
        id,
        name,
        iso(-48 * HOUR),
      );
    }
    await db.run(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_at) VALUES ('discord:user-owner', 'owner', NULL, ?)`,
      iso(-48 * HOUR),
    );
    await session('sess-1', 'ag-alpha', 'mg-1', THREAD);
  });

  async function session(id: string, agentGroupId: string, messagingGroupId: string, threadId: string): Promise<void> {
    await getDb().run(
      `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, created_at)
       VALUES (?, ?, ?, ?, 'active', ?)`,
      id,
      agentGroupId,
      messagingGroupId,
      threadId,
      iso(-24 * HOUR),
    );
  }

  let archived = 0;
  /** A message as the archive records it: every agent wired to the room keeps its own copy. */
  function said(
    senderId: string,
    atMs: number,
    where: { threadId?: string | null; channelType?: string; role?: 'user' | 'assistant'; isBot?: boolean } = {},
  ): void {
    archiveMessage(
      {
        id: `arch-${++archived}`,
        agentGroupId: 'ag-alpha',
        messagingGroupId: null,
        channelType: where.channelType ?? 'discord',
        channelName: null,
        platformId: ROOM,
        threadId: where.threadId === undefined ? THREAD : where.threadId,
        role: where.role ?? 'user',
        senderId: `discord:${senderId}`,
        senderName: senderId,
        senderIsBot: where.isBot,
        text: 'a message',
        sentAt: new Date(atMs).toISOString(),
      },
      { workgroupId: null },
    );
  }

  async function receipt(
    messageId: string,
    needsYou: string,
    atMs: number,
    where: { threadId: string | null; postId?: string } = { threadId: THREAD },
  ): Promise<void> {
    await getDb().run(
      `INSERT INTO work_outcome_receipts (workgroup_id, work_item, message_id, session_id, state, platform_message_id,
         channel_type, platform_id, thread_id, content, created_at, updated_at)
       VALUES ('wg-alpha', ?, ?, 'sess-1', 'delivered', ?, 'discord', 'discord:guild-1:chan-1', ?, ?, ?, ?)`,
      `request:v1:${messageId}`,
      messageId,
      where.postId ?? null,
      where.threadId,
      JSON.stringify({ reporting: { outcome: { needsYou } } }),
      new Date(atMs).toISOString(),
      new Date(atMs).toISOString(),
    );
  }

  it.each([
    ['a person', 'user-owner', 'user', false, []],
    ['one of our bots', 'bot-agent', 'user', undefined, ['outcome:msg-8']],
    ['a bot the platform flagged', 'ci-bot', 'user', true, ['outcome:msg-8']],
    ["the agent's own post", 'user-owner', 'assistant', undefined, ['outcome:msg-8']],
  ] as const)(
    'closes an ask on a reply from %s only if a person wrote it',
    async (_label, sender, role, isBot, open) => {
      await receipt('msg-8', 'Say merge', NOW - 4 * HOUR);
      said(sender, NOW - HOUR, { role, isBot });
      expect((await listAsks({ nowMs: NOW })).map((a) => a.id)).toEqual(open);
    },
  );

  it('keeps an ask for the operator who wrote before one of our bots did', async () => {
    said('user-owner', NOW - 6 * HOUR);
    said('bot-agent', NOW - 5 * HOUR);
    await receipt('msg-7', 'Pick a window', NOW - 4 * HOUR);
    expect((await listAsks({ nowMs: NOW })).map((a) => [a.id, a.forOperator])).toEqual([['outcome:msg-7', true]]);
  });

  it('keeps an answered ask closed however much bot traffic follows the answer', async () => {
    await receipt('msg-5', 'Say merge', NOW - 4 * HOUR);
    said('user-owner', NOW - 3 * HOUR);
    for (let i = 0; i < 250; i++) said('bot-agent', NOW - 2 * HOUR + i);
    expect(await listAsks({ nowMs: NOW })).toEqual([]);
  });

  it('closes an ask posted at channel root when a person replies in the thread under it, though no agent woke', async () => {
    const replyThread = `${ROOM}:post-9`;
    await receipt('msg-6', 'Say merge', NOW - 4 * HOUR, { threadId: null, postId: 'post-9' });

    expect((await listAsks({ nowMs: NOW })).map((a) => [a.id, a.threadId])).toEqual([['outcome:msg-6', replyThread]]);
    said('user-owner', NOW - HOUR, { threadId: replyThread, channelType: 'discord-sibling' });
    expect(await listAsks({ nowMs: NOW })).toEqual([]);
  });

  it('lists an outcome ask addressed to the owner, and drops it when a person replies through any agent in the room', async () => {
    said('user-owner', NOW - 5 * HOUR);
    await receipt('msg-1', 'Say merge', NOW - 4 * HOUR);

    const open = await listAsks({ nowMs: NOW });
    expect(open.map((a) => [a.id, a.forOperator, a.text])).toEqual([['outcome:msg-1', true, 'Say merge']]);

    // A mark never closes an ask; only a reply does.
    await resolveAsk('outcome:msg-1', 'decided in a DM', 'test', iso(-2 * HOUR));
    expect((await listAsks({ nowMs: NOW })).map((a) => a.id)).toEqual(['outcome:msg-1']);

    said('user-someone', NOW - HOUR, { channelType: 'discord-sibling' });
    expect(await listAsks({ nowMs: NOW })).toEqual([]);
  });

  it('dates an outcome ask from its delivery, not a failed first attempt', async () => {
    const outcome = {
      workgroup_id: 'wg-alpha',
      work_item: 'request:v1:msg-9',
      message_id: 'msg-9',
      session_id: 'sess-1',
      channel_type: 'discord',
      platform_id: ROOM,
      thread_id: THREAD,
      content: JSON.stringify({ reporting: { outcome: { needsYou: 'Say merge' } } }),
    };
    vi.setSystemTime(NOW - 6 * HOUR);
    await claimWorkOutcome(outcome);
    await settleWorkOutcome('wg-alpha', outcome.work_item, undefined, 'adapter timeout');
    await getDb().run(`UPDATE work_outcome_receipts SET state = 'retry'`);
    said('user-owner', NOW - 5 * HOUR);
    vi.setSystemTime(NOW - 4 * HOUR);
    expect((await claimWorkOutcome(outcome)).claimed).toBe(true);
    await settleWorkOutcome('wg-alpha', outcome.work_item, 'post-9');
    vi.setSystemTime(NOW);

    expect((await listAsks({ nowMs: NOW })).map((a) => [a.id, a.askedAt, a.forOperator])).toEqual([
      ['outcome:msg-9', iso(-4 * HOUR), true],
    ]);
  });

  it('lets the names an ask opens with decide who it is for', async () => {
    said('user-colleague', NOW - 5 * HOUR);
    await receipt('msg-3', 'Avery: OK the prod token', NOW - 4 * HOUR);
    await receipt('msg-4', 'Jordan: update the tour copy', NOW - 3 * HOUR);

    const asks = await listAsks({ nowMs: NOW });
    expect(asks.map((a) => [a.id, a.forOperator])).toEqual([
      ['outcome:msg-3', true],
      ['outcome:msg-4', false],
    ]);
  });

  it('dates a task ask from when it asked, and addresses it to whoever asked for the task', async () => {
    await session('sess-parent', 'ag-alpha', 'mg-1', `${ROOM}:thread-2`);
    await session('sess-child', 'ag-beta', 'mg-2', `${ROOM}:thread-3`);
    said('user-owner', NOW - 12 * HOUR, { threadId: `${ROOM}:thread-2` });
    said('user-colleague', NOW - 11 * HOUR, { threadId: `${ROOM}:thread-3` });
    await getDb().run(
      `INSERT INTO tasks (task_id, idempotency_key, parent_session_id, parent_agent_group_id, child_session_id, status,
         task_content, request_hash, admitted_at, last_progress_at, created_at)
       VALUES ('task-1', 'k1', 'sess-parent', 'ag-alpha', 'sess-child', 'running', 'content', 'hash1', ?, ?, ?)`,
      iso(-12 * HOUR),
      iso(-11 * HOUR),
      iso(-12 * HOUR),
    );
    vi.setSystemTime(NOW - 30 * 60_000);
    expect(await flagNeedsInput('task-1', 'Repo path A or B?')).toBe(true);
    vi.setSystemTime(NOW);

    const asks = await listAsks({ nowMs: NOW });
    const first = `task:task-1:${NOW - 30 * 60_000}`;
    expect(asks.map((a) => [a.id, a.askedAt, a.forOperator, a.text])).toEqual([
      [first, iso(-30 * 60_000), true, 'Repo path A or B?'],
    ]);

    // A later question from the same task is a new ask: the first one's resolution must not hide it.
    await resolveAsk(first, 'answered in a DM', 'test', iso(-20 * 60_000));
    vi.setSystemTime(NOW - 10 * 60_000);
    expect(await flagNeedsInput('task-1', 'Branch X or Y?')).toBe(true);
    vi.setSystemTime(NOW);
    const [second] = await listAsks({ nowMs: NOW });
    expect(second).toMatchObject({ id: `task:task-1:${NOW - 10 * 60_000}`, text: 'Branch X or Y?' });
    expect((await getMarks([second.id])).size).toBe(0);
  });

  it('marks an ask answering someone else as not for the operator', async () => {
    said('user-owner', NOW - 9 * HOUR);
    said('user-colleague', NOW - 5 * HOUR);
    await receipt('msg-2', 'Turn email on?', NOW - 4 * HOUR);

    const [only] = await listAsks({ nowMs: NOW });
    expect(only).toMatchObject({ id: 'outcome:msg-2', forOperator: false });
  });
});
