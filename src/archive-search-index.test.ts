import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  archiveDedupMatch,
  archivePartitionId,
  archiveSearchReady,
  archiveSearchTable,
  migrateArchiveSearch,
  type ArchiveTenancy,
} from './archive-search-index.js';
import { ARCHIVE_UPSERT_SQL, initArchiveSchema, writeArchiveRow, type ArchiveRowBindings } from './message-archive.js';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  initArchiveSchema(db);
});

afterEach(() => {
  db.close();
});

function row(overrides: Partial<ArchiveRowBindings> = {}): ArchiveRowBindings {
  return {
    id: 'm1',
    agentGroupId: 'ag-a',
    messagingGroupId: 'mg-1',
    channelType: 'slack',
    channelName: null,
    platformId: 'slack:C1',
    threadId: 'slack:C1:1.0',
    role: 'user',
    senderId: 'slack:U1',
    senderName: 'Ana Example',
    senderIsBot: 0,
    text: 'the zeppelin landed',
    sentAt: '2026-06-01T00:00:00.000Z',
    ...overrides,
  };
}

const ACME: ArchiveTenancy = { workgroupId: 'acme' };
const GLOBEX: ArchiveTenancy = { workgroupId: 'globex' };

/** Archive ids found for a word in one tenant's table. */
function found(word: string, tenantKey: string): string[] {
  const partition = archivePartitionId(db, tenantKey);
  if (partition === undefined) return [];
  const table = archiveSearchTable(partition);
  return (
    db
      .prepare(`SELECT a.id FROM ${table} p JOIN messages_archive a ON a.rowid = p.rowid WHERE ${table} MATCH ?`)
      .all(`text : "${word}"`) as Array<{ id: string }>
  )
    .map((hit) => hit.id)
    .sort();
}

const indexedCount = (tenantKey: string) =>
  (
    db.prepare(`SELECT COUNT(*) AS n FROM ${archiveSearchTable(archivePartitionId(db, tenantKey)!)}`).get() as {
      n: number;
    }
  ).n;

describe('the archive writer', () => {
  it('indexes a message once per tenant, whichever agents archived it', () => {
    writeArchiveRow(db, row({ id: '1:ag-a' }), ACME);
    writeArchiveRow(db, row({ id: '1:ag-a2', agentGroupId: 'ag-a2' }), ACME);
    writeArchiveRow(db, row({ id: '1:ag-b', agentGroupId: 'ag-b' }), GLOBEX);

    expect(indexedCount('workgroup:acme')).toBe(1);
    expect(indexedCount('workgroup:globex')).toBe(1);
    expect(found('zeppelin', 'workgroup:acme')).toEqual(['1:ag-a']);
  });

  it('indexes sibling bots’ copies of a message once, findable by either bot’s name for the sender', () => {
    const onBot = (bot: string, agentGroupId: string, senderName: string, sender = 'U1') =>
      row({
        id: `1:${agentGroupId}`,
        agentGroupId,
        messagingGroupId: `mg-${bot}`,
        channelType: bot,
        platformId: 'discord:G1:C1',
        threadId: 'discord:G1:C1:T1',
        senderId: `${bot}:${sender}`,
        senderName,
      });
    writeArchiveRow(db, onBot('discord', 'ag-a', 'Ana Example'), ACME);
    writeArchiveRow(db, onBot('discord-codex', 'ag-a2', 'ana.example'), ACME);
    writeArchiveRow(db, onBot('discord-codex', 'ag-a3', 'Bea Example', 'U2'), ACME);
    const table = archiveSearchTable(archivePartitionId(db, 'workgroup:acme')!);
    const named = (name: string) =>
      db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get(`sender_name : "${name}"`);

    expect(indexedCount('workgroup:acme')).toBe(2);
    expect(named('ana.example')).toEqual({ n: 1 });
    expect(named('Ana Example')).toEqual({ n: 1 });
  });

  it('finds a message’s copies through an index, not by reading the archive', () => {
    const plan = (sql: string, ...params: object[]) =>
      (db.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as Array<{ detail: string }>).map((step) => step.detail);
    const byIndex = expect.stringMatching(/^SEARCH r USING INDEX idx_archive_message /);

    expect(
      plan(`SELECT rowid FROM messages_archive r WHERE ${archiveDedupMatch('r')}`, {
        platform_id: 'discord:G1:C1',
        sent_at: '2026-06-01T00:00:00.000Z',
        thread_id: null,
        role: 'user',
        sender_id: 'discord:U1',
        text: 'the zeppelin landed',
      }),
    ).toContainEqual(byIndex);
    expect(
      plan(
        `SELECT r.rowid FROM messages_archive hit JOIN messages_archive r ON ${archiveDedupMatch('r', 'hit')}
          WHERE hit.rowid = 1`,
      ),
    ).toContainEqual(byIndex);
  });

  it('gives an agent group with no workgroup a tenant of its own', () => {
    writeArchiveRow(db, row(), { workgroupId: null });

    expect(found('zeppelin', 'agent-group:ag-a')).toEqual(['m1']);
    expect(found('zeppelin', 'workgroup:acme')).toEqual([]);
  });

  it('lets a copy stand in when the indexed row is edited, and indexes the edit', () => {
    writeArchiveRow(db, row({ id: '1:ag-a' }), ACME);
    writeArchiveRow(db, row({ id: '1:ag-a2', agentGroupId: 'ag-a2' }), ACME);

    writeArchiveRow(db, row({ id: '1:ag-a', text: 'the airship landed' }), ACME);

    expect(found('zeppelin', 'workgroup:acme')).toEqual(['1:ag-a2']);
    expect(found('airship', 'workgroup:acme')).toEqual(['1:ag-a']);
  });

  it('re-indexes a row whose sender name changes', () => {
    writeArchiveRow(db, row(), ACME);

    writeArchiveRow(db, row({ senderName: 'Bea Example' }), ACME);
    const table = archiveSearchTable(archivePartitionId(db, 'workgroup:acme')!);

    expect(db.prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${table} MATCH ?`).get('sender_name : "bea"')).toEqual({
      n: 1,
    });
    expect(indexedCount('workgroup:acme')).toBe(1);
  });

  it('indexes a moved agent group’s new messages in its new tenant and leaves its earlier ones, edits included', () => {
    writeArchiveRow(db, row({ id: 'before' }), ACME);
    writeArchiveRow(db, row({ id: 'after', threadId: 'slack:C1:2.0', text: 'the zeppelin left' }), GLOBEX);
    writeArchiveRow(db, row({ id: 'before', text: 'the zeppelin landed, edited' }), GLOBEX);

    expect(found('zeppelin', 'workgroup:acme')).toEqual(['before']);
    expect(found('zeppelin', 'workgroup:globex')).toEqual(['after']);
  });

  it('indexes nothing for an agent group the central DB does not hold', () => {
    writeArchiveRow(db, row(), undefined);

    expect(db.prepare('SELECT COUNT(*) AS n FROM messages_archive').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_search_rows').get()).toEqual({ n: 0 });
  });
});

describe('one transaction', () => {
  it('leaves the archive as it was when its index cannot be updated', () => {
    writeArchiveRow(db, row({ id: 'first' }), ACME);
    db.exec(`DROP TABLE ${archiveSearchTable(archivePartitionId(db, 'workgroup:acme')!)}`);

    expect(() => writeArchiveRow(db, row({ id: 'second', threadId: 'other' }), ACME)).toThrow();
    expect(db.prepare('SELECT id FROM messages_archive ORDER BY id').all()).toEqual([{ id: 'first' }]);
  });

  it('creates a tenant’s table again on the same connection after the write that created it rolled back', () => {
    expect(() =>
      db.transaction(() => {
        writeArchiveRow(db, row(), ACME);
        throw new Error('disk full');
      })(),
    ).toThrow('disk full');
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name GLOB 'archive_search_p[0-9]*'`).all()).toEqual([]);

    writeArchiveRow(db, row(), ACME);

    expect(found('zeppelin', 'workgroup:acme')).toEqual(['m1']);
  });

  it('waits for another connection’s write to commit instead of failing at once', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-lock-'));
    const file = path.join(dir, 'archive.db');
    const host = new Database(file);
    try {
      host.pragma('journal_mode = TRUNCATE');
      initArchiveSchema(host);
      writeArchiveRow(host, row({ id: 'first' }), ACME);
      // Another connection holds the write lock for a moment, then commits.
      const other = new Worker(
        `const Database = require('better-sqlite3');
         const { parentPort, workerData } = require('node:worker_threads');
         const db = new Database(workerData);
         db.exec('BEGIN IMMEDIATE');
         db.prepare("UPDATE messages_archive SET channel_name = 'held' WHERE id = 'first'").run();
         parentPort.postMessage('holding');
         Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200);
         db.exec('COMMIT');
         db.close();`,
        { eval: true, workerData: file },
      );
      const exited = new Promise((resolve) => other.once('exit', resolve));
      await new Promise((resolve) => other.once('message', resolve));

      writeArchiveRow(host, row({ id: 'second', threadId: 'other' }), ACME);
      await exited;

      expect(host.prepare('SELECT id, channel_name FROM messages_archive ORDER BY id').all()).toEqual([
        { id: 'first', channel_name: 'held' },
        { id: 'second', channel_name: null },
      ]);
    } finally {
      host.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** An archive as the global index left it: the same rows, one FTS table over all of them, no partitions yet. */
function legacyArchive(rows: ArchiveRowBindings[]): void {
  db.close();
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE messages_archive (
      id TEXT PRIMARY KEY, agent_group_id TEXT NOT NULL, messaging_group_id TEXT, channel_type TEXT NOT NULL,
      channel_name TEXT, platform_id TEXT, thread_id TEXT, role TEXT NOT NULL, sender_id TEXT, sender_name TEXT,
      text TEXT NOT NULL, sent_at TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')),
      sender_is_bot INTEGER
    );
    CREATE VIRTUAL TABLE messages_archive_fts USING fts5(
      text, sender_name, content='messages_archive', content_rowid='rowid'
    );
    CREATE TRIGGER messages_archive_ai AFTER INSERT ON messages_archive BEGIN
      INSERT INTO messages_archive_fts(rowid, text, sender_name) VALUES (new.rowid, new.text, new.sender_name);
    END;
    CREATE TRIGGER messages_archive_ad AFTER DELETE ON messages_archive BEGIN
      INSERT INTO messages_archive_fts(messages_archive_fts, rowid, text, sender_name)
      VALUES ('delete', old.rowid, old.text, old.sender_name);
    END;
    CREATE TRIGGER messages_archive_au AFTER UPDATE ON messages_archive BEGIN
      INSERT INTO messages_archive_fts(messages_archive_fts, rowid, text, sender_name)
      VALUES ('delete', old.rowid, old.text, old.sender_name);
      INSERT INTO messages_archive_fts(rowid, text, sender_name) VALUES (new.rowid, new.text, new.sender_name);
    END;
  `);
  const upsert = db.prepare(ARCHIVE_UPSERT_SQL);
  for (const r of rows) upsert.run(r);
  initArchiveSchema(db);
}

const legacyRows = [
  ...Array.from({ length: 7 }, (_, at) =>
    row({ id: `m${at}`, agentGroupId: at % 2 ? 'ag-b' : 'ag-a', threadId: `t${at}`, text: `zeppelin number ${at}` }),
  ),
  row({ id: 'gone', agentGroupId: 'ag-gone', threadId: 't-gone', text: 'zeppelin number gone' }),
];
const members = [
  { agentGroupId: 'ag-a', workgroupId: 'acme' },
  { agentGroupId: 'ag-b', workgroupId: 'globex' },
];

/** The archive ids the global index finds for a word, as the code before the partitions searched it. */
const globalHits = (word: string): string[] =>
  (
    db
      .prepare(
        `SELECT a.id FROM messages_archive_fts f JOIN messages_archive a ON a.rowid = f.rowid
          WHERE messages_archive_fts MATCH ?`,
      )
      .all(`text : "${word}"`) as Array<{ id: string }>
  )
    .map((hit) => hit.id)
    .sort();

/** FTS5 compares the external-content index with every archive row when the check is given rank 1. */
const globalIndexMatchesArchive = () =>
  db.exec(`INSERT INTO messages_archive_fts(messages_archive_fts, rank) VALUES ('integrity-check', 1)`);

/** Runs the migration until the host dies at the start of the first transaction after it placed some rows. */
function crashAfterOneChunk(crashMembers: typeof members): void {
  const transaction = db.transaction.bind(db);
  const placed = () => (db.prepare('SELECT COUNT(*) AS n FROM archive_search_rows').get() as { n: number }).n;
  db.transaction = ((fn: (...args: never[]) => unknown) => {
    const wrapped = transaction(fn);
    const counted =
      (run: (...args: never[]) => unknown) =>
      (...args: never[]) => {
        if (placed() > 0) throw new Error('host killed');
        return run(...args);
      };
    return Object.assign(counted(wrapped), {
      deferred: counted(wrapped.deferred),
      immediate: counted(wrapped.immediate),
      exclusive: counted(wrapped.exclusive),
    }) as unknown as typeof wrapped;
  }) as typeof db.transaction;
  try {
    expect(() => migrateArchiveSearch(db, crashMembers, 3)).toThrow('host killed');
  } finally {
    db.transaction = transaction;
  }
}

describe('migrating an archive that had one global index', () => {
  it('keeps the global index exact through this code’s writes, before the migration and after it', () => {
    legacyArchive(legacyRows);
    writeArchiveRow(db, row({ id: 'late', threadId: 't-late', text: 'the quokka landed' }), ACME);
    writeArchiveRow(db, { ...legacyRows[1]!, text: 'zeppelin number one, now a wombat' }, GLOBEX);
    migrateArchiveSearch(db, members, 3);
    writeArchiveRow(db, row({ id: 'later', threadId: 't-later', text: 'the narwhal landed' }), ACME);
    writeArchiveRow(db, { ...legacyRows[3]!, text: 'zeppelin number three, now an okapi' }, GLOBEX);

    expect(globalHits('quokka')).toEqual(['late']);
    expect(globalHits('wombat')).toEqual(['m1']);
    expect(globalHits('narwhal')).toEqual(['later']);
    expect(globalHits('okapi')).toEqual(['m3']);
    expect(globalHits('3')).toEqual([]);
    expect(globalIndexMatchesArchive).not.toThrow();
  });

  it('places every row once in its agent group’s tenant, keeps the global index, and does nothing on a second run', () => {
    legacyArchive(legacyRows);
    expect(archiveSearchReady(db)).toBe(false);

    expect(migrateArchiveSearch(db, members, 3)).toEqual({ rows: 8, alreadyReady: false, writtenElsewhere: false });

    expect(archiveSearchReady(db)).toBe(true);
    expect(globalHits('zeppelin')).toHaveLength(8);
    expect(found('zeppelin', 'workgroup:acme')).toEqual(['m0', 'm2', 'm4', 'm6']);
    expect(found('zeppelin', 'workgroup:globex')).toEqual(['m1', 'm3', 'm5']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_search_rows').get()).toEqual({ n: 7 });
    expect(migrateArchiveSearch(db, members, 3)).toEqual({ rows: 0, alreadyReady: true, writtenElsewhere: false });
  });

  it('after a failed attempt, archives without indexing, and the next boot places every row by the central DB then', () => {
    legacyArchive(legacyRows);
    crashAfterOneChunk(members);
    expect(archiveSearchReady(db)).toBe(false);
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_search_rows').get()).toEqual({ n: 3 });

    writeArchiveRow(db, row({ id: 'late', threadId: 't-late', text: 'zeppelin number late' }), ACME);
    writeArchiveRow(db, { ...legacyRows[1]!, text: 'zeppelin number one, edited' }, GLOBEX);
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_search_rows').get()).toEqual({ n: 3 });
    const moved = [
      { agentGroupId: 'ag-a', workgroupId: 'acme' },
      { agentGroupId: 'ag-b', workgroupId: 'initech' },
    ];

    migrateArchiveSearch(db, moved, 3);

    expect(archiveSearchReady(db)).toBe(true);
    expect(found('zeppelin', 'workgroup:acme')).toEqual(['late', 'm0', 'm2', 'm4', 'm6']);
    expect(found('zeppelin', 'workgroup:initech')).toEqual(['m1', 'm3', 'm5']);
    expect(found('edited', 'workgroup:initech')).toEqual(['m1']);
    expect(archivePartitionId(db, 'workgroup:globex')).toBeUndefined();
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_search_rows').get()).toEqual({ n: 8 });
  });

  it('starts a new archive with partitions and a global index the code before them can use', () => {
    expect(archiveSearchReady(db)).toBe(true);
    writeArchiveRow(db, row(), ACME);
    expect(found('zeppelin', 'workgroup:acme')).toEqual(['m1']);
    expect(globalHits('zeppelin')).toEqual(['m1']);
    expect(migrateArchiveSearch(db, members, 3)).toEqual({ rows: 0, alreadyReady: true, writtenElsewhere: false });
  });
});

/** A write as the code before the partitions made it: the same upsert, with no partition to update. */
const olderCodeWrites = (written: ArchiveRowBindings) => db.prepare(ARCHIVE_UPSERT_SQL).run(written);

describe('starting this code again after the code before it wrote the archive', () => {
  it.each([
    {
      write: 'an insert',
      older: () => row({ id: 'older', threadId: 't-older', text: 'the narwhal landed' }),
      word: 'narwhal',
      id: 'older',
      gone: undefined,
    },
    {
      write: 'an edit',
      older: () => ({ ...legacyRows[2]!, text: 'zeppelin number two, now an okapi' }),
      word: 'okapi',
      id: 'm2',
      gone: '2',
    },
  ])('places what the older code wrote, $write, at the next boot', ({ older, word, id, gone }) => {
    legacyArchive(legacyRows);
    migrateArchiveSearch(db, members, 3);
    olderCodeWrites(older());

    expect(migrateArchiveSearch(db, members, 3)).toMatchObject({ alreadyReady: false, writtenElsewhere: true });

    expect(found(word, 'workgroup:acme')).toEqual([id]);
    if (gone) expect(found(gone, 'workgroup:acme')).toEqual([]);
    expect(migrateArchiveSearch(db, members, 3)).toEqual({ rows: 0, alreadyReady: true, writtenElsewhere: false });
  });

  it('does not take this code’s own edits, or its row of an agent group the central DB does not hold, for the older code’s', () => {
    legacyArchive(legacyRows);
    migrateArchiveSearch(db, members, 3);
    writeArchiveRow(db, { ...legacyRows[2]!, text: 'zeppelin number two, now an okapi' }, ACME);
    writeArchiveRow(db, { ...legacyRows[4]!, channelName: 'renamed' }, ACME);
    writeArchiveRow(
      db,
      row({ id: 'stray', agentGroupId: 'ag-stray', threadId: 't-stray', text: 'a stray zeppelin' }),
      undefined,
    );

    expect(migrateArchiveSearch(db, members, 3)).toEqual({ rows: 0, alreadyReady: true, writtenElsewhere: false });

    olderCodeWrites(row({ id: 'older', threadId: 't-older', text: 'the narwhal landed' }));
    expect(migrateArchiveSearch(db, members, 3)).toMatchObject({ alreadyReady: false, writtenElsewhere: true });
    expect(found('narwhal', 'workgroup:acme')).toEqual(['older']);
  });

  it('counts the older code’s edit of only a channel name', () => {
    legacyArchive(legacyRows);
    migrateArchiveSearch(db, members, 3);
    olderCodeWrites({ ...legacyRows[4]!, channelName: 'renamed' });

    expect(archiveSearchReady(db)).toBe(false);
    expect(migrateArchiveSearch(db, members, 3)).toMatchObject({ alreadyReady: false, writtenElsewhere: true });
  });

  it.each([
    {
      write: 'an insert',
      older: () => row({ id: 'older', threadId: 't-older', text: 'the narwhal landed' }),
      word: 'narwhal',
      id: 'older',
    },
    {
      write: 'an edit',
      older: () => ({ ...legacyRows[2]!, text: 'zeppelin number two, now an okapi' }),
      word: 'okapi',
      id: 'm2',
    },
  ])(
    'searches nothing and lets no later write of its own cover what the older code wrote, $write, until a boot places it',
    ({ older, word, id }) => {
      legacyArchive(legacyRows);
      migrateArchiveSearch(db, members, 3);
      olderCodeWrites(older());

      expect(archiveSearchReady(db)).toBe(false);
      writeArchiveRow(db, row({ id: 'own', threadId: 't-own', text: 'the quokka landed' }), ACME);
      writeArchiveRow(db, { ...legacyRows[6]!, text: 'zeppelin number six, now a wombat' }, ACME);
      expect(archiveSearchReady(db)).toBe(false);

      expect(migrateArchiveSearch(db, members, 3)).toMatchObject({ alreadyReady: false, writtenElsewhere: true });
      expect(found(word, 'workgroup:acme')).toEqual([id]);
      expect(found('quokka', 'workgroup:acme')).toEqual(['own']);
      expect(found('wombat', 'workgroup:acme')).toEqual(['m6']);
    },
  );

  it('fills the global index again when a later change has dropped it, before this code writes', () => {
    legacyArchive(legacyRows);
    migrateArchiveSearch(db, members, 3);
    db.exec(`
      DROP TRIGGER messages_archive_ai;
      DROP TRIGGER messages_archive_ad;
      DROP TRIGGER messages_archive_au;
      DROP TABLE messages_archive_fts;
    `);

    initArchiveSchema(db);
    writeArchiveRow(db, { ...legacyRows[2]!, text: 'zeppelin number two, now an okapi' }, ACME);

    expect(globalHits('zeppelin')).toHaveLength(8);
    expect(globalHits('okapi')).toEqual(['m2']);
    expect(globalIndexMatchesArchive).not.toThrow();
  });

  it('fills a dropped global index on the next open after a fill that failed', () => {
    legacyArchive(legacyRows);
    migrateArchiveSearch(db, members, 3);
    db.exec(`
      DROP TRIGGER messages_archive_ai;
      DROP TRIGGER messages_archive_ad;
      DROP TRIGGER messages_archive_au;
      DROP TABLE messages_archive_fts;
    `);
    const exec = db.exec.bind(db);
    db.exec = ((sql: string) => {
      if (sql.includes(`VALUES('rebuild')`)) throw new Error('disk full');
      return exec(sql);
    }) as typeof db.exec;
    try {
      expect(() => initArchiveSchema(db)).toThrow('disk full');
    } finally {
      db.exec = exec;
    }

    initArchiveSchema(db);
    writeArchiveRow(db, { ...legacyRows[2]!, text: 'zeppelin number two, now an okapi' }, ACME);

    expect(globalHits('zeppelin')).toHaveLength(8);
    expect(globalIndexMatchesArchive).not.toThrow();
  });

  it('keeps search off until the placement after the older code’s writes completes', () => {
    legacyArchive(legacyRows);
    migrateArchiveSearch(db, members, 3);
    olderCodeWrites(row({ id: 'older', threadId: 't-older', text: 'the narwhal landed' }));

    const transaction = db.transaction.bind(db);
    let opened = 0;
    db.transaction = ((fn: (...args: never[]) => unknown) => {
      if (++opened === 3) throw new Error('host killed');
      return transaction(fn);
    }) as typeof db.transaction;
    try {
      expect(() => migrateArchiveSearch(db, members, 3)).toThrow('host killed');
    } finally {
      db.transaction = transaction;
    }
    expect(db.prepare('SELECT COUNT(*) AS n FROM archive_search_rows').get()).toEqual({ n: 3 });
    expect(archiveSearchReady(db)).toBe(false);

    migrateArchiveSearch(db, members, 3);
    expect(archiveSearchReady(db)).toBe(true);
    expect(found('narwhal', 'workgroup:acme')).toEqual(['older']);
  });
});
