import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups`, TASK_LIST_ENABLED: false };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-open-thread-delivery') }));

import { dispatch } from './cli/dispatch.js';
import { getDb } from './db/connection.js';
import { closeDb, createAgentGroup, initMigratedTestDb } from './db/index.js';
import { createMessagingGroup, createMessagingGroupAgent } from './db/messaging-groups.js';
import { getSession, taskSeriesId, taskThreadId } from './db/sessions.js';
import { getTaskThreadAnchor } from './db/task-thread-anchors.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { startThreadTask } from './open-thread.js';
import { renderWorkOutcome } from './outcome-reporting-schema.js';
import { admitDueTaskContexts, withExistingMailboxSession } from './session-manager.js';
import type { Session } from './types.js';
import './cli/resources/tasks.js';

const at = '2026-06-01T00:00:00.000Z';

async function wireRoom(id: string, channelType: string, platformId: string): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: platformId,
    name: `#${id}`,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: at,
  });
  await createMessagingGroupAgent({
    id: `w-${id}`,
    messaging_group_id: id,
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    default_model: null,
    default_effort: null,
    default_tone: null,
    instructions_profile: null,
    created_at: at,
  });
}

async function seedWiredRoom(channelType: string, platformId: string): Promise<void> {
  await createAgentGroup({ id: 'ag-1', name: 'ava', folder: 'ava', agent_provider: null, created_at: at });
  await wireRoom('mg-1', channelType, platformId);
}

async function taskSession(seriesId: string): Promise<Session> {
  const row = await getDb().get<{ id: string }>('SELECT id FROM sessions WHERE thread_id = ?', taskThreadId(seriesId));
  const session = row ? await getSession(row.id) : undefined;
  if (!session) throw new Error('task session not created');
  return session;
}

async function startTaskInThread(threadId: string): Promise<Session> {
  const started = await startThreadTask({
    agentGroupId: 'ag-1',
    messagingGroupId: 'mg-1',
    threadId,
    name: 'thread nightly export check',
    prompt: 'Work it in THIS thread.',
  });
  if (!started.ok || !started.seriesId) throw new Error(`task not started: ${JSON.stringify(started)}`);
  return taskSession(started.seriesId);
}

async function startTaskInChannel(extra: Record<string, unknown> = {}): Promise<Session> {
  const res = await dispatch(
    {
      id: 'create-1',
      command: 'tasks-create',
      args: {
        group: 'ag-1',
        name: 'channel report',
        prompt: 'Report.',
        process_after: new Date().toISOString(),
        messaging_group: 'mg-1',
        ...extra,
      },
    },
    { caller: 'host' },
  );
  if (!res.ok) throw new Error(`task not created: ${JSON.stringify(res)}`);
  return taskSession((res.data as { series_id: string }).series_id);
}

/**
 * The shape the runner writes when the row it answers carries no thread (a steer, a memory warning) or its reply
 * route aged out: the channel, and no thread.
 */
function writeThreadlessPost(
  session: Session,
  id: string,
  channelType: string,
  platformId: string,
  content: Record<string, unknown> = { text: id },
): void {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, thread_id, in_reply_to, content)
     VALUES (?, ?, 'chat', ?, ?, NULL, 'steer-1', ?)`,
  ).run(id, new Date().toISOString(), platformId, channelType, JSON.stringify(content));
  db.close();
}

/** The series' due row, admitted as a turn. */
async function admitTask(session: Session): Promise<{ id: string; seq: number }> {
  const admitted = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    admitDueTaskContexts(mailbox, session.agent_group_id, session.id),
  );
  if (admitted !== 1) throw new Error(`task row not admitted: ${admitted}`);
  const inbound = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const task = inbound.prepare("SELECT id, seq FROM messages_in WHERE kind = 'task' AND trigger = 1").get() as {
    id: string;
    seq: number;
  };
  inbound.close();
  return task;
}

/** An outcome-purpose post answering the admitted task row, as the runner writes it. */
function writeTaskOutcome(
  session: Session,
  task: { id: string; seq: number },
  id: string,
  channelType: string,
  platformId: string,
): string {
  const summary = 'The export check is done.';
  const outcome = { requestId: task.seq, verified: 'Row counts matched.' };
  const { key, text } = renderWorkOutcome(summary, outcome, {
    sessionId: session.id,
    messageId: task.id,
    sequence: task.seq,
  });
  writeThreadlessPost(session, id, channelType, platformId, {
    text,
    reporting: { version: 1, purpose: 'outcome', summary, outcome },
  });
  return key;
}

function recordDeliveries(): Array<{ platformId: string; threadId: string | null }> {
  const calls: Array<{ platformId: string; threadId: string | null }> = [];
  let n = 0;
  setDeliveryAdapter({
    async deliver(_channelType, platformId, threadId) {
      calls.push({ platformId, threadId });
      return `posted-${++n}`;
    },
  });
  return calls;
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

const SHAPES = [
  {
    platform: 'slack',
    channelType: 'slack',
    platformId: 'slack:C0EXAMPLE1',
    threadId: 'slack:C0EXAMPLE1:1712999999.000100',
  },
  {
    platform: 'discord',
    channelType: 'discord',
    platformId: 'discord:111:222',
    threadId: 'discord:111:222:333',
  },
];

describe.each(SHAPES)('a task started in an opened $platform thread', ({ channelType, platformId, threadId }) => {
  it('delivers its threadless posts into that thread and writes no anchor', async () => {
    await seedWiredRoom(channelType, platformId);
    const session = await startTaskInThread(threadId);
    const calls = recordDeliveries();

    writeThreadlessPost(session, 'out-1', channelType, platformId);
    await deliverSessionMessages(session);
    writeThreadlessPost(session, 'out-2', channelType, platformId);
    await deliverSessionMessages(session);

    expect(calls).toEqual([
      { platformId, threadId },
      { platformId, threadId },
    ]);
    expect(await getTaskThreadAnchor(session.id, channelType, platformId)).toBeNull();
  });
});

describe.each(SHAPES)(
  'the outcome of a task started in an opened $platform thread',
  ({ channelType, platformId, threadId }) => {
    it('lands in that thread and writes no anchor', async () => {
      await seedWiredRoom(channelType, platformId);
      const session = await startTaskInThread(threadId);
      const calls = recordDeliveries();

      writeTaskOutcome(session, await admitTask(session), 'outcome-1', channelType, platformId);
      await deliverSessionMessages(session);

      expect(calls).toEqual([{ platformId, threadId }]);
      expect(await getTaskThreadAnchor(session.id, channelType, platformId)).toBeNull();
    });
  },
);

describe('the outcome of a recurring task stamped with a thread', () => {
  it('posts at the channel root, not in the thread the series was created in', async () => {
    const { channelType, platformId, threadId } = SHAPES[0]!;
    await seedWiredRoom(channelType, platformId);
    const session = await startTaskInChannel({ thread_id: threadId, recurrence: '0 9 * * *' });
    const calls = recordDeliveries();

    writeTaskOutcome(session, await admitTask(session), 'outcome-1', channelType, platformId);
    await deliverSessionMessages(session);

    expect(calls).toEqual([{ platformId, threadId: null }]);
    expect(await getTaskThreadAnchor(session.id, channelType, platformId)).toBeNull();
  });
});

describe.each([
  { change: 'gains a recurrence', created: {}, recurrence: '0 9 * * *', outcomeInThread: false },
  { change: 'loses its recurrence', created: { recurrence: '0 9 * * *' }, recurrence: null, outcomeInThread: true },
])(
  'the outcome of a thread-stamped task that $change after its route was read',
  ({ created, recurrence, outcomeInThread }) => {
    it('follows the series as it is now', async () => {
      const { channelType, platformId, threadId } = SHAPES[0]!;
      await seedWiredRoom(channelType, platformId);
      const session = await startTaskInChannel({ thread_id: threadId, ...created });
      const calls = recordDeliveries();
      writeThreadlessPost(session, 'out-1', channelType, platformId);
      await deliverSessionMessages(session);

      const updated = await dispatch(
        {
          id: 'update-1',
          command: 'tasks-update',
          args: {
            id: taskSeriesId(session.thread_id),
            group: 'ag-1',
            recurrence,
            process_after: new Date().toISOString(),
          },
        },
        { caller: 'host' },
      );
      expect(updated.ok).toBe(true);
      const task = await admitTask(session);
      writeTaskOutcome(session, task, 'outcome-1', channelType, platformId);
      await deliverSessionMessages(session);

      expect(calls).toEqual([
        { platformId, threadId },
        { platformId, threadId: outcomeInThread ? threadId : null },
      ]);
    });
  },
);

describe('an outcome retried after its recurring series was cancelled', () => {
  it('records the thread the retry posted in on its receipt', async () => {
    const { channelType, platformId, threadId } = SHAPES[0]!;
    await seedWiredRoom(channelType, platformId);
    const session = await startTaskInChannel({ thread_id: threadId, recurrence: '0 9 * * *' });
    const key = writeTaskOutcome(session, await admitTask(session), 'outcome-1', channelType, platformId);
    const calls: Array<string | null> = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, threadId) {
        calls.push(threadId);
        if (calls.length === 1) throw new Error('socket disconnected');
        return 'posted-retry';
      },
    });
    await deliverSessionMessages(session);

    const seriesId = taskSeriesId(session.thread_id)!;
    // The state `scripts/outcome-receipts.ts confirm-not-sent` leaves; that script needs a raw handle this test lacks.
    const confirmed = await getDb().run("UPDATE work_outcome_receipts SET state = 'retry' WHERE work_item = ?", key);
    expect(confirmed.changes).toBe(1);
    const cancelled = await dispatch(
      { id: 'cancel-1', command: 'tasks-cancel', args: { id: seriesId, group: 'ag-1' } },
      { caller: 'host' },
    );
    expect(cancelled.ok).toBe(true);
    await deliverSessionMessages(session);

    expect(calls).toEqual([null, threadId]);
    expect(await getDb().get('SELECT state, thread_id FROM work_outcome_receipts')).toEqual({
      state: 'delivered',
      thread_id: threadId,
    });
  });
});

describe('a task stamped with a channel and no thread', () => {
  it('still opens a rolling thread at the channel root', async () => {
    const { channelType, platformId } = SHAPES[0]!;
    await seedWiredRoom(channelType, platformId);
    const session = await startTaskInChannel();
    const calls = recordDeliveries();

    writeThreadlessPost(session, 'out-1', channelType, platformId);
    await deliverSessionMessages(session);
    writeThreadlessPost(session, 'out-2', channelType, platformId);
    await deliverSessionMessages(session);

    expect(calls).toEqual([
      { platformId, threadId: null },
      { platformId, threadId: `${platformId}:posted-1` },
    ]);
    expect((await getTaskThreadAnchor(session.id, channelType, platformId))?.threadPlatformId).toBe('posted-1');
  });
});

describe('a task started in an opened thread, posting elsewhere', () => {
  const { channelType, platformId, threadId } = SHAPES[0]!;

  it('does not carry the thread into another room', async () => {
    await seedWiredRoom(channelType, platformId);
    await wireRoom('mg-2', channelType, 'slack:C0EXAMPLE2');
    const session = await startTaskInThread(threadId);
    const calls = recordDeliveries();

    writeThreadlessPost(session, 'out-1', channelType, 'slack:C0EXAMPLE2');
    await deliverSessionMessages(session);

    expect(calls).toEqual([{ platformId: 'slack:C0EXAMPLE2', threadId: null }]);
  });

  it('leaves a keyed post to its key', async () => {
    await seedWiredRoom(channelType, platformId);
    const session = await startTaskInThread(threadId);
    const calls = recordDeliveries();

    writeThreadlessPost(session, 'out-1', channelType, platformId, { text: 'item', threadKey: 'item-1' });
    await deliverSessionMessages(session);

    expect(calls).toEqual([{ platformId, threadId: null }]);
  });
});

describe('an edit from a task started in an opened thread', () => {
  const { channelType, platformId, threadId } = SHAPES[1]!;

  it('reaches a root post the thread does not hold', async () => {
    await seedWiredRoom(channelType, platformId);
    const session = await startTaskInThread(threadId);
    const calls: Array<{ threadId: string | null }> = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, threadId) {
        calls.push({ threadId });
        if (threadId !== null) throw new Error('Unknown Message');
        return 'root-1';
      },
    });

    writeThreadlessPost(session, 'edit-1', channelType, platformId, {
      operation: 'edit',
      messageId: 'root-1',
      text: 'corrected',
    });
    await deliverSessionMessages(session);

    expect(calls).toEqual([{ threadId }, { threadId: null }]);
  });
});
