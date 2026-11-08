import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * A receipt's `created_at` is its first send attempt and survives a failed send and its retry; `delivered_at` is when
 * the post actually landed. Receipts written before this have none.
 */
export const migration091: Migration = {
  version: 91,
  name: 'work-outcome-delivered-at',
  up(db: Database.Database) {
    db.exec(`ALTER TABLE work_outcome_receipts ADD COLUMN delivered_at TEXT;`);
  },
};
