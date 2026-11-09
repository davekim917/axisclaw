import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `choice_receipts.answered_from`: `host` when the owner answered the card with `ncl approvals choose`, NULL for a
 * click on the card. Existing rows were all clicks, so they stay NULL.
 */
export const migration099: Migration = {
  version: 99,
  name: 'choice-receipt-answered-from',
  up(db: Database.Database) {
    const columns = db.prepare("PRAGMA table_info('choice_receipts')").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === 'answered_from')) {
      db.exec('ALTER TABLE choice_receipts ADD COLUMN answered_from TEXT');
    }
  },
};
