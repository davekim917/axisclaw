/**
 * `ncl threads rename` through the real dispatcher and guard, as a container's request reaches it. Only the channel
 * adapters are fake.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ChannelRateLimitedError } from '../../channels/adapter.js';
import { getDb } from '../../db/connection.js';
import { ensureContainerConfig } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, initMigratedTestDb } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';

const h = vi.hoisted(() => ({ adapters: new Map<string, object>() }));

vi.mock('../../channels/channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../channels/channel-registry.js')>()),
  getChannelAdapter: (key: string) => h.adapters.get(key),
}));

import '../commands/index.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext, ResponseFrame } from '../frame.js';
import { listCommands } from '../registry.js';

const AT = '2026-10-01T12:00:00.000Z';
const HERE = 'discord:111:222:333';
const ELSEWHERE = 'discord:111:222:444';
const SLACK_THREAD = 'slack:C0TEST:1700000001.000100';

const agentAt = (sessionId: string): CallerContext => ({
  caller: 'agent',
  sessionId,
  agentGroupId: 'ag-1',
  messagingGroupId: 'mg-discord',
});

let nextRequest = 0;
const run = (command: string, args: Record<string, unknown>, ctx: CallerContext = agentAt('s-here')) =>
  dispatch({ id: `req-${++nextRequest}`, command, args }, ctx);
const rename = (title: unknown, sessionId = 's-here') => run('threads-rename', { title }, agentAt(sessionId));

const messageOf = (res: ResponseFrame) => (res.ok ? undefined : res.error.message);
const codeOf = (res: ResponseFrame) => (res.ok ? undefined : res.error.code);

interface Row {
  title: string | null;
  title_source: string | null;
  channel_type: string;
}

const rowOf = (threadId: string) => getDb().get<Row>('SELECT * FROM thread_titles WHERE thread_id = ?', threadId);

function discordBot(key = 'discord') {
  const adapter = { renameThread: vi.fn(async (_threadId: string, name: string) => name) };
  h.adapters.set(key, adapter);
  return adapter;
}

async function seedRow(threadId: string, title: string | null, source: string | null, channelType = 'discord') {
  await getDb().run(
    `INSERT INTO thread_titles (thread_id, channel_type, title, first_message, attempts, created_at, title_source)
     VALUES (?, ?, ?, 'the opener', 0, ?, ?)`,
    threadId,
    channelType,
    title,
    AT,
    source,
  );
}

async function seedSession(id: string, threadId: string | null, messagingGroupId: string | null): Promise<void> {
  await createSession({
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: messagingGroupId,
    thread_id: threadId,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: AT,
    created_at: AT,
  });
}

async function seedChannel(id: string, channelType: string, platformId: string): Promise<void> {
  await createMessagingGroup({
    id,
    channel_type: channelType,
    platform_id: platformId,
    name: '#general',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: AT,
  });
}

beforeEach(async () => {
  h.adapters.clear();
  await initMigratedTestDb();
  await createAgentGroup({ id: 'ag-1', name: 'Pixel', folder: 'pixel', agent_provider: null, created_at: AT });
  await seedChannel('mg-discord', 'discord', 'discord:111:222');
  await seedChannel('mg-slack', 'slack', 'slack:C0TEST');
  await seedSession('s-here', HERE, 'mg-discord');
  await seedSession('s-elsewhere', ELSEWHERE, 'mg-discord');
  await seedSession('s-slack', SLACK_THREAD, 'mg-slack');
});

afterEach(async () => {
  await closeDb();
  vi.unstubAllGlobals();
});

describe('what the command can reach', () => {
  it('renames the thread of the calling session at group scope, and no other', async () => {
    const platform = discordBot();
    await seedRow(ELSEWHERE, 'Another thread', 'auto');

    const res = await rename('Budget review');

    expect(res).toMatchObject({ ok: true, human: 'Renamed this thread to "Budget review".' });
    expect(platform.renameThread.mock.calls).toEqual([[HERE, 'Budget review']]);
    expect(await rowOf(ELSEWHERE)).toMatchObject({ title: 'Another thread', title_source: 'auto' });
  });

  it.each([
    ['--id with a thread', 'threads-rename', { id: ELSEWHERE }],
    ['--id with a session', 'threads-rename', { id: 's-elsewhere' }],
    ['--thread', 'threads-rename', { thread: ELSEWHERE }],
    ['--thread-id', 'threads-rename', { 'thread-id': ELSEWHERE }],
    ['--session', 'threads-rename', { session: 's-elsewhere' }],
    ['a positional target', 'threads-rename-s-elsewhere', {}],
  ])('refuses %s, so it cannot name another thread', async (_how, command, extra) => {
    const platform = discordBot();
    await seedRow(ELSEWHERE, 'Another thread', 'auto');

    const res = await run(command, { title: 'Hijacked', ...extra });

    expect(res.ok).toBe(false);
    expect(platform.renameThread).not.toHaveBeenCalled();
    expect(await rowOf(ELSEWHERE)).toMatchObject({ title: 'Another thread', title_source: 'auto' });
    expect(await rowOf(HERE)).toBeUndefined();
  });

  it('refuses every other threads verb at group scope', async () => {
    const others = listCommands().filter((cmd) => cmd.resource === 'threads' && cmd.name !== 'threads-rename');
    expect(others.map((cmd) => cmd.name).sort()).toEqual(['threads-help', 'threads-open']);

    for (const cmd of others) {
      expect(codeOf(await run(cmd.name, {})), cmd.name).toBe('forbidden');
    }
  });

  it('is refused when the group has the CLI disabled', async () => {
    discordBot();
    await ensureContainerConfig('ag-1');
    await getDb().run(`UPDATE container_configs SET cli_scope = 'disabled' WHERE agent_group_id = 'ag-1'`);

    expect(codeOf(await rename('Budget review'))).toBe('forbidden');
  });

  it('needs an agent session: the host has no thread of its own', async () => {
    discordBot();

    const res = await run('threads-rename', { title: 'Budget review' }, { caller: 'host' });

    expect(messageOf(res)).toBe('Only an agent session can rename its thread.');
  });

  it('shows up in help at group scope as the one threads verb it is', async () => {
    const res = await run('help', {});

    expect(res).toMatchObject({ ok: true });
    const help = (res as { data: string }).data;
    const verbsLine =
      help.split('\n')[help.split('\n').findIndex((line) => line.trimStart().startsWith('threads ')) + 1];
    expect(verbsLine?.trim()).toBe('verbs: rename');
  });

  it('answers --help at group scope', async () => {
    const res = await run('threads-rename', { help: true });

    expect((res as { data: string }).data).toContain('--title');
  });
});

describe('the name it leaves', () => {
  it.each([
    ['an `auto` row', 'Generated title', 'auto'],
    ['a frozen row', 'An old name', null],
    ['a row a person named', 'A person’s name', 'person'],
    ['a row pinned before', 'An earlier pin', 'pinned'],
  ])('beats %s', async (_name, title, source) => {
    discordBot();
    await seedRow(HERE, title, source);

    await rename('Budget review');

    expect(await rowOf(HERE)).toMatchObject({ title: 'Budget review', title_source: 'pinned' });
  });

  it('makes a row for a thread that had none', async () => {
    discordBot();

    await rename('Budget review');

    expect(await rowOf(HERE)).toMatchObject({
      title: 'Budget review',
      title_source: 'pinned',
      channel_type: 'discord',
    });
  });

  it('stores the name the platform stored', async () => {
    discordBot().renameThread.mockResolvedValueOnce('budget review');

    await rename('Budget Review');

    expect((await rowOf(HERE))?.title).toBe('budget review');
  });
});

describe('which bot renames', () => {
  it('is the one on the thread’s row, not the primary bot', async () => {
    const primary = discordBot();
    const sibling = discordBot('discord-example');
    await seedRow(HERE, 'Generated title', 'auto', 'discord-example');

    await rename('Budget review');

    expect(primary.renameThread).not.toHaveBeenCalled();
    expect(sibling.renameThread).toHaveBeenCalledTimes(1);
    expect((await rowOf(HERE))?.channel_type).toBe('discord-example');
  });

  it('is the session’s own, when the thread has no row', async () => {
    const primary = discordBot();
    const sibling = discordBot('discord-example');
    await seedChannel('mg-sibling', 'discord-example', 'discord:111:555');
    await seedSession('s-sibling', 'discord:111:555:666', 'mg-sibling');

    await rename('Budget review', 's-sibling');

    expect(primary.renameThread).not.toHaveBeenCalled();
    expect(sibling.renameThread).toHaveBeenCalledTimes(1);
  });
});

describe('when the platform says no', () => {
  it('passes a 429 and its wait to the agent, and the row keeps its name', async () => {
    discordBot().renameThread.mockRejectedValueOnce(new ChannelRateLimitedError(7 * 60_000));
    await seedRow(HERE, 'Generated title', 'auto');

    const res = await rename('Budget review');

    expect(messageOf(res)).toBe(
      'The thread keeps its name. The platform is limiting renames here. Try again in about 7 minutes.',
    );
    expect(await rowOf(HERE)).toMatchObject({ title: 'Generated title', title_source: 'auto' });
  });

  it('says a short wait in seconds', async () => {
    discordBot().renameThread.mockRejectedValueOnce(new ChannelRateLimitedError(1_500));

    expect(messageOf(await rename('Budget review'))).toContain('about 2 seconds');
  });

  it('passes a refusal to the agent, and writes no row for a thread that had none', async () => {
    const refusal = 'Discord refused: this bot needs the Manage Threads permission.';
    discordBot().renameThread.mockRejectedValueOnce(new Error(refusal));

    const res = await rename('Budget review');

    expect(messageOf(res)).toBe(`The thread keeps its name. ${refusal}`);
    expect(await rowOf(HERE)).toBeUndefined();
  });

  it('says so when the channel is offline, rather than claiming the name', async () => {
    const res = await rename('Budget review');

    expect(messageOf(res)).toContain('offline');
    expect(await rowOf(HERE)).toBeUndefined();
  });
});

describe('on a platform whose threads have no name', () => {
  it('updates the row with no platform call, and says the change is in the app list only', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const deliver = vi.fn();
    h.adapters.set('slack', { deliver });

    const res = await rename('Budget review', 's-slack');

    expect(res).toMatchObject({
      ok: true,
      data: { title: 'Budget review', appOnly: true },
      human: 'Set the title to "Budget review" in the app list only. Threads here have no name of their own to change.',
    });
    expect(await rowOf(SLACK_THREAD)).toMatchObject({ title: 'Budget review', title_source: 'pinned' });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(deliver).not.toHaveBeenCalled();
  });
});

describe('outside a thread', () => {
  it.each([
    ['a channel session', 's-channel', null, 'mg-discord'],
    ['an agent-shared session', 's-shared', null, null],
    ['a scheduled task session', 's-task', 'system:tasks:series-1', null],
  ])('refuses %s', async (_name, sessionId, threadId, messagingGroupId) => {
    const platform = discordBot();
    await seedSession(sessionId, threadId, messagingGroupId);

    const res = await rename('Budget review', sessionId);

    expect(messageOf(res)).toBe('This conversation is not in a thread, so there is no thread to rename.');
    expect(platform.renameThread).not.toHaveBeenCalled();
  });
});

describe('the title it takes', () => {
  it('holds 100 characters and refuses 101', async () => {
    discordBot();

    expect((await rename('a'.repeat(100))).ok).toBe(true);

    const res = await rename('a'.repeat(101));
    expect(messageOf(res)).toContain('--title is 101 characters; the limit is 100.');
    expect((await rowOf(HERE))?.title).toBe('a'.repeat(100));
  });

  it('counts characters, so an emoji is one', async () => {
    discordBot();

    expect((await rename('😀'.repeat(100))).ok).toBe(true);
  });

  it('counts what it would send, after neutralizing', async () => {
    discordBot();

    expect(messageOf(await rename(`@everyone ${'a'.repeat(90)}`))).toContain('--title is 101 characters');
  });

  it.each([['   '], ['\n\t ']])('refuses a blank title', async (title) => {
    const platform = discordBot();

    expect(messageOf(await rename(title))).toContain('--title must not be empty.');
    expect(platform.renameThread).not.toHaveBeenCalled();
  });

  it('refuses a title that is not text, rather than naming the thread after its object form', async () => {
    const platform = discordBot();

    expect(messageOf(await rename({ name: 'Nightly export review' }))).toContain('--title must be a string');
    expect(platform.renameThread).not.toHaveBeenCalled();
  });

  it('refuses no title at all', async () => {
    discordBot();

    expect(messageOf(await run('threads-rename', {}))).toContain('--title is required');
  });

  it('trims it, folds its lines, and neutralizes every kind of mention', async () => {
    const platform = discordBot();

    await rename('  ask @everyone\nand <@123> <!here>  ');

    const sent = 'ask @​everyone and <​@​123> <​!here>';
    expect(platform.renameThread.mock.calls).toEqual([[HERE, sent]]);
    expect((await rowOf(HERE))?.title).toBe(sent);
  });
});
