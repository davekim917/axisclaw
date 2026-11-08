import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * One row per paired phone. A device speaks for exactly one user id, and only the hash of its key is kept. No foreign
 * key on `user_id`: every request re-reads the user, so a row outliving its user stops working on its own.
 */
export const migration092: Migration = {
  version: 92,
  name: 'mobile-devices',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mobile_devices (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        key_hash   TEXT NOT NULL UNIQUE,
        label      TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_mobile_devices_user ON mobile_devices(user_id);
    `);
  },
};
