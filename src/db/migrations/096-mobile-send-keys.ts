import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * A device's second key, which only sends and is only issued for a one-time claim the person's own sign-in or DM
 * handed to that device. Like the read key, only its hash is kept. Deleting the row revokes both.
 */
export const migration096: Migration = {
  version: 96,
  name: 'mobile-send-keys',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE mobile_devices ADD COLUMN send_key_hash TEXT;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_mobile_devices_send_key ON mobile_devices(send_key_hash);
    `);
  },
};
