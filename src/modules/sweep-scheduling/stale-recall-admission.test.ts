/**
 * A workgroup runner runs an admitted task only together with its pending
 * `recall-<id>` partner. These drive the scheduling sweep's due admission and
 * the stale-pending expiry on real session DBs, and check the pair a runner
 * needs survives both, or is rebuilt when it did not.
 */
import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR } = vi.hoisted(() => ({ TEST_DATA_DIR: uniqueTmpRoot('stale-recall-admission') }));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: TEST_DATA_DIR };
});

import { closeDb, createAgentGroup, initMigratedTestDb } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder, withExistingMailboxSession } from '../../session-manager.js';
import { insertTaskRow } from '../scheduling/db.js';
import { PENDING_MESSAGE_MAX_AGE_MS } from '../sweep-session-core/index.js';
import { _prepareDueWakeForTesting } from './index.js';

const AG = 'ag-recall';
const SESS = 'sess-recall';
const HOUR = 60 * 60 * 1000;

beforeEach(async () => {
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
  await initMigratedTestDb();
  await createAgentGroup({
    id: AG,
    name: 'Recall',
    folder: 'recall',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: 'system:tasks:hourly',
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: null,
    created_at: new Date().toISOString(),
  });
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DATA_DIR, { recursive: true, force: true });
});

const tick = () => withExistingMailboxSession(AG, SESS, (mailbox) => _prepareDueWakeForTesting(mailbox, AG, SESS));
const expireStale = () =>
  withExistingMailboxSession(AG, SESS, (mailbox) => mailbox.expireStalePending(PENDING_MESSAGE_MAX_AGE_MS));

function seedHourly(inbound: Database.Database, id: string, dueAgoMs: number): void {
  insertTaskRow(inbound, {
    id,
    seriesId: 'hourly',
    processAfter: new Date(Date.now() - dueAgoMs).toISOString(),
    recurrence: '0 * * * *',
    content: JSON.stringify({ prompt: 'hourly check' }),
  });
}

function pair(inbound: Database.Database, id: string) {
  const read = (rowId: string) =>
    inbound.prepare('SELECT seq, status, trigger FROM messages_in WHERE id = ?').get(rowId) as
      | { seq: number; status: string; trigger: number }
      | undefined;
  return { task: read(id), recall: read(`recall-${id}`) };
}

describe('the recall partner of a live scheduled task', () => {
  it('survives the stale-pending sweep when a recurring occurrence is admitted more than 24h after its process_after', async () => {
    expect(PENDING_MESSAGE_MAX_AGE_MS).toBe(24 * HOUR);
    const inbound = new Database(inboundDbPath(AG, SESS));
    // Paused across its due time and resumed a day later: still inert, process_after unchanged.
    seedHourly(inbound, 'occ-late', 25 * HOUR);

    expect((await tick())?.admittedTasks).toBe(1);
    await expireStale();

    expect(pair(inbound, 'occ-late')).toMatchObject({
      task: { status: 'pending', trigger: 1 },
      recall: { status: 'pending', trigger: 0 },
    });
    inbound.close();
  });

  it('is rebuilt on the next tick when it ended while its task stayed pending', async () => {
    const inbound = new Database(inboundDbPath(AG, SESS));
    seedHourly(inbound, 'occ-wedged', 25 * HOUR);
    expect((await tick())?.admittedTasks).toBe(1);
    const before = pair(inbound, 'occ-wedged');
    // The state a pre-fix stale sweep left behind.
    inbound.prepare("UPDATE messages_in SET status = 'expired' WHERE id = 'recall-occ-wedged'").run();

    expect((await tick())?.admittedTasks).toBe(1);

    const after = pair(inbound, 'occ-wedged');
    expect(after).toMatchObject({
      task: { status: 'pending', trigger: 1 },
      recall: { status: 'pending', trigger: 0 },
    });
    expect(after.recall!.seq).toBeGreaterThan(before.task!.seq);
    expect(after.task!.seq).toBe(after.recall!.seq + 2);
    inbound.close();
  });

  it('is left alone while still pending, however long a running container leaves the pair unclaimed', async () => {
    const inbound = new Database(inboundDbPath(AG, SESS));
    seedHourly(inbound, 'occ-unclaimed', 2 * HOUR);
    expect((await tick())?.admittedTasks).toBe(1);
    const admitted = pair(inbound, 'occ-unclaimed');

    for (let i = 0; i < 3; i++) {
      expect((await tick())?.admittedTasks).toBe(0);
      await expireStale();
    }

    expect(pair(inbound, 'occ-unclaimed')).toEqual(admitted);
    inbound.close();
  });
});
