import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Posts a bot made in a Discord thread to carry a person's reply from the phone app. Every sibling bot receives each one
 * as a bot's message, and this is how their copies are recognised and dropped, live and when a bot catches up later.
 * The words are never kept: only a hash of the posted text, and Discord's message id once it answers.
 */
export const migration097: Migration = {
  version: 97,
  name: 'discord-relay-posts',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS discord_relay_posts (
        id           TEXT PRIMARY KEY,
        bot_user_id  TEXT NOT NULL,
        channel_id   TEXT NOT NULL,
        text_sha256  TEXT NOT NULL,
        nonce        TEXT NOT NULL,
        message_id   TEXT,
        created_at   TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_discord_relay_posts_created ON discord_relay_posts(created_at);
    `);
  },
};
