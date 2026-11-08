import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getDb } from './db/connection.js';
import { closeDb, initMigratedTestDb } from './db/index.js';

const h = vi.hoisted(() => ({ adapters: new Map<string, object>() }));

vi.mock('./channels/channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./channels/channel-registry.js')>()),
  getChannelAdapter: (key: string) => h.adapters.get(key),
}));

import { trackOpenedThread } from './thread-title.js';

const OPENER = '33333333333333333';
const THREAD = `discord:11111111111111111:22222222222222222:${OPENER}`;

const rowOf = (threadId: string) =>
  getDb().get<{
    title: string | null;
    platform_name: string | null;
    title_source: string | null;
    first_message: string;
    channel_type: string;
  }>('SELECT * FROM thread_titles WHERE thread_id = ?', threadId);

function discord(name = 'Thread 10/1/2026, 12:00:00 PM') {
  const adapter = { threadName: vi.fn(async () => name), renameThread: vi.fn() };
  h.adapters.set('discord', adapter);
  return adapter;
}

beforeEach(async () => {
  h.adapters.clear();
  await initMigratedTestDb();
});

afterEach(async () => {
  await closeDb();
});

describe('trackOpenedThread', () => {
  it('gives a thread this message opened an `auto` row, keeping the platform’s name out of the title', async () => {
    discord();

    await trackOpenedThread('discord', THREAD, 'the opener', OPENER);

    await vi.waitFor(async () =>
      expect(await rowOf(THREAD)).toMatchObject({
        title: null,
        platform_name: 'Thread 10/1/2026, 12:00:00 PM',
        title_source: 'auto',
        first_message: 'the opener',
        channel_type: 'discord',
      }),
    );
  });

  it('gives no row to a thread this message did not open, so a human-made thread is never touched', async () => {
    const platform = discord();

    await trackOpenedThread('discord', THREAD, 'a reply in a thread', '44444444444444444');

    expect(await rowOf(THREAD)).toBeUndefined();
    expect(platform.threadName).not.toHaveBeenCalled();
  });

  it('gives no row on a platform whose threads have no name', async () => {
    h.adapters.set('slack', { channelType: 'slack' });
    const thread = 'slack:C0TEST:1700000001.000100';

    await trackOpenedThread('slack', thread, 'the opener', '1700000001.000100');

    expect(await rowOf(thread)).toBeUndefined();
  });

  it('still records the row when the name cannot be read', async () => {
    const platform = discord();
    platform.threadName.mockRejectedValueOnce(new Error('Discord thread call failed: 500'));

    await trackOpenedThread('discord', THREAD, 'the opener', OPENER);
    await vi.waitFor(() => expect(platform.threadName).toHaveBeenCalled());

    expect(await rowOf(THREAD)).toMatchObject({ title: null, platform_name: null, title_source: 'auto' });
  });

  it('leaves a row that already exists alone, frozen rows included', async () => {
    const platform = discord();
    await getDb().run(
      `INSERT INTO thread_titles (thread_id, channel_type, first_message, attempts, created_at)
       VALUES (?, 'discord', 'the original opener', 5, '2026-09-01T00:00:00.000Z')`,
      THREAD,
    );

    await trackOpenedThread('discord', THREAD, 'a redelivered opener', OPENER);
    await vi.waitFor(() => expect(platform.threadName).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await rowOf(THREAD)).toMatchObject({
      title: null,
      platform_name: null,
      title_source: null,
      first_message: 'the original opener',
    });
  });
});

describe('thread_titles.title_source', () => {
  it('reads NULL on a row written the way every row before it was', async () => {
    await getDb().run(
      `INSERT INTO thread_titles (thread_id, channel_type, first_message, attempts, created_at)
       VALUES ('legacy', 'discord', 'x', 0, '2026-09-01T00:00:00.000Z')`,
    );
    expect((await rowOf('legacy'))?.title_source).toBeNull();
  });

  it('refuses a value it does not know', async () => {
    await expect(
      getDb().run(
        `INSERT INTO thread_titles (thread_id, channel_type, first_message, attempts, created_at, title_source)
         VALUES ('typo', 'discord', 'x', 0, '2026-09-01T00:00:00.000Z', 'pined')`,
      ),
    ).rejects.toThrow(/CHECK constraint/);
  });
});
