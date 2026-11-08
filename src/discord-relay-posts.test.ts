import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initMigratedTestDb } from './db/index.js';
import { getDb } from './db/connection.js';
import {
  _resetRelayPostsForTest,
  confirmRelayPost,
  forgetRelayPost,
  isRelayCopy,
  loadRelayPosts,
  recordRelayPost,
} from './discord-relay-posts.js';

const BOT = '111111111111111111';
const THREAD = '333333333333333333';
const TEXT = '**Ana Example** · from the Anderton app\nOn it.';

const post = { botUserId: BOT, channelId: THREAD, text: TEXT, nonce: 'nonce-example-01' };
/** What a sibling bot receives: the posting bot's message, live (with its nonce) or caught up later (without). */
const copy = (overrides: Partial<Parameters<typeof isRelayCopy>[0]> = {}) =>
  isRelayCopy({ authorId: BOT, channelId: THREAD, messageId: '555555555555555555', content: TEXT, ...overrides });

beforeEach(async () => {
  _resetRelayPostsForTest();
  await initMigratedTestDb();
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
});

describe('a reply the host posted for someone', () => {
  it('is known before Discord answers, by its nonce or its text, and only from that bot where it posted', async () => {
    await recordRelayPost(post);

    expect([copy({ content: 'edited away', nonce: post.nonce }), copy({ content: `  ${TEXT}\n` })]).toEqual([
      true,
      true,
    ]);
    expect([
      copy({ authorId: '222222222222222222' }),
      copy({ channelId: '444444444444444444' }),
      copy({ content: 'Something else.' }),
    ]).toEqual([false, false, false]);
  });

  it('once Discord answers, is known only by its message id, so the bot can later post the same words', async () => {
    const id = await recordRelayPost(post);
    await confirmRelayPost(id, '666666666666666666');

    expect([copy({ messageId: '666666666666666666' }), copy(), copy({ nonce: post.nonce })]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('is forgotten when Discord refused it, so nothing of the bot’s is dropped for it', async () => {
    await forgetRelayPost(await recordRelayPost(post));

    expect(copy({ nonce: post.nonce })).toBe(false);
    expect(await getDb().all('SELECT * FROM discord_relay_posts')).toEqual([]);
  });

  it('is still known after a restart, for a bot catching up on what it missed, for a week', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const id = await recordRelayPost(post);
    await confirmRelayPost(id, '666666666666666666');
    vi.setSystemTime(Date.now() + 6 * 24 * 60 * 60_000);
    await recordRelayPost({ ...post, text: 'A later reply.', nonce: 'nonce-example-02' });

    _resetRelayPostsForTest();
    await loadRelayPosts();
    const known = () => [copy({ messageId: '666666666666666666' }), copy({ content: 'A later reply.' })];
    expect(known()).toEqual([true, true]);

    vi.setSystemTime(Date.now() + 2 * 24 * 60 * 60_000);
    _resetRelayPostsForTest();
    await loadRelayPosts();
    expect(known()).toEqual([false, true]);
    await recordRelayPost({ ...post, text: 'Another.', nonce: 'nonce-example-03' });
    expect(await getDb().all('SELECT nonce FROM discord_relay_posts ORDER BY nonce')).toEqual([
      { nonce: 'nonce-example-02' },
      { nonce: 'nonce-example-03' },
    ]);
  });

  it('is loaded by the next bot to start when an earlier load failed', async () => {
    await recordRelayPost(post);
    _resetRelayPostsForTest();
    await getDb().run('ALTER TABLE discord_relay_posts RENAME TO discord_relay_posts_held');
    await loadRelayPosts();
    expect(copy()).toBe(false);

    await getDb().run('ALTER TABLE discord_relay_posts_held RENAME TO discord_relay_posts');
    await loadRelayPosts();
    expect(copy()).toBe(true);
  });

  it('keeps what this process wrote over an older read of the table that a load lands later', async () => {
    const confirmed = await recordRelayPost(post);
    await confirmRelayPost(confirmed, '666666666666666666');
    const refused = await recordRelayPost({ ...post, text: 'Refused.', nonce: 'nonce-example-04' });
    await forgetRelayPost(refused);
    await getDb().run('UPDATE discord_relay_posts SET message_id = NULL WHERE id = ?', confirmed);
    await getDb().run(
      `INSERT INTO discord_relay_posts (id, bot_user_id, channel_id, text_sha256, nonce, created_at)
       VALUES (?, ?, ?, 'stale', 'nonce-example-04', ?)`,
      refused,
      BOT,
      THREAD,
      new Date().toISOString(),
    );

    await loadRelayPosts();

    expect([copy({ messageId: '666666666666666666', content: 'edited' }), copy({ nonce: 'nonce-example-04' })]).toEqual(
      [true, false],
    );
  });

  it('keeps only a hash of the words', async () => {
    await recordRelayPost(post);

    const rows = JSON.stringify(await getDb().all('SELECT * FROM discord_relay_posts'));
    expect(rows).not.toContain('On it');
    expect(rows).not.toContain('Ana Example');
  });
});
