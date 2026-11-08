import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return {
    ...actual,
    DATA_DIR: TEST_DIR,
    GROUPS_DIR: `${TEST_DIR}/groups`,
    TIMEZONE: 'UTC',
  };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-slack-subject') }));

// Records the options the gate threads through while leaving the read itself
// real — every other case in this file runs against genuine session DBs.
const readOptions = vi.hoisted(() => ({ last: undefined as unknown }));
vi.mock('../mailbox/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../mailbox/index.js')>();
  return {
    ...actual,
    readSessionInbound: ((location: never, action: never, options?: never) => {
      readOptions.last = options;
      return actual.readSessionInbound(location, action, options);
    }) as typeof actual.readSessionInbound,
  };
});

import { closeDb, createAgentGroup, initMigratedTestDb } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, taskThreadId, TASKS_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import { initSessionFolder } from '../../session-manager.js';
import { openInboundDb } from '../../modules/mailbox/openers.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { Session } from '../../types.js';
import { resolveSlackSafetyMessagingGroupId } from './task-slack-subject.js';

const NOW = '2026-08-19T00:00:00.000Z';
const GROUP = 'ag-qz';
const DM_PLATFORM = 'discord:1:dm';
const CHANNEL_PLATFORM = 'discord:1:chan';

async function makeSession(
  id: string,
  threadId: string | null,
  mgId: string | null = null,
  group = GROUP,
  status: Session['status'] = 'active',
): Promise<Session> {
  const session: Session = {
    id,
    agent_group_id: group,
    messaging_group_id: mgId,
    thread_id: threadId,
    agent_provider: null,
    status,
    container_status: 'stopped',
    last_active: null,
    created_at: NOW,
  };
  await createSession(session);
  initSessionFolder(group, id);
  return session;
}

/** Insert a task row the way the scheduler does — destination on the row itself. */
function addTaskRow(sessionId: string, channelType: string, platformId: string, seq = 2): void {
  const db = openInboundDb(inboundDbPath(GROUP, sessionId));
  try {
    db.prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, kind, channel_type, platform_id, content)
       VALUES (?, ?, ?, 'pending', 0, 'task', ?, ?, ?)`,
    ).run(`task-${seq}`, seq, NOW, channelType, platformId, JSON.stringify({ prompt: 'x' }));
  } finally {
    db.close();
  }
}

/** A dispatched task row the way `ncl tasks dispatch` writes one from a chat-less caller: no route, an origin. */
function addDispatchRow(sessionId: string, originSessionId: string | null, group = GROUP): void {
  const db = openInboundDb(inboundDbPath(group, sessionId));
  try {
    db.prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, kind, channel_type, platform_id, content)
       VALUES ('dispatch-2', 2, ?, 'pending', 0, 'task', NULL, NULL, ?)`,
    ).run(NOW, JSON.stringify({ prompt: 'x', originSessionId }));
  } finally {
    db.close();
  }
}

const dispatchThread = (n: number) => taskThreadId(`dispatch-${String(n).padStart(64, 'a')}`);

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  await createAgentGroup({ id: GROUP, name: GROUP, folder: GROUP, agent_provider: null, created_at: NOW });
  await createMessagingGroup({
    id: 'mg-dm',
    channel_type: 'discord',
    platform_id: DM_PLATFORM,
    name: 'dm',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: NOW,
  } as never);
  await createMessagingGroup({
    id: 'mg-chan',
    channel_type: 'discord',
    platform_id: CHANNEL_PLATFORM,
    name: 'chan',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: NOW,
  } as never);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('resolveSlackSafetyMessagingGroupId', () => {
  it('passes a chat session through unchanged', async () => {
    const s = await makeSession('sess-chat', 'discord:1:chan:99', 'mg-chan');
    expect(await resolveSlackSafetyMessagingGroupId(s)).toBe('mg-chan');
  });

  it('resolves a task session to the destination it posts to', async () => {
    // The regression: this used to return null, so the gate fail-closed and
    // every scheduled fire spawned under the `-noslack` identity.
    const s = await makeSession('sess-task', taskThreadId('career-journal-daily-c1fe'));
    addTaskRow('sess-task', 'discord', DM_PLATFORM);
    expect(await resolveSlackSafetyMessagingGroupId(s)).toBe('mg-dm');
  });

  // The read funnel defaults to the console fan-out's 1s busy_timeout and no
  // journal recovery. The `withInboundDb` this replaced opened READ-WRITE with
  // busy_timeout 5000, and a read-write open is what rolls a hot journal back.
  // Defaulting here would make the SPAWN GATE stricter than the code it
  // replaced: a contended session, or one whose host write was interrupted,
  // would fail to resolve its route and fall through to the fail-closed null —
  // which is what spawns every scheduled fire under the `-noslack` identity.
  it("threads the replaced open's 5s timeout and journal recovery, not the fan-out defaults", async () => {
    const s = await makeSession('sess-task-opts', taskThreadId('career-journal-daily-c1fe'));
    addTaskRow('sess-task-opts', 'discord', DM_PLATFORM);
    readOptions.last = undefined;

    await resolveSlackSafetyMessagingGroupId(s);

    expect(readOptions.last).toEqual({ busyTimeoutMs: 5000, recoverJournal: true });
  });

  it('resolves a task pointed at a shared channel to that channel, not to null', async () => {
    // Still non-owner-safe once the gate judges it — but the gate must get a
    // real subject so the decision is about the destination, not about the
    // absence of one.
    const s = await makeSession('sess-task-chan', taskThreadId('smoke-abcd'));
    addTaskRow('sess-task-chan', 'discord', CHANNEL_PLATFORM);
    expect(await resolveSlackSafetyMessagingGroupId(s)).toBe('mg-chan');
  });

  it('follows the newest row when the destination was retargeted', async () => {
    const s = await makeSession('sess-task-moved', taskThreadId('moved-1234'));
    addTaskRow('sess-task-moved', 'discord', CHANNEL_PLATFORM, 2);
    addTaskRow('sess-task-moved', 'discord', DM_PLATFORM, 4);
    expect(await resolveSlackSafetyMessagingGroupId(s)).toBe('mg-dm');
  });

  it('fail-closes on a bare system:tasks thread, which no longer names one series', async () => {
    const s = await makeSession('sess-legacy', TASKS_SYSTEM_THREAD_ID);
    addTaskRow('sess-legacy', 'discord', DM_PLATFORM);
    expect(await resolveSlackSafetyMessagingGroupId(s)).toBeNull();
  });

  it('fail-closes when the task has no destination recorded', async () => {
    const s = await makeSession('sess-nodest', taskThreadId('nodest-1'));
    expect(await resolveSlackSafetyMessagingGroupId(s)).toBeNull();
  });

  it('fail-closes when the destination resolves to no messaging group', async () => {
    const s = await makeSession('sess-unknown', taskThreadId('unknown-1'));
    addTaskRow('sess-unknown', 'discord', 'discord:1:vanished');
    expect(await resolveSlackSafetyMessagingGroupId(s)).toBeNull();
  });

  it('fail-closes on a non-task session with no messaging group (admin shell)', async () => {
    const s = await makeSession('sess-admin', null);
    expect(await resolveSlackSafetyMessagingGroupId(s)).toBeNull();
  });

  describe('a route-less dispatched session is judged by the session that dispatched it', () => {
    it('inherits the subject of a task-session origin that posts to an owner-safe destination', async () => {
      await makeSession('sess-series', taskThreadId('watch-1'));
      addTaskRow('sess-series', 'discord', DM_PLATFORM);
      const child = await makeSession('sess-child', dispatchThread(1));
      addDispatchRow('sess-child', 'sess-series');
      expect(await resolveSlackSafetyMessagingGroupId(child)).toBe('mg-dm');
    });

    it("inherits a chat origin's messaging group", async () => {
      await makeSession('sess-origin-chat', 'discord:1:chan:7', 'mg-chan');
      const child = await makeSession('sess-child-chat', dispatchThread(2));
      addDispatchRow('sess-child-chat', 'sess-origin-chat');
      expect(await resolveSlackSafetyMessagingGroupId(child)).toBe('mg-chan');
    });

    it('keeps its own route over its origin when it has one', async () => {
      await makeSession('sess-origin-dm', 'discord:1:dm:1', 'mg-dm');
      const child = await makeSession('sess-routed', dispatchThread(3));
      addTaskRow('sess-routed', 'discord', CHANNEL_PLATFORM, 4);
      addDispatchRow('sess-routed', 'sess-origin-dm');
      expect(await resolveSlackSafetyMessagingGroupId(child)).toBe('mg-chan');
    });

    it('re-judges the origin on every call, so closing it closes the child', async () => {
      await makeSession('sess-live', 'discord:1:dm:2', 'mg-dm');
      const child = await makeSession('sess-child-live', dispatchThread(4));
      addDispatchRow('sess-child-live', 'sess-live');
      expect(await resolveSlackSafetyMessagingGroupId(child)).toBe('mg-dm');
      const { updateSession } = await import('../../db/sessions.js');
      await updateSession('sess-live', { status: 'closed' });
      expect(await resolveSlackSafetyMessagingGroupId(child)).toBeNull();
    });

    it.each([
      ['no origin recorded', null],
      ['an origin that does not exist', 'sess-gone'],
      ['a closed origin', 'sess-closed'],
      ['an origin in another agent group', 'sess-foreign'],
    ])('fail-closes on %s', async (_label, origin) => {
      await createAgentGroup({ id: 'ag-other', name: 'o', folder: 'ag-other', agent_provider: null, created_at: NOW });
      await makeSession('sess-closed', 'discord:1:dm:3', 'mg-dm', GROUP, 'closed');
      await makeSession('sess-foreign', 'discord:1:dm:4', 'mg-dm', 'ag-other');
      const child = await makeSession('sess-child-x', dispatchThread(5));
      addDispatchRow('sess-child-x', origin);
      expect(await resolveSlackSafetyMessagingGroupId(child)).toBeNull();
    });

    it('stops inheriting when another task row in the session names a different origin', async () => {
      await makeSession('sess-author2', 'discord:1:dm:8', 'mg-dm');
      const child = await makeSession('sess-two-events', dispatchThread(10));
      addDispatchRow('sess-two-events', 'sess-other');
      const db = openInboundDb(inboundDbPath(GROUP, 'sess-two-events'));
      try {
        db.prepare(
          `INSERT INTO messages_in (id, seq, timestamp, status, tries, kind, content)
           VALUES ('dispatch-4', 40, ?, 'pending', 0, 'task', ?)`,
        ).run(NOW, JSON.stringify({ prompt: 'y', originSessionId: 'sess-author2' }));
      } finally {
        db.close();
      }
      expect(await resolveSlackSafetyMessagingGroupId(child)).toBeNull();
    });

    it('does not inherit for a scheduled series, only for a dispatch', async () => {
      await makeSession('sess-origin-dm2', 'discord:1:dm:5', 'mg-dm');
      const series = await makeSession('sess-sched', taskThreadId('created-from-chat-1'));
      addDispatchRow('sess-sched', 'sess-origin-dm2');
      expect(await resolveSlackSafetyMessagingGroupId(series)).toBeNull();
    });

    it('stops after two hops', async () => {
      await makeSession('sess-root', 'discord:1:dm:6', 'mg-dm');
      const hop1 = await makeSession('sess-hop1', dispatchThread(6));
      addDispatchRow('sess-hop1', 'sess-root');
      const hop2 = await makeSession('sess-hop2', dispatchThread(7));
      addDispatchRow('sess-hop2', 'sess-hop1');
      const hop3 = await makeSession('sess-hop3', dispatchThread(8));
      addDispatchRow('sess-hop3', 'sess-hop2');
      expect(await resolveSlackSafetyMessagingGroupId(hop1)).toBe('mg-dm');
      expect(await resolveSlackSafetyMessagingGroupId(hop2)).toBe('mg-dm');
      expect(await resolveSlackSafetyMessagingGroupId(hop3)).toBeNull();
    });
  });
});
