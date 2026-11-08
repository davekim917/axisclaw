import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getChannelAdapter as _getChannelAdapterRaw } from '../../channels/channel-registry.js';
import { threadPermalink as _threadPermalinkRaw } from '../../dashboard/api/observatory.js';
import { closeDb, createAgentGroup, initMigratedTestDb } from '../../db/index.js';
import { createMessagingGroup, createMessagingGroupAgent } from '../../db/messaging-groups.js';
import { dispatch as _dispatchRaw } from '../dispatch.js';
import { lookup } from '../registry.js';
import './threads.js';

vi.mock('../dispatch.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../dispatch.js')>()),
  dispatch: vi.fn(),
}));
vi.mock('../../channels/channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../channels/channel-registry.js')>()),
  getChannelAdapter: vi.fn(),
}));
vi.mock('../../dashboard/api/observatory.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../dashboard/api/observatory.js')>()),
  threadPermalink: vi.fn(),
}));

const mockDispatch = vi.mocked(_dispatchRaw);
const mockGetAdapter = vi.mocked(_getChannelAdapterRaw);
const mockPermalink = vi.mocked(_threadPermalinkRaw);

const postParent = vi.fn();
const createThread = vi.fn();

async function open(args: Record<string, unknown>) {
  const cmd = lookup('threads-open')!;
  return cmd.handler(cmd.parseArgs(args), { caller: 'host' });
}

const ARGS = {
  group: 'ag-1',
  channel: '#qa-room',
  title: 'Nightly export check',
  brief: "Confirm last night's export finished and say what failed, if anything.",
  by: 'Anderton for Avery',
};

beforeEach(async () => {
  await initMigratedTestDb();
  const at = '2026-06-01T00:00:00.000Z';
  await createAgentGroup({ id: 'ag-1', name: 'ava', folder: 'ava', agent_provider: null, created_at: at });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack-acme',
    platform_id: 'slack:C0EXAMPLE1',
    name: '#qa-room',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: at,
  });
  await createMessagingGroupAgent({
    id: 'w1',
    messaging_group_id: 'mg-1',
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
  postParent.mockResolvedValue({ messageId: '1712999999.000100' });
  createThread.mockResolvedValue({ threadId: '1712999999.000100', messageId: '1713000000.000200' });
  mockGetAdapter.mockReturnValue({ postParent, createThread } as never);
  mockPermalink.mockResolvedValue('https://acme.example.test/archives/C0EXAMPLE1/p1712999999000100');
  mockDispatch.mockResolvedValue({ id: 'x', ok: true, data: { series_id: 'series-1' } });
});

afterEach(async () => {
  vi.clearAllMocks();
  await closeDb();
});

describe('ncl threads open', () => {
  it('posts who opened it, opens a thread with the brief, and wakes the agent on the brief in that thread', async () => {
    const result = await open(ARGS);

    expect(postParent).toHaveBeenCalledWith('slack:C0EXAMPLE1', 'Nightly export check — opened by Anderton for Avery');
    expect(createThread).toHaveBeenCalledWith(
      'slack:C0EXAMPLE1',
      '1712999999.000100',
      'Nightly export check',
      ARGS.brief,
    );
    const [frame, caller] = mockDispatch.mock.calls[0]!;
    expect(caller).toEqual({ caller: 'host' });
    expect(frame.command).toBe('tasks-create');
    expect(frame.args).toMatchObject({
      group: 'ag-1',
      messaging_group: 'mg-1',
      thread_id: 'slack:C0EXAMPLE1:1712999999.000100',
    });
    expect(frame.args.prompt).toContain(`Anderton for Avery opened this thread for you.`);
    expect(frame.args.prompt).toContain(`"""\n${ARGS.brief}\n"""`);
    expect(result).toEqual({
      threadId: 'slack:C0EXAMPLE1:1712999999.000100',
      threadUrl: 'https://acme.example.test/archives/C0EXAMPLE1/p1712999999000100',
      seriesId: 'series-1',
    });
  });

  it('names the thread it opened when the agent could not be woken', async () => {
    mockDispatch.mockResolvedValue({ id: 'x', ok: false, error: 'admission refused' } as never);
    await expect(open(ARGS)).rejects.toThrow(
      /Opened https:\/\/acme\.example\.test\/archives\/C0EXAMPLE1\/p1712999999000100, but the agent was not woken/,
    );
  });

  it('posts nothing in a room the agent is not wired to', async () => {
    await expect(open({ ...ARGS, channel: '#other-room' })).rejects.toThrow(/the agent is not wired to that room/);
    expect(postParent).not.toHaveBeenCalled();
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('finds the room by name whatever its case and with or without the hash', async () => {
    await open({ ...ARGS, channel: 'QA-Room' });
    expect(postParent).toHaveBeenCalledWith('slack:C0EXAMPLE1', expect.any(String));
  });

  it('names the room as it was asked for when the agent is not wired to it', async () => {
    await expect(open({ ...ARGS, channel: '#other-room' })).rejects.toThrow(
      'Could not open a thread in #other-room: the agent is not wired to that room; ' +
        '`ncl wirings list --agent-group-id <id>` shows where it is.',
    );
  });

  it('refuses a brief longer than one platform message', async () => {
    await expect(open({ ...ARGS, brief: 'x'.repeat(2001) })).rejects.toThrow(/2001 characters; the limit is 2000/);
    expect(postParent).not.toHaveBeenCalled();
  });
});
