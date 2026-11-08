import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * `title_source` says who owns a thread's name, and so whether the title sweep may change it: NULL on every row older
 * than this migration (frozen), `auto` for the sweep, `pinned` for an operator's choice, `person` once the name on the
 * platform stopped matching ours. `platform_name` holds the name a thread opened with: it is only what a first rename
 * compares against, because a platform's stand-in name is not a title and `title` is what every surface shows.
 * `sent_name` is the name the last rename sent, so a rename that landed but lost its response is not read as a person's.
 * Two columns change meaning on `auto` rows: `attempts` counted failed tries for the retry duty this replaces and now
 * counts renames, and `titled_at` is the row's last sweep turn, which carries the cooldown. The index served only that
 * retry duty.
 */
export const migration094: Migration = {
  version: 94,
  name: 'thread-title-source',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE thread_titles ADD COLUMN title_source TEXT CHECK (title_source IN ('auto', 'pinned', 'person'));
      ALTER TABLE thread_titles ADD COLUMN platform_name TEXT;
      ALTER TABLE thread_titles ADD COLUMN sent_name TEXT;
      DROP INDEX IF EXISTS idx_thread_titles_retry;
    `);
  },
};
