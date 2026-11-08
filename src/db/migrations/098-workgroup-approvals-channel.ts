import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `workgroups.approvals_channel`: the shared channel a card goes to when the person who asked can't answer it, as JSON
 * `{ "channelType": "<posting bot>", "platformId": "<channel>" }`. NULL keeps the DM copy, so a deploy alone changes
 * nothing.
 */
export const migration098: Migration = {
  version: 98,
  name: 'workgroup-approvals-channel',
  up(db: Database.Database) {
    const columns = new Set(
      (db.prepare('PRAGMA table_info(workgroups)').all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has('approvals_channel')) db.exec('ALTER TABLE workgroups ADD COLUMN approvals_channel TEXT');
  },
};
