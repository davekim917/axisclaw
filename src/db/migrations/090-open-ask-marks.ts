import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * This migration's `applied` time is when the owner backstop began: asks raised before it are never alerted.
 */
export const migration090: Migration = {
  version: 90,
  name: 'open-ask-marks',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS open_ask_marks (
        ask_id      TEXT PRIMARY KEY,
        claimed_by  TEXT,
        claimed_at  TEXT,
        resolved_by TEXT,
        resolved_at TEXT,
        resolution  TEXT,
        alerted_at  TEXT,
        reminded_at TEXT
      );
      ALTER TABLE tasks ADD COLUMN needs_input_at TEXT;
    `);
  },
};
