/**
 * What the title sweep does to `thread_titles` and the platform. Real central DB and real session DBs; only the
 * generator and the channel adapter are fake.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelRateLimitedError } from '../channels/adapter.js';
import { getDb } from '../db/connection.js';
import { closeDb, createAgentGroup, initMigratedTestDb } from '../db/index.js';
import { TASKS_SYSTEM_THREAD_ID } from '../db/sessions.js';
import { recordThreadPinned } from '../db/thread-titles.js';
import { log } from '../log.js';
import { groupRequestText } from '../modules/voice-call/prompts.js';

const h = vi.hoisted(() => ({ tmpDir: '', adapters: new Map<string, object>() }));

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  get DATA_DIR() {
    return h.tmpDir;
  },
}));

vi.mock('../env.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../env.js')>()),
  readEnvFileMatching: vi.fn(() => ({})),
}));

vi.mock('../channels/channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../channels/channel-registry.js')>()),
  getChannelAdapter: (key: string) => h.adapters.get(key),
}));

import {
  CONCURRENCY_CAP,
  THREAD_SCAN_ROWS,
  _resetCooldownForTest,
  _resetTitleBackendForTest,
  runSessionTitleSweep,
  setTitleBackendForTest,
} from './session-title-sweep.js';

const T0 = Date.parse('2026-10-01T12:00:00.000Z');
const THREAD = 'discord:111:222:333';
const OTHER_THREAD = 'discord:111:222:444';
const AGENT = 'ag-pixel';
const SIBLING = 'ag-juniper';

const minutes = (m: number) => m * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const at = (m: number) => vi.setSystemTime(T0 + minutes(m));

/** A detached rename settles on microtasks and SQLite: a real, short wait is enough, and its faults below prove it. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 25));

interface Row {
  title: string | null;
  title_source: string | null;
  attempts: number;
  titled_at: string | null;
}

const hours = (h: number) => h * 60 * 60_000;

const rowOf = async (threadId: string) =>
  (await getDb().get<Row>('SELECT * FROM thread_titles WHERE thread_id = ?', threadId))!;

async function seedRow(
  threadId: string,
  opts: {
    title?: string | null;
    platformName?: string;
    source?: string | null;
    channelType?: string;
    createdAt?: number;
    attempts?: number;
  } = {},
): Promise<void> {
  await getDb().run(
    `INSERT INTO thread_titles
       (thread_id, channel_type, title, platform_name, first_message, attempts, created_at, title_source)
     VALUES (?, ?, ?, ?, 'the opener', ?, ?, ?)`,
    threadId,
    opts.channelType ?? 'discord',
    opts.title === undefined ? 'Call with Pixel' : opts.title,
    opts.platformName ?? null,
    opts.attempts ?? 0,
    iso(opts.createdAt ?? Date.now()),
    opts.source === undefined ? 'auto' : opts.source,
  );
}

const threadOfSession = new Map<string, string>();

async function seedSession(id: string, threadId: string, agent = AGENT, lastActive = Date.now()): Promise<void> {
  threadOfSession.set(id, threadId);
  await getDb().run(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, status, created_at, last_active)
     VALUES (?, ?, NULL, ?, 'active', ?, ?)`,
    id,
    agent,
    threadId,
    iso(Date.now()),
    iso(lastActive),
  );
  mailbox(id, agent).close();
}

function mailbox(sessionId: string, agent: string): Database.Database {
  const dir = path.join(h.tmpDir, 'v2-sessions', agent, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const db = new Database(path.join(dir, 'inbound.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS messages_in (
    id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, timestamp TEXT, status TEXT, content TEXT,
    trigger INTEGER NOT NULL DEFAULT 1
  )`);
  return db;
}

function say(sessionId: string, seq: number, text: string, agent = AGENT): void {
  const db = mailbox(sessionId, agent);
  db.prepare(`INSERT INTO messages_in VALUES (?, ?, 'chat', ?, 'pending', ?, 1)`).run(
    `m-${seq}`,
    seq,
    iso(Date.now()),
    JSON.stringify({ text }),
  );
  db.close();
}

function speak(
  sessionId: string,
  seq: number,
  text: string,
  opts: { agent?: string; attachments?: object[]; id?: string } = {},
): void {
  const db = mailbox(sessionId, opts.agent ?? AGENT);
  db.prepare(`INSERT INTO messages_in VALUES (?, ?, 'chat-sdk', ?, 'pending', ?, 1)`).run(
    `m-${seq}`,
    seq,
    iso(Date.now()),
    JSON.stringify({
      id: opts.id ?? `msg-${sessionId}-${seq}`,
      text,
      author: { isBot: false },
      attachments: opts.attachments ?? [],
    }),
  );
  db.close();
}

function agentReplies(
  sessionId: string,
  seq: number,
  text: string,
  opts: { agent?: string; kind?: string; thread?: string | null; platform?: string; content?: string } = {},
): void {
  const dir = path.join(h.tmpDir, 'v2-sessions', opts.agent ?? AGENT, sessionId);
  const db = new Database(path.join(dir, 'outbound.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS messages_out (
    id TEXT PRIMARY KEY, seq INTEGER, kind TEXT, timestamp TEXT, platform_id TEXT, thread_id TEXT, content TEXT
  )`);
  db.prepare(`INSERT INTO messages_out VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    `out-${seq}`,
    seq,
    opts.kind ?? 'chat',
    iso(Date.now()),
    opts.platform ?? 'discord:111:222',
    opts.thread === undefined ? (threadOfSession.get(sessionId) ?? null) : opts.thread,
    opts.content ?? JSON.stringify({ text }),
  );
  db.close();
}

function discord(name: string | null = 'Call with Pixel') {
  let live = name;
  const adapter = {
    channelType: 'discord',
    threadName: vi.fn(async () => live),
    renameThread: vi.fn(async (_threadId: string, next: string) => {
      live = next;
      return next;
    }),
    personRenames: (next: string) => {
      live = next;
    },
  };
  h.adapters.set('discord', adapter);
  return adapter;
}

function titles(...generated: string[]) {
  const backend = vi.fn(async (_system: string, _user: string) => generated.shift() ?? 'no more titles');
  setTitleBackendForTest(backend);
  return backend;
}

async function tick() {
  const result = await runSessionTitleSweep();
  await settle();
  return result;
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  h.tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'thread-title-sweep-'));
  h.adapters.clear();
  threadOfSession.clear();
  await initMigratedTestDb();
  await createAgentGroup({ id: AGENT, name: AGENT, folder: AGENT, agent_provider: null, created_at: iso(T0) });
  await createAgentGroup({ id: SIBLING, name: SIBLING, folder: SIBLING, agent_provider: null, created_at: iso(T0) });
});

afterEach(async () => {
  await closeDb();
  _resetTitleBackendForTest();
  _resetCooldownForTest();
  fs.rmSync(h.tmpDir, { recursive: true, force: true });
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('which rows may change', () => {
  it.each([[null], ['pinned'], ['person']])('never renames a row whose source is %s', async (source) => {
    const platform = discord('Chosen name');
    await seedRow(THREAD, { title: 'Chosen name', source });
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'a brand new topic');
    titles('Something else');

    await tick();
    at(6);
    say('s-1', 4, 'and another');
    await tick();

    expect(platform.threadName).not.toHaveBeenCalled();
    expect(platform.renameThread).not.toHaveBeenCalled();
    expect(await rowOf(THREAD)).toMatchObject({
      title: 'Chosen name',
      title_source: source,
      attempts: 0,
      titled_at: null,
    });
  });

  it('leaves a thread with no row to the session titles', async () => {
    const platform = discord('A thread somebody named');
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'what changed overnight?');
    titles('Overnight changes');

    expect((await tick()).generated).toBe(1);

    expect(platform.threadName).not.toHaveBeenCalled();
    expect(platform.renameThread).not.toHaveBeenCalled();
  });

  it('renames the `Call with` placeholder once someone speaks, and stores what the platform stored', async () => {
    const platform = discord();
    platform.renameThread.mockImplementation(async (_id, next) => next.toLowerCase());
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'the budget review numbers');
    const backend = titles('Budget Review');

    await tick();

    expect(backend).toHaveBeenCalledTimes(1);
    expect(platform.renameThread).toHaveBeenCalledWith(THREAD, 'Budget Review');
    expect(await rowOf(THREAD)).toMatchObject({ title: 'budget review', title_source: 'auto', attempts: 1 });
  });

  it('skips a thread while its adapter is offline, spending no turn and no generation', async () => {
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'the budget review numbers');
    const backend = titles('Budget review');

    await tick();

    expect(backend).not.toHaveBeenCalled();
    expect((await rowOf(THREAD)).titled_at).toBeNull();
  });

  it('compares a first rename with the name the thread opened with', async () => {
    const platform = discord('Named by a person');
    await seedRow(THREAD, { title: null, platformName: 'Thread 10/1/2026, 12:00:00 PM' });
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'the budget review numbers');
    titles('Budget review');

    await tick();

    expect(platform.renameThread).not.toHaveBeenCalled();
    expect(await rowOf(THREAD)).toMatchObject({ title: 'Named by a person', title_source: 'person' });
  });

  it('renames a thread still on the name it opened with', async () => {
    discord('Thread 10/1/2026, 12:00:00 PM');
    await seedRow(THREAD, { title: null, platformName: 'Thread 10/1/2026, 12:00:00 PM' });
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'the budget review numbers');
    titles('Budget review');

    await tick();

    expect(await rowOf(THREAD)).toMatchObject({ title: 'Budget review', title_source: 'auto', attempts: 1 });
  });

  it('with no stored name to compare, the first rename goes ahead', async () => {
    const platform = discord('Thread 10/1/2026, 12:00:00 PM');
    await seedRow(THREAD, { title: null });
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'the budget review numbers');
    titles('Budget review');

    await tick();

    expect(platform.renameThread).toHaveBeenCalledTimes(1);
    expect((await rowOf(THREAD)).title).toBe('Budget review');
  });
});

describe('a rename someone asked for', () => {
  it('stays, however young the thread and whatever is said after it', async () => {
    const platform = discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'first topic');
    titles('Session title only');
    await recordThreadPinned(THREAD, 'discord', 'Asked for');

    await tick();

    expect(platform.threadName).not.toHaveBeenCalled();
    expect(platform.renameThread).not.toHaveBeenCalled();
    expect(await rowOf(THREAD)).toMatchObject({ title: 'Asked for', title_source: 'pinned', titled_at: null });
  });

  it('wins over a title generated while it landed', async () => {
    const platform = discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'first topic');
    setTitleBackendForTest(async () => {
      await recordThreadPinned(THREAD, 'discord', 'Asked for');
      return 'Generated title';
    });

    await tick();

    expect(platform.renameThread).not.toHaveBeenCalled();
    expect(await rowOf(THREAD)).toMatchObject({ title: 'Asked for', title_source: 'pinned' });
  });

  it('wins when it lands during the platform call', async () => {
    const platform = discord();
    platform.renameThread.mockImplementation(async (_id, next) => {
      await recordThreadPinned(THREAD, 'discord', 'Asked for');
      return next;
    });
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'first topic');
    titles('Generated title');

    await tick();

    expect(await rowOf(THREAD)).toMatchObject({ title: 'Asked for', title_source: 'pinned', attempts: 0 });
  });

  it('wins there too on a platform with no thread names', async () => {
    h.adapters.set('slack', { channelType: 'slack' });
    const thread = 'slack:C0TEST:1700000001.000100';
    await seedRow(thread, { channelType: 'slack' });
    await seedSession('s-1', thread);
    say('s-1', 2, 'first topic');
    setTitleBackendForTest(async () => {
      await recordThreadPinned(thread, 'slack', 'Asked for');
      return 'Generated title';
    });

    await tick();

    expect(await rowOf(thread)).toMatchObject({ title: 'Asked for', title_source: 'pinned', attempts: 0 });
  });
});

describe('a person renaming a thread', () => {
  it('stops every later rename for good and keeps the name they chose', async () => {
    const platform = discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'first topic');
    titles('First topic', 'Second topic', 'Third topic');
    await tick();
    expect(platform.renameThread).toHaveBeenCalledTimes(1);

    platform.personRenames('Named by a person');
    at(6);
    say('s-1', 4, 'second topic');
    await tick();

    expect(platform.renameThread).toHaveBeenCalledTimes(1);
    expect(await rowOf(THREAD)).toMatchObject({ title: 'Named by a person', title_source: 'person' });
    const readsSoFar = platform.threadName.mock.calls.length;

    at(12);
    say('s-1', 6, 'third topic');
    await tick();

    expect(platform.threadName).toHaveBeenCalledTimes(readsSoFar);
    expect(platform.renameThread).toHaveBeenCalledTimes(1);
    expect((await rowOf(THREAD)).title).toBe('Named by a person');
  });

  it('back to an earlier title a sibling session still holds is still theirs', async () => {
    const platform = discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD, AGENT, T0);
    await seedSession('s-2', THREAD, SIBLING, T0 - minutes(1));
    say('s-1', 2, 'first topic');
    say('s-2', 2, 'second topic', SIBLING);
    titles('First topic', 'Second topic', 'KEEP');
    await tick();

    at(6);
    await getDb().run(`UPDATE sessions SET last_active = ? WHERE id = 's-2'`, iso(Date.now()));
    await tick();
    expect(await rowOf(THREAD)).toMatchObject({ title: 'Second topic', attempts: 2 });

    platform.personRenames('First topic');
    at(12);
    say('s-2', 4, 'more on the second topic', SIBLING);
    await tick();

    expect(await rowOf(THREAD)).toMatchObject({ title: 'First topic', title_source: 'person' });
  });

  it('is seen on a turn whose answer keeps the title', async () => {
    const platform = discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'first topic');
    titles('First topic', 'KEEP');
    await tick();

    platform.personRenames('Named by a person');
    at(6);
    say('s-1', 4, 'more on the first topic');
    await tick();

    expect(platform.renameThread).toHaveBeenCalledTimes(1);
    expect(await rowOf(THREAD)).toMatchObject({ title: 'Named by a person', title_source: 'person' });
  });
});

describe('sibling sessions in one thread', () => {
  async function twoSiblings(): Promise<void> {
    await seedRow(THREAD);
    await seedSession('s-busy', THREAD, AGENT, T0);
    await seedSession('s-quiet', THREAD, SIBLING, T0 - minutes(1));
    say('s-busy', 2, 'the busy view', AGENT);
    say('s-quiet', 2, 'the quiet view', SIBLING);
  }
  const generateFromSlice = () => titles('Busy title', 'Quiet title');

  it('share one generation a tick, from the freshest session', async () => {
    const platform = discord();
    await twoSiblings();
    const backend = generateFromSlice();

    await tick();

    expect(backend).toHaveBeenCalledTimes(1);
    expect(platform.renameThread.mock.calls).toEqual([[THREAD, 'Busy title']]);
    const stored = await getDb().all<{ id: string; title: string | null }>(
      'SELECT id, title FROM sessions ORDER BY id',
    );
    expect(stored).toEqual([
      { id: 's-busy', title: 'Busy title' },
      { id: 's-quiet', title: null },
    ]);
  });

  it('cannot flip the name inside the cooldown', async () => {
    const platform = discord();
    await twoSiblings();
    const backend = generateFromSlice();
    await tick();

    await getDb().run('UPDATE sessions SET last_active = ? WHERE id = ?', iso(T0 + minutes(1)), 's-quiet');
    at(1);
    await tick();

    expect(backend).toHaveBeenCalledTimes(1);
    expect(platform.renameThread).toHaveBeenCalledTimes(1);
    expect((await rowOf(THREAD)).title).toBe('Busy title');
  });

  it('cannot flip the name after the cooldown either, when the freshest session has nothing new', async () => {
    const platform = discord();
    await twoSiblings();
    const backend = generateFromSlice();
    await tick();

    at(6);
    await tick();

    expect(backend).toHaveBeenCalledTimes(1);
    expect(platform.renameThread).toHaveBeenCalledTimes(1);
  });
});

describe('the young window', () => {
  it('ends 60 minutes after the row was created, for a thread with a real title', async () => {
    const platform = discord('Real title');
    await seedRow(THREAD, { title: 'Real title', attempts: 1, createdAt: T0 - minutes(60) });
    await seedRow(OTHER_THREAD, { title: 'Real title', attempts: 1, createdAt: T0 - minutes(60) - 1 });
    await seedSession('s-open', THREAD);
    await seedSession('s-settled', OTHER_THREAD);
    say('s-open', 2, 'still open');
    say('s-settled', 2, 'already settled');
    titles('Open title', 'Session title only');

    await tick();

    expect(platform.renameThread.mock.calls).toEqual([[THREAD, 'Open title']]);
    expect(await rowOf(OTHER_THREAD)).toMatchObject({ title: 'Real title', attempts: 1 });
  });

  it('waits 5 minutes between renames', async () => {
    const platform = discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'first');
    titles('First title', 'Second title');
    await tick();

    vi.setSystemTime(T0 + minutes(5) - 1);
    say('s-1', 4, 'second');
    await tick();
    expect(platform.renameThread).toHaveBeenCalledTimes(1);

    vi.setSystemTime(T0 + minutes(5));
    await tick();
    expect(platform.renameThread).toHaveBeenCalledTimes(2);
  });

  it('stops at 3 renames', async () => {
    const platform = discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    titles('Title 1', 'Title 2', 'Title 3', 'Title 4');

    for (let round = 1; round <= 4; round++) {
      at((round - 1) * 6);
      say('s-1', round * 2, `topic ${round}`);
      await tick();
    }

    expect(platform.renameThread).toHaveBeenCalledTimes(3);
    expect(await rowOf(THREAD)).toMatchObject({ title: 'Title 3', attempts: 3 });
  });

  it('spends no rename when the answer keeps the title, or only restyles it', async () => {
    const platform = discord('Current title');
    await seedRow(THREAD, { title: 'Current title', attempts: 1 });
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'more');
    titles('KEEP', 'current title.');

    await tick();
    at(6);
    say('s-1', 4, 'and more');
    await tick();

    expect(platform.renameThread).not.toHaveBeenCalled();
    expect((await rowOf(THREAD)).attempts).toBe(1);
  });

  it('logs each rename, which is how renames per day are counted', async () => {
    const info = vi.spyOn(log, 'info');
    discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'rollout plan');
    titles('Rollout plan');

    await tick();

    expect(info).toHaveBeenCalledWith('Thread title: renamed', expect.objectContaining({ threadId: THREAD }));
  });

  it('spends no rename when the title did not change', async () => {
    const platform = discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'first');
    titles('Same title', 'Same title');
    await tick();

    at(6);
    say('s-1', 4, 'more of the same');
    await tick();

    expect(platform.renameThread).toHaveBeenCalledTimes(1);
    expect((await rowOf(THREAD)).attempts).toBe(1);
  });

  it('regenerates on one new exchange, not on less, and asks to keep a title that still fits', async () => {
    discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'first');
    const backend = titles('First title', 'Second title');
    await tick();
    expect(backend.mock.calls[0]![1]).not.toContain('Current label');

    at(6);
    say('s-1', 3, 'half an exchange');
    await tick();
    expect(backend).toHaveBeenCalledTimes(1);

    say('s-1', 4, 'the rest of it');
    await tick();
    expect(backend).toHaveBeenCalledTimes(2);
    expect(backend.mock.calls[1]![1]).toContain('Current label: First title');
  });
});

describe('a rename that fails', () => {
  it('leaves the name alone, and the same pass titles the next thread', async () => {
    const platform = discord();
    platform.renameThread.mockRejectedValueOnce(new Error('403 Missing Permissions'));
    await seedRow(THREAD);
    await seedRow(OTHER_THREAD);
    await seedSession('s-1', THREAD, AGENT, T0);
    await seedSession('s-2', OTHER_THREAD, AGENT, T0 - minutes(1));
    say('s-1', 2, 'will fail');
    say('s-2', 2, 'will work');
    titles('Failed title', 'Working title');

    expect((await tick()).generated).toBe(2);

    expect(await rowOf(THREAD)).toMatchObject({ title: 'Call with Pixel', title_source: 'auto', attempts: 0 });
    expect(await rowOf(OTHER_THREAD)).toMatchObject({ title: 'Working title', attempts: 1 });
  });

  it('is retried on the thread’s next turn, even with nothing new said', async () => {
    const platform = discord();
    platform.renameThread.mockRejectedValueOnce(new Error('503'));
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'the only message');
    titles('Retried title', 'Retried title');
    await tick();

    at(5);
    await tick();

    expect(await rowOf(THREAD)).toMatchObject({ title: 'Retried title', attempts: 1 });
  });

  it('after landing, with only its response lost, finishes and is never read as a person’s rename', async () => {
    const platform = discord();
    platform.renameThread.mockImplementationOnce(async (_threadId: string, next: string) => {
      platform.personRenames(next);
      throw new Error('socket hang up');
    });
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'the only message');
    titles('Landed title', 'A later title');
    await tick();
    expect(await rowOf(THREAD)).toMatchObject({ title: 'Call with Pixel', attempts: 0 });

    at(5);
    await tick();

    expect(await rowOf(THREAD)).toMatchObject({ title: 'Landed title', title_source: 'auto', attempts: 1 });
    expect(platform.renameThread).toHaveBeenCalledTimes(1);
  });

  it('cannot hold up the pass, whatever the platform does', async () => {
    const platform = discord();
    platform.renameThread.mockImplementationOnce(() => new Promise<string>(() => {}));
    await seedRow(THREAD);
    await seedRow(OTHER_THREAD);
    await seedSession('s-1', THREAD, AGENT, T0);
    await seedSession('s-2', OTHER_THREAD, AGENT, T0 - minutes(1));
    say('s-1', 2, 'hangs');
    say('s-2', 2, 'works');
    titles('Hanging title', 'Working title');

    expect((await tick()).generated).toBe(2);

    expect((await rowOf(OTHER_THREAD)).title).toBe('Working title');
  });

  it('honours the wait a 429 asked for, past the cooldown', async () => {
    const platform = discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'first topic');
    const backend = titles('First title', 'Second title', 'Second title');
    await tick();

    platform.renameThread.mockRejectedValueOnce(new ChannelRateLimitedError(minutes(20)));
    at(6);
    say('s-1', 4, 'second topic');
    await tick();
    expect(backend).toHaveBeenCalledTimes(2);

    at(25);
    await tick();
    expect(backend).toHaveBeenCalledTimes(2);

    at(26);
    await tick();
    expect(backend).toHaveBeenCalledTimes(3);
    expect((await rowOf(THREAD)).title).toBe('Second title');
  });

  it('keeps the cooldown when a 429 asked for less', async () => {
    const platform = discord();
    platform.renameThread.mockRejectedValueOnce(new ChannelRateLimitedError(1_000));
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'rate limited');
    const backend = titles('Title', 'Title');
    await tick();

    at(4);
    await tick();

    expect(backend).toHaveBeenCalledTimes(1);
  });

  it('treats a name it could not read as a failure, never as a person’s rename', async () => {
    const platform = discord();
    platform.threadName.mockRejectedValueOnce(new Error('Discord thread call failed: 500'));
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'unreadable');
    titles('Title');

    await tick();

    expect(platform.renameThread).not.toHaveBeenCalled();
    expect(await rowOf(THREAD)).toMatchObject({ title: 'Call with Pixel', title_source: 'auto' });
  });
});

describe('a thread with no real title', () => {
  it('stays open past the young window, until 24 hours from creation', async () => {
    const platform = discord(null);
    await seedRow(THREAD, { title: null, createdAt: T0 - hours(24) });
    await seedRow(OTHER_THREAD, { title: null, createdAt: T0 - hours(24) - 1 });
    await seedSession('s-open', THREAD);
    await seedSession('s-closed', OTHER_THREAD);
    say('s-open', 2, 'an outage ate this one');
    say('s-closed', 2, 'and this one, a day ago');
    titles('Late title', 'Session title only');

    await tick();

    expect(platform.renameThread.mock.calls).toEqual([[THREAD, 'Late title']]);
    expect((await rowOf(OTHER_THREAD)).title).toBeNull();
  });

  it('includes the `Call with` placeholder, which is no one’s title', async () => {
    const platform = discord();
    await seedRow(THREAD, { createdAt: T0 - hours(3) });
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'someone finally spoke');
    titles('Late title');

    await tick();

    expect(platform.renameThread).toHaveBeenCalledTimes(1);
    expect((await rowOf(THREAD)).title).toBe('Late title');
  });

  it('settles at 60 minutes once it has one, however late it came', async () => {
    const platform = discord();
    await seedRow(THREAD, { createdAt: T0 - hours(3) });
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'first topic');
    titles('Late title', 'Never applied');
    await tick();

    at(6);
    say('s-1', 4, 'second topic');
    await tick();

    expect(platform.renameThread).toHaveBeenCalledTimes(1);
  });

  async function outage(endsAfter: number): Promise<ReturnType<typeof vi.fn>> {
    discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    say('s-1', 2, 'the budget review');
    const backend = vi.fn(async (_system: string, _user: string) => {
      if (Date.now() < T0 + endsAfter) throw new Error('backend down');
      return 'Budget review';
    });
    setTitleBackendForTest(backend);
    for (let minute = 0; minute <= 24 * 60; minute++) {
      at(minute);
      await runSessionTitleSweep();
    }
    await settle();
    return backend;
  }

  it('spends at most 12 tries on a day-long outage, one a turn', async () => {
    const backend = await outage(hours(25));

    expect(backend.mock.calls.length).toBeLessThanOrEqual(12);
    expect(backend.mock.calls.length).toBeGreaterThanOrEqual(8);
    expect(await rowOf(THREAD)).toMatchObject({ title: 'Call with Pixel', attempts: 0 });
  });

  it('gets its title once an outage ends, even hours into the day', async () => {
    await outage(hours(5));

    expect(await rowOf(THREAD)).toMatchObject({ title: 'Budget review', attempts: 1 });
  });
});

describe('a channel with no thread names', () => {
  it('updates the row under the same rules, with no platform call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const deliver = vi.fn();
    h.adapters.set('slack', { channelType: 'slack', deliver });
    const thread = 'slack:C0TEST:1700000001.000100';
    await seedRow(thread, { channelType: 'slack' });
    await seedSession('s-1', thread);
    say('s-1', 2, 'the budget review');
    titles('Budget review', 'Too soon');

    await tick();
    expect(await rowOf(thread)).toMatchObject({ title: 'Budget review', title_source: 'auto', attempts: 1 });

    at(1);
    say('s-1', 4, 'and more');
    await tick();
    expect((await rowOf(thread)).title).toBe('Budget review');

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('how soon a first title lands', () => {
  it('within a tick of the first triggering message, on a thread that sat empty', async () => {
    discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    const backend = titles('Budget review');

    await tick();
    expect(backend).not.toHaveBeenCalled();
    const session = await getDb().get<{ title_generated_at: string | null }>(
      'SELECT title_generated_at FROM sessions WHERE id = ?',
      's-1',
    );
    expect(session?.title_generated_at).toBeNull();

    at(1);
    say('s-1', 2, 'the budget review');
    await tick();

    expect((await rowOf(THREAD)).title).toBe('Budget review');
  });

  it('whatever backoff the session already carries', async () => {
    discord();
    await seedSession('s-1', THREAD);
    await getDb().run('UPDATE sessions SET title_generated_at = ? WHERE id = ?', iso(T0), 's-1');
    await seedRow(THREAD);
    say('s-1', 2, 'the budget review');
    titles('Budget review');

    await tick();

    expect((await rowOf(THREAD)).title).toBe('Budget review');
  });

  it('behind a page of threads with nothing new, within two ticks', async () => {
    discord();
    for (let i = 0; i < THREAD_SCAN_ROWS; i++) {
      await seedRow(`discord:111:222:7${i}`);
      await seedSession(`s-quiet-${i}`, `discord:111:222:7${i}`, AGENT, T0 + i);
    }
    await seedRow(THREAD);
    await seedSession('s-due', THREAD, AGENT, T0 - minutes(1));
    say('s-due', 2, 'something new');
    titles('Due title');

    await tick();
    await tick();

    expect((await rowOf(THREAD)).title).toBe('Due title');
  });

  it('in order down a full page, never skipping the rows past the slots', async () => {
    discord();
    for (let i = 0; i < THREAD_SCAN_ROWS + CONCURRENCY_CAP; i++) {
      const thread = `discord:111:222:8${i}`;
      await seedRow(thread);
      await seedSession(`s-busy-${i}`, thread, AGENT, T0 - i * 1000);
      say(`s-busy-${i}`, 2, `Topic number ${i}.`);
    }
    const backend = titles();

    await tick();
    await tick();

    const prompts = backend.mock.calls.map(([, prompt]) => prompt);
    expect(prompts.filter((prompt) => prompt.includes(`Topic number ${CONCURRENCY_CAP}.`))).toHaveLength(1);
  });

  it('ahead of young threads already named, however recent they are', async () => {
    discord();
    for (let i = 0; i < CONCURRENCY_CAP; i++) {
      const named = `discord:111:222:${500 + i}`;
      await seedRow(named, { title: `Named ${i}`, attempts: 1 });
      await seedSession(`s-named-${i}`, named, AGENT, T0);
      say(`s-named-${i}`, 2, 'more on a named thread');
    }
    await seedRow(THREAD);
    await seedSession('s-new', THREAD, AGENT, T0 - minutes(1));
    say('s-new', 2, 'a first message');
    const backend = titles('First title');

    await tick();

    expect(backend.mock.calls[0]![1]).toContain('a first message');
  });

  it('even behind a crowd of empty young threads, which also take nothing from plain sessions', async () => {
    discord();
    for (let i = 0; i < CONCURRENCY_CAP * 5; i++) {
      await seedRow(`discord:111:222:9${i}`);
      await seedSession(`s-shell-${i}`, `discord:111:222:9${i}`, AGENT, T0 + i);
    }
    await seedRow(THREAD);
    await seedSession('s-real', THREAD, AGENT, T0 - minutes(1));
    say('s-real', 2, 'real work');
    await seedSession('s-plain', 'system:tasks:example', AGENT, T0 - minutes(2));
    say('s-plain', 2, 'a plain session');
    titles('Real title', 'Plain title');

    const result = await tick();

    expect(result.generated).toBe(2);
    expect((await rowOf(THREAD)).title).toBe('Real title');
  });
});

const LONG_REPLY = 'The linked piece argues for retiring feature branches: '.repeat(4);

describe('a first message that only points at something', () => {
  async function pointedThread(): Promise<void> {
    await seedRow(THREAD, { title: null, platformName: 'thoughts?' });
    await seedSession('s-1', THREAD);
    speak('s-1', 2, 'thoughts? https://example.test/piece');
  }

  it('takes no turn until the reply, then gets its title on the next tick, from that reply', async () => {
    const platform = discord('thoughts?');
    await pointedThread();
    const backend = titles('Retiring feature branches');

    await tick();
    expect(backend).not.toHaveBeenCalled();
    expect((await rowOf(THREAD)).titled_at).toBeNull();

    at(4);
    agentReplies('s-1', 3, LONG_REPLY);
    await tick();

    expect(backend.mock.calls[0]?.[1]).toContain('retiring feature branches');
    expect(platform.renameThread.mock.calls).toEqual([[THREAD, 'Retiring feature branches']]);
  });

  it('stops waiting at 30 minutes, so a thread whose agent never answers still gets a title', async () => {
    discord('thoughts?');
    await pointedThread();
    const backend = titles('Piece on example.test');

    at(29);
    await tick();
    expect(backend).not.toHaveBeenCalled();

    at(30);
    await tick();
    expect((await rowOf(THREAD)).title).toBe('Piece on example.test');
  });

  it('moves a plain session out of the way and picks it up within minutes of the reply', async () => {
    await seedSession('s-plain', OTHER_THREAD);
    speak('s-plain', 2, 'thoughts? https://example.test/piece');
    const backend = titles('Retiring feature branches');

    await tick();
    expect(backend).not.toHaveBeenCalled();

    at(1);
    agentReplies('s-plain', 3, LONG_REPLY);
    await tick();
    expect(backend).not.toHaveBeenCalled();

    at(3);
    await tick();
    expect(backend).toHaveBeenCalledTimes(1);
  });
});

describe('a thread several agents share', () => {
  it('reads a person’s message that reached only one of them', async () => {
    discord();
    await seedRow(THREAD);
    await seedSession('s-busy', THREAD, AGENT, T0);
    await seedSession('s-quiet', THREAD, SIBLING, T0 - minutes(1));
    speak('s-busy', 2, 'first the rollout plan');
    speak('s-quiet', 2, 'also the billing cutover', { agent: SIBLING });
    const backend = titles('Rollout and billing cutover');

    await tick();

    expect(backend.mock.calls[0]?.[1]).toContain('billing cutover');
  });

  it('answers to the name the thread shows, so siblings end up with one title', async () => {
    await seedTitled('s-new', OTHER_THREAD, { title: 'Billing cutover', generatedAt: T0 - hours(1) });
    await seedTitled('s-old', OTHER_THREAD, { agent: SIBLING, title: 'Old name', generatedAt: T0 - hours(3) });
    say('s-old', 20, 'more on it', SIBLING);
    const backend = titles('KEEP');

    await tick();

    expect(backend.mock.calls[0]?.[1]).toContain('Current label: Billing cutover');
    const stored = await getDb().get<{ title: string }>('SELECT title FROM sessions WHERE id = ?', 's-old');
    expect(stored?.title).toBe('Billing cutover');
  });
});

async function seedTitled(
  id: string,
  threadId: string,
  opts: { agent?: string; title?: string; generatedAt?: number; basis?: number; lastActive?: number } = {},
): Promise<void> {
  await seedSession(id, threadId, opts.agent ?? AGENT, opts.lastActive ?? Date.now());
  await getDb().run(
    'UPDATE sessions SET title = ?, title_generated_at = ?, title_basis_seq = ? WHERE id = ?',
    opts.title ?? 'Current title',
    iso(opts.generatedAt ?? Date.now() - hours(3)),
    opts.basis ?? 10,
    id,
  );
}

const threadOf = (i: number) => `slack:C0:${i}`;

describe('refreshes', () => {
  it('still run behind a backlog of untitled shells', async () => {
    for (let i = 0; i < 40; i++) await seedSession(`shell-${i}`, threadOf(i));
    await seedTitled('s-due', OTHER_THREAD, { lastActive: T0 - minutes(30) });
    say('s-due', 20, 'moved on a lot');
    const backend = titles('Next subject');

    await tick();

    expect(backend).toHaveBeenCalledTimes(1);
    const stored = await getDb().get<{ title: string }>('SELECT title FROM sessions WHERE id = ?', 's-due');
    expect(stored?.title).toBe('Next subject');
  });

  it('reach a due session behind any number of sessions under the floor', async () => {
    for (let i = 0; i < 14; i++) {
      await seedTitled(`quiet-${i}`, threadOf(i), { lastActive: T0 - minutes(i) });
      say(`quiet-${i}`, 12, 'one more');
    }
    await seedTitled('s-due', OTHER_THREAD, { lastActive: T0 - minutes(60) });
    say('s-due', 20, 'moved on a lot');
    const backend = titles('Next subject');

    await tick();
    at(1);
    await tick();

    expect(backend).toHaveBeenCalledTimes(1);
  });

  it('take one slot a tick, and untitled sessions get the rest', async () => {
    for (let i = 0; i < 3; i++) {
      await seedTitled(`due-${i}`, threadOf(i));
      say(`due-${i}`, 20, 'moved on');
      await seedSession(`untitled-${i}`, threadOf(i + 10));
      say(`untitled-${i}`, 2, 'a new question');
    }
    titles('First subject', 'Second subject', 'Third subject');

    await tick();

    const refreshed = await getDb().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions WHERE id LIKE 'due-%' AND title <> 'Current title'`,
    );
    const firstTitles = await getDb().get<{ n: number }>(
      `SELECT COUNT(*) AS n FROM sessions WHERE id LIKE 'untitled-%' AND title IS NOT NULL`,
    );
    expect([refreshed?.n, firstTitles?.n]).toEqual([1, 2]);
  });

  it('hold at the new-message floor', async () => {
    await seedTitled('s-floor', OTHER_THREAD);
    say('s-floor', 19, 'nearly');
    const backend = titles('Next subject');

    await tick();

    expect(backend).not.toHaveBeenCalled();
  });

  it('skip a session with nothing new since its title, nothing for a day, or a task’s fresh conversation', async () => {
    await seedTitled('s-idle', threadOf(1), { lastActive: T0 - hours(4) });
    say('s-idle', 20, 'said before the title', AGENT);
    await seedTitled('s-gone', threadOf(2), { generatedAt: T0 - hours(40), lastActive: T0 - hours(25) });
    say('s-gone', 20, 'said a while ago', AGENT);
    await seedTitled('s-task', 'system:tasks:nightly-run');
    say('s-task', 20, 'another fire', AGENT);
    const backend = titles('Next subject');

    await tick();

    expect(backend).not.toHaveBeenCalled();
  });

  it('start the clock when the answer keeps the title, so a quiet answer is not asked again', async () => {
    await seedTitled('s-keep', OTHER_THREAD);
    say('s-keep', 20, 'moved on');
    const backend = titles('KEEP', 'Next subject');

    await tick();
    at(30);
    await tick();

    expect(backend).toHaveBeenCalledTimes(1);
    const stored = await getDb().get<{ title: string; title_basis_seq: number }>(
      'SELECT title, title_basis_seq FROM sessions WHERE id = ?',
      's-keep',
    );
    expect(stored).toEqual({ title: 'Current title', title_basis_seq: 20 });
  });

  it.each([
    ['frozen', null],
    ['person-named', 'person'],
    ['pinned', 'pinned'],
    ['settled', 'auto'],
  ])('spend nothing on a %s row, whose title is what every surface shows', async (_label, source) => {
    const platform = discord();
    await seedRow(THREAD, { title: 'Named', source, createdAt: T0 - hours(2), attempts: 1 });
    await seedTitled('s-row', THREAD);
    say('s-row', 20, 'moved on');
    const backend = titles('Next subject');

    await tick();

    expect(backend).not.toHaveBeenCalled();
    expect(platform.renameThread).not.toHaveBeenCalled();
    expect((await rowOf(THREAD)).title).toBe('Named');
  });
});

describe('what the agent said', () => {
  const IN_THREAD =
    'In this thread the agent worked through retiring feature branches, and why short-lived ones remain.';
  const DM = 'A private note to one person about their salary review. '.repeat(3);
  const ROOT = 'A notice posted to the root of the same channel about the release. '.repeat(3);
  const promptOf = (backend: ReturnType<typeof titles>) => backend.mock.calls[0]![1];

  beforeEach(() => discord());

  it('counts only where it went to this thread, never a DM or the channel root', async () => {
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    speak('s-1', 2, 'what next?');
    agentReplies('s-1', 3, DM, { thread: null, platform: 'discord:@me:555' });
    agentReplies('s-1', 5, ROOT, { thread: null });
    agentReplies('s-1', 7, IN_THREAD);
    const backend = titles('Retiring feature branches');

    await tick();

    expect(promptOf(backend)).toContain(`First reply: ${IN_THREAD}`);
    expect(promptOf(backend)).not.toContain(DM);
    expect(promptOf(backend)).not.toContain(ROOT);
  });

  it('counts the same way for a sibling session', async () => {
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    await seedSession('s-2', THREAD, SIBLING);
    speak('s-1', 2, 'what next?');
    agentReplies('s-2', 3, DM, { agent: SIBLING, thread: null, platform: 'discord:@me:555' });
    const backend = titles('Next steps');

    await tick();

    expect(promptOf(backend)).not.toContain('First reply:');
  });

  it('stays whole on a task session, whose rows name no thread', async () => {
    await seedSession('s-task', `${TASKS_SYSTEM_THREAD_ID}:series-1`);
    speak('s-task', 2, 'the nightly brief');
    agentReplies('s-task', 3, IN_THREAD, { thread: null });
    const backend = titles('Nightly brief');

    await tick();

    expect(promptOf(backend)).toContain(`First reply: ${IN_THREAD}`);
  });

  it('is found however many status rows come first', async () => {
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    speak('s-1', 2, 'what next?');
    for (let i = 0; i < 12; i++) agentReplies('s-1', 3 + i * 2, 'still working', { kind: 'status' });
    agentReplies('s-1', 27, IN_THREAD);
    const backend = titles('Retiring feature branches');

    await tick();

    expect(promptOf(backend)).toContain(`First reply: ${IN_THREAD}`);
  });
});

describe('a row that cannot be read', () => {
  const inbound = (content: string) => {
    const db = mailbox('s-bad', AGENT);
    db.prepare(`INSERT INTO messages_in VALUES ('m-bad', 3, 'chat', ?, 'pending', ?, 1)`).run(iso(Date.now()), content);
    db.close();
  };
  const outbound = (content: string) => agentReplies('s-bad', 3, '', { content });

  it.each([
    ['a null outbound row', outbound, 'null'],
    ['an outbound text with no string form', outbound, '{"text":{"toString":1,"valueOf":1}}'],
    ['a null inbound row', inbound, 'null'],
    ['an inbound text with no string form', inbound, '{"text":{"toString":1,"valueOf":1}}'],
  ])('costs only itself: %s', async (_label, write, content) => {
    discord();
    await seedRow(THREAD);
    await seedRow(OTHER_THREAD);
    await seedSession('s-bad', THREAD, AGENT, T0);
    await seedSession('s-good', OTHER_THREAD, AGENT, T0 - minutes(1));
    say('s-bad', 2, 'still readable');
    write(content);
    say('s-good', 2, 'a healthy thread');
    titles('Readable title', 'Healthy title');

    await tick();

    const healthy = await getDb().get<{ title: string }>(`SELECT title FROM sessions WHERE id = 's-good'`);
    expect(healthy?.title).toBe('Healthy title');
  });
});

describe('an answer that comes back empty', () => {
  it('backs off, so the session is not asked again every tick', async () => {
    await seedSession('s-1', OTHER_THREAD);
    say('s-1', 2, 'a question');
    const backend = titles('   ', '   ', '   ');

    await tick();
    await tick();
    await tick();

    expect(backend).toHaveBeenCalledTimes(1);
  });
});

describe('what a call relay contributes to the prompt', () => {
  it('is the words said, not the wrapper around them', async () => {
    discord();
    await seedRow(THREAD);
    await seedSession('s-1', THREAD);
    const said = 'the churn number for Q3 & why it moved';
    say('s-1', 2, groupRequestText({ speaker: 'Riley', request: said, first: true, solo: false }));
    const backend = titles('Q3 churn');

    await tick();

    const prompt = backend.mock.calls[0]![1];
    expect(prompt).toContain(said);
    expect(prompt).not.toContain('live voice call');
  });
});
