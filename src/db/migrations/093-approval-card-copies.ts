import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * Where else an approval's card was posted, as a JSON array of `{ channel_type, platform_id, instance,
 * platform_message_id }`. A column, not a table: resolution paths delete the row before editing its cards, so the
 * copies have to travel on the row object they already hold.
 */
export const migration093: Migration = {
  version: 93,
  name: 'approval-card-copies',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE pending_approvals ADD COLUMN card_copies TEXT NOT NULL DEFAULT '[]';`);
  },
};
