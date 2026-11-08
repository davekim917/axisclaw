/**
 * Posts a bot makes in a Discord thread to carry a person's words, which already reach the addressed agent as that
 * person's own message. Every sibling bot also receives each post, as a bot's message, live or when it catches up after
 * a gap. This module alone writes and reads the record that lets the Discord inbound filter drop those copies.
 *
 * The filter runs synchronously, so the record is served from memory. The table carries it across a restart, loaded
 * before any Discord adapter connects. Only a hash of the posted text is kept, never the text.
 */
import { createHash, randomUUID } from 'crypto';

import { getDb } from './db/connection.js';
import { log } from './log.js';

/** Longer than a bot plausibly stays down and still catches up on what it missed. */
const KEEP_MS = 7 * 24 * 60 * 60_000;

interface RelayPost {
  botUserId: string;
  channelId: string;
  textSha256: string;
  nonce: string;
  messageId: string | null;
  createdAtMs: number;
}

const posts = new Map<string, RelayPost>();
/** Deleted while a load may hold an older read of the table, which must not bring them back. */
const forgotten = new Set<string>();
let loading: Promise<void> | null = null;

/** Discord trims what it stores, so both sides hash the trimmed text. */
const hashOf = (text: string) => createHash('sha256').update(text.trim()).digest('hex');

function prune(now: number): void {
  for (const [id, post] of posts) if (post.createdAtMs < now - KEEP_MS) posts.delete(id);
}

/**
 * Once per process. A failure never blocks Discord: it logs, leaves older posts' copies undetected, and lets the next
 * bot to start try again.
 */
export function loadRelayPosts(): Promise<void> {
  loading ??= (async () => {
    const since = new Date(Date.now() - KEEP_MS).toISOString();
    const rows = await getDb().all<{
      id: string;
      bot_user_id: string;
      channel_id: string;
      text_sha256: string;
      nonce: string;
      message_id: string | null;
      created_at: string;
    }>('SELECT * FROM discord_relay_posts WHERE created_at >= ?', since);
    for (const row of rows) {
      if (posts.has(row.id) || forgotten.has(row.id)) continue;
      posts.set(row.id, {
        botUserId: row.bot_user_id,
        channelId: row.channel_id,
        textSha256: row.text_sha256,
        nonce: row.nonce,
        messageId: row.message_id,
        createdAtMs: Date.parse(row.created_at),
      });
    }
    forgotten.clear();
  })().catch((err: unknown) => {
    loading = null;
    log.error('Discord relay posts could not be loaded; sibling copies of earlier ones may reach agents', { err });
  });
  return loading;
}

/** Before the post is sent, so a copy that arrives ahead of Discord's answer is already known. */
export async function recordRelayPost(input: {
  botUserId: string;
  channelId: string;
  text: string;
  nonce: string;
}): Promise<string> {
  const id = randomUUID();
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const textSha256 = hashOf(input.text);
  await getDb().run(
    `INSERT INTO discord_relay_posts (id, bot_user_id, channel_id, text_sha256, nonce, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    id,
    input.botUserId,
    input.channelId,
    textSha256,
    input.nonce,
    createdAt,
  );
  await getDb().run('DELETE FROM discord_relay_posts WHERE created_at < ?', new Date(now - KEEP_MS).toISOString());
  prune(now);
  const { botUserId, channelId, nonce } = input;
  posts.set(id, { botUserId, channelId, nonce, textSha256, messageId: null, createdAtMs: now });
  return id;
}

export async function confirmRelayPost(id: string, messageId: string): Promise<void> {
  const post = posts.get(id);
  if (post) post.messageId = messageId;
  await getDb().run('UPDATE discord_relay_posts SET message_id = ? WHERE id = ?', messageId, id);
}

export async function forgetRelayPost(id: string): Promise<void> {
  posts.delete(id);
  forgotten.add(id);
  await getDb().run('DELETE FROM discord_relay_posts WHERE id = ?', id);
}

export interface DiscordCopy {
  authorId: string;
  /** The channel or thread the message is in. */
  channelId: string;
  messageId: string;
  content: string;
  nonce?: unknown;
}

/**
 * A post not yet answered matches by its nonce, which Discord passes on with the live event, or by its text; once
 * answered, only by its message id. Only a message by the bot that made the post, where it made it, can match.
 */
export function isRelayCopy(copy: DiscordCopy): boolean {
  for (const post of posts.values()) {
    if (post.botUserId !== copy.authorId || post.channelId !== copy.channelId) continue;
    if (post.messageId !== null) {
      if (post.messageId === copy.messageId) return true;
    } else if (copy.nonce === post.nonce || hashOf(copy.content) === post.textSha256) {
      return true;
    }
  }
  return false;
}

export function _resetRelayPostsForTest(): void {
  posts.clear();
  forgotten.clear();
  loading = null;
}
