/**
 * Central archive of every chat message, in `data/archive.db` with an FTS5 table. A separate file from v2.db so
 * it can be mounted read-only into containers without exposing central state; hence its self-bootstrapping
 * schema outside the migration chain.
 */
import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';

import {
  ARCHIVE_INDEX_ROW_COLUMNS,
  archiveDedupMatch,
  archiveSearchReady,
  archiveSearchTable,
  assertArchiveSearchReady,
  ensureArchiveSearchSchema,
  markArchiveSearchReady,
  reindexArchiveRow,
  searchablePartitionId,
  type ArchiveIndexRow,
  type ArchiveTenancy,
} from './archive-search-index.js';
import { DATA_DIR } from './config.js';
import { log } from './log.js';

export const ARCHIVE_PATH = path.join(DATA_DIR, 'archive.db');

/**
 * Per-agent-group counter of in-place rewrites (the upsert's `DO UPDATE`), which move neither `COUNT(*)` nor
 * `MAX(rowid)` and would otherwise slip past the archive projection's freshness stamp. Columns absent from the
 * `WHEN` clause are ones no write path updates; if one ever does, add it (the projection's dedup key includes it).
 */
export const ARCHIVE_MUTATION_MARKS_SQL = `
  CREATE TABLE IF NOT EXISTS archive_row_marks (
    agent_group_id TEXT PRIMARY KEY,
    mutations      INTEGER NOT NULL DEFAULT 0
  );
  CREATE TRIGGER IF NOT EXISTS messages_archive_mark_update
  AFTER UPDATE ON messages_archive
  WHEN old.text IS NOT new.text
    OR old.sender_name IS NOT new.sender_name
    OR old.channel_name IS NOT new.channel_name
  BEGIN
    INSERT INTO archive_row_marks (agent_group_id, mutations) VALUES (new.agent_group_id, 1)
    ON CONFLICT(agent_group_id) DO UPDATE SET mutations = mutations + 1;
  END;
  CREATE TRIGGER IF NOT EXISTS messages_archive_mark_delete
  AFTER DELETE ON messages_archive
  BEGIN
    INSERT INTO archive_row_marks (agent_group_id, mutations) VALUES (old.agent_group_id, 1)
    ON CONFLICT(agent_group_id) DO UPDATE SET mutations = mutations + 1;
  END;
`;

let _db: Database.Database | null = null;
let _dbPath: string | null = null;

function openDb(): Database.Database {
  // Re-keyed on the path: under test the cached connection can point at an unlinked fd.
  if (_db && _dbPath === ARCHIVE_PATH && fs.existsSync(ARCHIVE_PATH)) return _db;
  if (_db) {
    try {
      _db.close();
    } catch {
      // swallow — stale handle
    }
    _db = null;
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const db = new Database(ARCHIVE_PATH);
  // TRUNCATE, not WAL: containers mount only archive.db, not the -wal/-shm sidecars, so WAL writes are invisible.
  db.pragma('journal_mode = TRUNCATE');
  db.pragma('synchronous = NORMAL');
  initArchiveSchema(db);
  _db = db;
  _dbPath = ARCHIVE_PATH;
  return db;
}

/**
 * Nothing here reads the global index. It is kept exact, as main makes it, so the code before the partitions can be
 * started again on this archive with nothing to rebuild.
 */
const GLOBAL_INDEX_SQL = `
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_archive_fts USING fts5(
      text,
      sender_name,
      content='messages_archive',
      content_rowid='rowid'
    );

    CREATE TRIGGER IF NOT EXISTS messages_archive_ai AFTER INSERT ON messages_archive BEGIN
      INSERT INTO messages_archive_fts(rowid, text, sender_name)
      VALUES (new.rowid, new.text, new.sender_name);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_archive_ad AFTER DELETE ON messages_archive BEGIN
      INSERT INTO messages_archive_fts(messages_archive_fts, rowid, text, sender_name)
      VALUES ('delete', old.rowid, old.text, old.sender_name);
    END;
    CREATE TRIGGER IF NOT EXISTS messages_archive_au AFTER UPDATE ON messages_archive BEGIN
      INSERT INTO messages_archive_fts(messages_archive_fts, rowid, text, sender_name)
      VALUES ('delete', old.rowid, old.text, old.sender_name);
      INSERT INTO messages_archive_fts(rowid, text, sender_name)
      VALUES (new.rowid, new.text, new.sender_name);
    END;
`;

export function initArchiveSchema(db: Database.Database): void {
  const fresh = !db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages_archive'`).get();
  const globalIndexMissing = !db.prepare(`SELECT 1 FROM sqlite_master WHERE name = 'messages_archive_fts'`).get();
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages_archive (
      id                  TEXT PRIMARY KEY,
      agent_group_id      TEXT NOT NULL,
      messaging_group_id  TEXT,
      channel_type        TEXT NOT NULL,
      channel_name        TEXT,
      platform_id         TEXT,
      thread_id           TEXT,
      role                TEXT NOT NULL,     -- 'user' | 'assistant' | 'system'
      sender_id           TEXT,
      sender_name         TEXT,
      text                TEXT NOT NULL,
      sent_at             TEXT NOT NULL,
      created_at          TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- Additive migration for pre-existing archives that were created
    -- without the channel_name column. No-op if the column already
    -- exists (we swallow the SQLITE_ERROR below).
  `);
  for (const column of ['channel_name TEXT', 'sender_is_bot INTEGER']) {
    try {
      db.exec(`ALTER TABLE messages_archive ADD COLUMN ${column}`);
    } catch {
      // column already exists
    }
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_archive_ag_sent ON messages_archive(agent_group_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_archive_thread ON messages_archive(agent_group_id, thread_id, sent_at);
    CREATE INDEX IF NOT EXISTS idx_archive_channel ON messages_archive(channel_type, platform_id, thread_id);
    -- Covering index for the archive-change fingerprint
    -- (pollArchiveOnce, every 10s). Without it that poll scans the table and
    -- reads every row's text — it was the single largest disk consumer on the
    -- box, and the resulting IO saturation is what stalled the host's event
    -- loop. Keep the column order aligned with that query's filters.
    CREATE INDEX IF NOT EXISTS idx_archive_fingerprint
      ON messages_archive(agent_group_id, role, channel_type, sent_at);

    -- Pre-turn sender recall (recentConversationSenders, once per turn).
    -- Without it the planner falls back to idx_archive_fingerprint, whose
    -- leading agent_group_id constraint matches ~half the table for a
    -- multi-member workgroup, then temp-B-tree sorts all of it for a LIMIT
    -- 100. Column order is load-bearing in three parts:
    --   messaging_group_id, role  — the two real equalities, most selective
    --     first: on the live archive a messaging group holds a median 252 /
    --     mean 1,735 / max 11,294 of the 145,752 rows, where role='user'
    --     alone matches 123,423.
    --   sent_at, id               — the ORDER BY, in order, so the LIMIT walks
    --     the index backwards instead of sorting. id is the UNIQUE primary
    --     key, which is what makes that ordering total and the plan swap
    --     result-preserving; sent_at alone ties on 47k live values.
    --   agent_group_id, thread_id, sender_name, sender_id — after the sort
    --     columns, to make the index covering. The residual filters (member
    --     scope, thread) are not index constraints, so without these every
    --     walked entry costs a table lookup: dropping the trailing columns
    --     costs 19ms vs 2.1ms on the busiest messaging group in the install,
    --     and the planner reports plain INDEX instead of COVERING INDEX.
    --     sender_id joined the trailing set when the canonical-name preference
    --     match started reading it too — an existing install's index predates
    --     that column, so it is dropped and recreated below rather than left
    --     silently non-covering under CREATE INDEX IF NOT EXISTS.
    -- Measured against a copy of the 309MiB / 145,752-row live archive, six
    -- member agent groups of one workgroup: 134ms -> 2.1ms, identical for a hot
    -- thread and for a fresh thread whose rows do not exist. Index costs
    -- +24.3MiB and ~1.4-2.0s to build; archive INSERT p50 is unchanged
    -- (7.5ms -> 6.5ms, within noise — the TRUNCATE-journal fsync dominates the
    -- write).
  `);
  const convRecentColumns = db.prepare(`PRAGMA index_info(idx_archive_conv_recent)`).all() as Array<{
    name: string;
  }>;
  if (convRecentColumns.length > 0 && !convRecentColumns.some((col) => col.name === 'sender_id')) {
    db.exec('DROP INDEX idx_archive_conv_recent');
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_archive_conv_recent
      ON messages_archive(messaging_group_id, role, sent_at, id,
                          agent_group_id, thread_id, sender_name, sender_id);
  `);
  // The global index is created, triggered and filled in one transaction: a table left empty by a failed fill would be
  // taken as complete by the next open, and an empty one takes deletes for words it never held.
  db.transaction(() => {
    db.exec(GLOBAL_INDEX_SQL);
    if (!fresh && globalIndexMissing)
      db.exec(`INSERT INTO messages_archive_fts(messages_archive_fts) VALUES('rebuild')`);
  })();
  ensureArchiveRowMarks(db);
  ensureArchiveSearchSchema(db);
  // An archive that predates the partitions is migrated at boot (`migrateArchiveSearch`) before anything reads it.
  if (fresh) markArchiveSearchReady(db);
}

/** Reads `sqlite_master` because `IF NOT EXISTS` can't tell "created" from "already there". */
function ensureArchiveRowMarks(db: Database.Database): void {
  const present = new Set(
    (
      db
        .prepare(
          `SELECT name FROM sqlite_master
            WHERE name IN ('archive_row_marks', 'messages_archive_mark_update', 'messages_archive_mark_delete')`,
        )
        .all() as Array<{ name: string }>
    ).map((row) => row.name),
  );
  if (present.size === 3) {
    db.exec(ARCHIVE_MUTATION_MARKS_SQL);
    return;
  }
  const startedAt = Date.now();
  db.exec(ARCHIVE_MUTATION_MARKS_SQL);
  log.info('Archive row-marks schema created', { ms: Date.now() - startedAt });
}

/** Otherwise the schema appears only on the first archive write, and until then every spawn does a full rebuild. */
export function ensureArchiveSchema(): void {
  openDb();
}

export function __resetArchiveConnectionForTest(): void {
  if (!_db) return;
  try {
    _db.close();
  } catch {
    // stale handle
  }
  _db = null;
  _dbPath = null;
}

export interface ArchiveMessage {
  id: string;
  agentGroupId: string;
  messagingGroupId: string | null;
  channelType: string;
  channelName: string | null;
  platformId: string | null;
  threadId: string | null;
  role: 'user' | 'assistant' | 'system';
  senderId: string | null;
  senderName: string | null;
  /** The platform's own flag on the author, where the adapter sent one. */
  senderIsBot?: boolean;
  text: string;
  sentAt: string;
}

/** The ONLY statement in the host that writes `messages_archive`; the freshness stamp depends on that (test-held). */
// An id is supplied by whoever wrote the message, an agent included, so a rewrite never crosses role, agent or sender.
export const ARCHIVE_UPSERT_SQL = `INSERT INTO messages_archive
       (id, agent_group_id, messaging_group_id, channel_type, channel_name, platform_id, thread_id, role, sender_id, sender_name, sender_is_bot, text, sent_at)
     VALUES (@id, @agentGroupId, @messagingGroupId, @channelType, @channelName, @platformId, @threadId, @role, @senderId, @senderName, @senderIsBot, @text, @sentAt)
     ON CONFLICT(id) DO UPDATE SET
       text = excluded.text,
       sender_name = excluded.sender_name,
       channel_name = COALESCE(excluded.channel_name, channel_name)
     WHERE excluded.text IS NOT NULL
       AND messages_archive.role = excluded.role
       AND messages_archive.agent_group_id = excluded.agent_group_id
       AND COALESCE(messages_archive.sender_id, '') = COALESCE(excluded.sender_id, '')`;

const bindings = ({ senderIsBot, ...msg }: ArchiveMessage) => ({
  ...msg,
  senderIsBot: senderIsBot === undefined ? null : senderIsBot ? 1 : 0,
});

export type ArchiveRowBindings = ReturnType<typeof bindings>;

const INDEX_ROW_BY_ID_SQL = `SELECT ${ARCHIVE_INDEX_ROW_COLUMNS} FROM messages_archive WHERE id = ?`;

/**
 * The archive's only write: the row and the search index change in one transaction. Immediate, because SQLite never
 * waits on behalf of a transaction that has already read: it would fail at once against another writer. `tenancy` is
 * the central DB's answer at this write (`archiveTenancyOf`), undefined for an agent group it does not hold.
 */
export function writeArchiveRow(
  db: Database.Database,
  row: ArchiveRowBindings,
  tenancy: ArchiveTenancy | undefined,
): void {
  db.transaction(() => {
    const readRow = db.prepare(INDEX_ROW_BY_ID_SQL);
    const before = readRow.get(row.id) as ArchiveIndexRow | undefined;
    const indexing = archiveSearchReady(db);
    db.prepare(ARCHIVE_UPSERT_SQL).run(row);
    const after = readRow.get(row.id) as ArchiveIndexRow | undefined;
    if (after && indexing) reindexArchiveRow(db, before, after, tenancy);
  }).immediate();
}

export function upsertArchiveMessage(msg: ArchiveMessage, tenancy: ArchiveTenancy | undefined): void {
  if (!msg.text || msg.text.length === 0) return;
  try {
    writeArchiveRow(openDb(), bindings(msg), tenancy);
  } catch (err) {
    log.warn('Failed to upsert archive message', { id: msg.id, err });
  }
}

/** Throws rather than swallowing: when the router skips a message, the archive row is its only copy. */
export function archiveMessage(msg: ArchiveMessage, tenancy: ArchiveTenancy | undefined): boolean {
  if (!msg.text || msg.text.length === 0) return false;
  writeArchiveRow(openDb(), bindings(msg), tenancy);
  return true;
}

/**
 * Matched by channel address, not messaging group (task outbound rows carry none). Sibling bots' copies pool by
 * channel family, the same rule as `search_threads`; an unprefixed native id keeps exact channel_type matching.
 */
export function archiveHasThread(channelType: string, platformId: string, threadId: string): boolean {
  const dash = channelType.indexOf('-');
  const family = dash > 0 ? channelType.slice(0, dash) : channelType;
  const pooled = platformId.startsWith(`${family}:`);
  const row = openDb()
    .prepare(
      `SELECT 1 FROM messages_archive
        WHERE (channel_type = ? OR channel_type = ? OR channel_type LIKE ?) AND platform_id = ? AND thread_id = ?
        LIMIT 1`,
    )
    .get(channelType, pooled ? family : channelType, pooled ? `${family}-%` : null, platformId, threadId);
  return row !== undefined;
}

export interface ArchiveEvidenceRow {
  id: string;
  agentGroupId: string;
  messagingGroupId: string | null;
  channelType: string;
  channelName: string | null;
  platformId: string | null;
  threadId: string | null;
  role: string;
  senderId: string | null;
  senderName: string | null;
  text: string;
  sentAt: string;
  rank: 'exact-link' | 'current-thread' | 'workgroup';
}

interface ArchiveSqlRow {
  id: string;
  agent_group_id: string;
  messaging_group_id: string | null;
  channel_type: string;
  channel_name: string | null;
  platform_id: string | null;
  thread_id: string | null;
  role: string;
  sender_id: string | null;
  sender_name: string | null;
  text: string;
  sent_at: string;
}

function toEvidence(row: ArchiveSqlRow, rank: ArchiveEvidenceRow['rank']): ArchiveEvidenceRow {
  return {
    id: row.id,
    agentGroupId: row.agent_group_id,
    messagingGroupId: row.messaging_group_id,
    channelType: row.channel_type,
    channelName: row.channel_name,
    platformId: row.platform_id,
    threadId: row.thread_id,
    role: row.role,
    senderId: row.sender_id,
    senderName: row.sender_name,
    text: row.text,
    sentAt: row.sent_at,
    rank,
  };
}

function trustedMemberClause(memberAgentGroupIds: string[]): { sql: string; params: string[] } {
  const ids = [...new Set(memberAgentGroupIds)].sort();
  if (ids.length === 0) return { sql: '0', params: [] };
  return { sql: `agent_group_id IN (${ids.map(() => '?').join(',')})`, params: ids };
}

/** Rows indexed in this tenant's table, which holds what was archived for the workgroup while each message was written. */
function tenantClause(db: Database.Database, tenantKey: string): { sql: string; params: number[] } {
  const partitionId = searchablePartitionId(db, tenantKey);
  if (partitionId === undefined) return { sql: '0', params: [] };
  return {
    sql: `EXISTS (SELECT 1 FROM archive_search_rows placed
                   WHERE placed.row_id = messages_archive.rowid AND placed.partition_id = ?)`,
    params: [partitionId],
  };
}

const ARCHIVE_FTS_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'by',
  'com',
  'for',
  'from',
  'how',
  'http',
  'https',
  'in',
  'is',
  'it',
  'of',
  'on',
  'that',
  'the',
  'this',
  'to',
  'was',
  'what',
  'when',
  'where',
  'which',
  'who',
  'with',
  'www',
]);

/**
 * Without a prefix index FTS5 merges every term sharing the prefix inside one statement, on every statement: on the
 * live archive 330 ms for one letter, 130 for two, 60 for three, 10 for four.
 */
const ARCHIVE_PREFIX_MIN_CHARS = 3;
/** Eight common words cost 23 ms a statement on the live archive, and twenty-two cost 41. */
const ARCHIVE_TEXT_MAX_TERMS = 8;
/**
 * Everything FTS5's unicode61 tokenizer splits on, so a quoted term is always one token. A term that splits is a phrase,
 * and a phrase of common tokens scans the whole doclist in one statement: 50 tokens took 540 ms and returned no rows.
 * The listed characters are letters and numbers to JavaScript and separators to the tokenizer.
 */
const ARCHIVE_TOKEN_SEPARATORS = /[^\p{L}\p{N}\s]|[\u19b0-\u19c0\u19c8\u19c9\u1cf2\u1cf3]/gu;

function archiveFtsTerms(query: string, dropped: RegExp): string[] {
  return query
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(dropped, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter((term) => term.length > 1 && !ARCHIVE_FTS_STOP_WORDS.has(term))
    .slice(0, 24);
}

const quotedFtsTerm = (term: string) => `"${term.replaceAll('"', '""')}"`;

/** FTS5 query shape shared with the container thread-search tool: OR quoted, non-trivial tokens. */
export function sanitizeArchiveFtsQuery(query: string): string {
  return archiveFtsTerms(query, /[^\p{L}\p{N}_\s-]/gu)
    .map(quotedFtsTerm)
    .join(' OR ');
}

/**
 * Every term in one message body, never its sender. A search box narrows as it gets longer, so terms AND where
 * `sanitizeArchiveFtsQuery` ORs them, and the last term is a prefix because it is the one still being typed. Empty when
 * nothing searchable is left.
 */
export function archiveTextMatch(query: string): string {
  const terms = [...new Set(archiveFtsTerms(query, ARCHIVE_TOKEN_SEPARATORS))].slice(0, ARCHIVE_TEXT_MAX_TERMS);
  if (terms.length === 0) return '';
  const prefix = [...terms[terms.length - 1]].length >= ARCHIVE_PREFIX_MIN_CHARS ? '*' : '';
  return `text : (${terms.map(quotedFtsTerm).join(' ')}${prefix})`;
}

/** Newest first; deterministic, no ranking or FTS. */
export function recentConversationSenders(input: {
  memberAgentGroupIds: string[];
  messagingGroupId: string | null;
  threadId: string | null;
  rowLimit?: number;
  nameLimit?: number;
}): Array<{ senderName: string; senderId: string | null }> {
  if (input.memberAgentGroupIds.length === 0 || !input.messagingGroupId) return [];
  const scope = trustedMemberClause(input.memberAgentGroupIds);
  const rows = openDb()
    .prepare(
      `SELECT sender_name, sender_id
         FROM messages_archive
        WHERE ${scope.sql}
          AND role = 'user'
          AND sender_name IS NOT NULL
          AND messaging_group_id = ?
          AND ((? IS NOT NULL AND thread_id = ?) OR (? IS NULL AND thread_id IS NULL))
        ORDER BY sent_at DESC, id DESC
        LIMIT ?`,
    )
    .all(
      ...scope.params,
      input.messagingGroupId,
      input.threadId,
      input.threadId,
      input.threadId,
      input.rowLimit ?? 100,
    ) as Array<{ sender_name: string; sender_id: string | null }>;
  const senders: Array<{ senderName: string; senderId: string | null }> = [];
  const seenKeys = new Set<string>();
  for (const row of rows) {
    // Dedupe on sender_id, not name, so two people sharing a display name aren't collapsed.
    const key = row.sender_id ?? `name:${row.sender_name}`;
    if (seenKeys.has(key)) continue;
    seenKeys.add(key);
    senders.push({ senderName: row.sender_name, senderId: row.sender_id });
    if (senders.length >= (input.nameLimit ?? 8)) break;
  }
  return senders;
}

/**
 * `null` in `threads` is the channel's top level. The router archives an inbound text message whether or not it wakes
 * an agent, so this sees replies no session holds; it never sees a file-only reply, nor one a `drop` room or the access
 * gate discards. Rows archived before `sender_is_bot` existed carry no flag, and our own bots' posts reach their
 * siblings as `user` rows, which is what `isBot` is for.
 */
export function latestHumanMessage(input: {
  channelTypes: string[];
  platformId: string;
  threads: Array<string | null>;
  isBot: (senderId: string) => boolean;
  after?: string;
  atOrBefore?: string;
}): { senderId: string; sentAt: string } | null {
  if (input.channelTypes.length === 0) return null;
  const named = input.threads.filter((t): t is string => t !== null);
  // One branch per thread shape, so each keeps idx_archive_channel's thread_id column.
  const branches = [
    ...(named.length ? [`thread_id IN (${named.map(() => '?').join(',')})`] : []),
    ...(input.threads.includes(null) ? ['thread_id IS NULL', "thread_id = ''"] : []),
  ];
  if (branches.length === 0) return null;
  const select = (thread: string) =>
    `SELECT sender_id, sent_at
       FROM messages_archive
      WHERE channel_type IN (${input.channelTypes.map(() => '?').join(',')})
        AND platform_id = ?
        AND ${thread}
        AND role = 'user'
        AND sender_id IS NOT NULL
        AND COALESCE(sender_is_bot, 0) = 0
        AND (? IS NULL OR julianday(sent_at) > julianday(?))
        AND (? IS NULL OR julianday(sent_at) <= julianday(?))`;
  const window = [input.after ?? null, input.after ?? null, input.atOrBefore ?? null, input.atOrBefore ?? null];
  const rows = openDb()
    .prepare(`${branches.map(select).join(' UNION ALL ')} ORDER BY sent_at DESC`)
    .iterate(
      ...branches.flatMap((branch) => [
        ...input.channelTypes,
        input.platformId,
        ...(branch.startsWith('thread_id IN') ? named : []),
        ...window,
      ]),
    ) as IterableIterator<{ sender_id: string; sent_at: string }>;
  for (const row of rows) {
    if (!input.isBot(row.sender_id)) return { senderId: row.sender_id, sentAt: row.sent_at };
  }
  return null;
}

export interface ThreadMessage {
  id: string;
  role: 'user' | 'assistant';
  senderId: string | null;
  senderName: string | null;
  senderIsBot: boolean;
  text: string;
  sentAt: string;
}

/** One agent's view of a thread, oldest first: people's messages and its own posts that landed there. */
export function recentThreadMessages(input: {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
  limit: number;
}): ThreadMessage[] {
  // One statement per thread shape, so each walks idx_archive_thread; a combined OR walks the agent's whole history.
  const thread = input.threadId === null ? [] : [input.threadId];
  const rows = openDb()
    .prepare(
      `SELECT id, role, sender_id, sender_name, sender_is_bot, text, sent_at
         FROM messages_archive
        WHERE agent_group_id = ?
          AND ${input.threadId === null ? 'thread_id IS NULL' : 'thread_id = ?'}
          AND channel_type = ?
          AND platform_id = ?
          AND role IN ('user', 'assistant')
        ORDER BY sent_at DESC, id DESC
        LIMIT ?`,
    )
    .all(input.agentGroupId, ...thread, input.channelType, input.platformId, input.limit) as ThreadMessageRow[];
  return rows.reverse().map(threadMessage);
}

/** One archived message by its id: an agent's own post is archived under its outbound row's id. */
export function threadMessageById(id: string): ThreadMessage | null {
  const row = openDb()
    .prepare(
      `SELECT id, role, sender_id, sender_name, sender_is_bot, text, sent_at
         FROM messages_archive
        WHERE id = ? AND role IN ('user', 'assistant')`,
    )
    .get(id) as ThreadMessageRow | undefined;
  return row ? threadMessage(row) : null;
}

export function threadsHoldingMessages(channelTypes: string[], platformId: string, threadIds: string[]): Set<string> {
  if (threadIds.length === 0 || channelTypes.length === 0) return new Set();
  const rows = openDb()
    .prepare(
      `SELECT DISTINCT thread_id FROM messages_archive
        WHERE channel_type IN (SELECT value FROM json_each(?)) AND platform_id = ?
          AND thread_id IN (SELECT value FROM json_each(?))`,
    )
    .all(JSON.stringify(channelTypes), platformId, JSON.stringify(threadIds)) as Array<{ thread_id: string }>;
  return new Set(rows.map((row) => row.thread_id));
}

export function rowsInTenant(ids: string[], tenantKey: string): Set<string> {
  if (ids.length === 0) return new Set();
  const db = openDb();
  const scope = tenantClause(db, tenantKey);
  const rows = db
    .prepare(`SELECT id FROM messages_archive WHERE id IN (SELECT value FROM json_each(?)) AND ${scope.sql}`)
    .all(JSON.stringify(ids), ...scope.params) as Array<{ id: string }>;
  return new Set(rows.map((row) => row.id));
}

export interface RootPost {
  id: string;
  channelType: string;
  platformId: string;
  sentAt: string;
}

export function rootPostsAmong(agentGroupId: string, ids: string[]): RootPost[] {
  if (ids.length === 0) return [];
  // Filtered here, not in SQL: given the agent and role, the planner walks the agent's whole history by
  // idx_archive_fingerprint rather than reading each id by its key.
  const rows = openDb()
    .prepare(
      `SELECT id, agent_group_id, messaging_group_id, role, thread_id, channel_type, platform_id, sent_at
         FROM messages_archive WHERE id IN (${ids.map(() => '?').join(', ')})`,
    )
    .all(...ids) as Array<{
    id: string;
    agent_group_id: string;
    messaging_group_id: string | null;
    role: string;
    thread_id: string | null;
    channel_type: string;
    platform_id: string | null;
    sent_at: string;
  }>;
  return rows.flatMap((row) =>
    row.agent_group_id === agentGroupId &&
    row.role === 'assistant' &&
    row.thread_id === null &&
    row.messaging_group_id === null &&
    row.platform_id !== null
      ? [{ id: row.id, channelType: row.channel_type, platformId: row.platform_id, sentAt: row.sent_at }]
      : [],
  );
}

interface ThreadMessageRow {
  id: string;
  role: 'user' | 'assistant';
  sender_id: string | null;
  sender_name: string | null;
  sender_is_bot: number | null;
  text: string;
  sent_at: string;
}

const threadMessage = (r: ThreadMessageRow): ThreadMessage => ({
  id: r.id,
  role: r.role,
  senderId: r.sender_id,
  senderName: r.sender_name,
  senderIsBot: r.sender_is_bot === 1,
  text: r.text,
  sentAt: r.sent_at,
});

/** When this agent's own post last landed in the thread, from the archive; null if it never posted there. */
export function lastOwnPostAt(input: {
  agentGroupId: string;
  channelType: string;
  platformId: string;
  threadId: string;
}): string | null {
  const row = openDb()
    .prepare(
      `SELECT MAX(sent_at) AS at
         FROM messages_archive
        WHERE agent_group_id = ?
          AND thread_id = ?
          AND channel_type = ?
          AND platform_id = ?
          AND role = 'assistant'`,
    )
    .get(input.agentGroupId, input.threadId, input.channelType, input.platformId) as { at: string | null } | undefined;
  return row?.at ?? null;
}

/**
 * The messages these senders posted in the thread at or after `since`, by the archive, oldest first: each once, though
 * the archive keeps one row for every agent group that heard it.
 */
export function postsSince(input: {
  platformId: string;
  threadId: string;
  senderIds: string[];
  since: string;
}): Array<{ sentAt: string; text: string }> {
  if (input.senderIds.length === 0) return [];
  return openDb()
    .prepare(
      `SELECT sent_at AS sentAt, MIN(text) AS text
         FROM messages_archive
        WHERE platform_id = ?
          AND thread_id = ?
          AND role = 'user'
          AND sender_id IN (${input.senderIds.map(() => '?').join(', ')})
          AND datetime(sent_at) >= datetime(?)
        GROUP BY sent_at
        ORDER BY sent_at`,
    )
    .all(input.platformId, input.threadId, ...input.senderIds, input.since) as Array<{ sentAt: string; text: string }>;
}

/** False until the boot migration has placed every row, and again once other code has written the archive since. */
export const archiveSearchAvailable = (): boolean => archiveSearchReady(openDb());

/** FTS generates candidates only; the pre-turn builder scores and bounds them. */
export function searchArchiveEvidence(input: {
  /** `archiveTenantKey` of the searching agent group's workgroup, from the central DB. */
  tenantKey: string;
  query: string;
  currentMessagingGroupId: string | null;
  currentThreadId: string | null;
  currentNormalizedContent: string;
  candidateLimit: number;
}): ArchiveEvidenceRow[] {
  const db = openDb();
  assertArchiveSearchReady(db);
  const fts = sanitizeArchiveFtsQuery(input.query);
  if (!fts || input.candidateLimit <= 0) return [];
  const search = { ...input, fts, candidateLimit: Math.max(1, Math.floor(input.candidateLimit)) };
  const rows = searchTenant(db, search);
  return rows.map((row) => rankedEvidence(row, input.currentMessagingGroupId, input.currentThreadId));
}

function rankedEvidence(
  row: ArchiveSqlRow,
  currentMessagingGroupId: string | null,
  currentThreadId: string | null,
): ArchiveEvidenceRow {
  const isCurrentThread =
    currentThreadId !== null
      ? row.thread_id === currentThreadId
      : row.thread_id === null && row.messaging_group_id === currentMessagingGroupId;
  return toEvidence(row, isCurrentThread ? 'current-thread' : 'workgroup');
}

export type ArchiveMessageIdentity = Pick<ArchiveEvidenceRow, 'platformId' | 'threadId' | 'sentAt' | 'text'>;

/**
 * Every sibling bot wired to a channel archives its own copy of each message there, under its own id and messaging
 * group, with the sender id prefixed by its own channel type; the copies share this identity. Copies whose text differs
 * stay separate, including the common case of a mention one bot renders as a name and another as a raw user id.
 */
export function archiveMessageKey(row: ArchiveMessageIdentity & Pick<ArchiveEvidenceRow, 'senderId'>): string {
  const sender = row.senderId === null ? null : row.senderId.slice(row.senderId.indexOf(':') + 1);
  return JSON.stringify([row.platformId, row.threadId, row.sentAt, sender, row.text]);
}

export function archiveCopiesOf(input: {
  /** `archiveTenantKey` of the reading agent group's workgroup, from the central DB. */
  tenantKey: string;
  messages: readonly ArchiveMessageIdentity[];
  currentMessagingGroupId: string | null;
  currentThreadId: string | null;
}): ArchiveEvidenceRow[][] {
  if (input.messages.length === 0) return [];
  const db = openDb();
  const scope = tenantClause(db, input.tenantKey);
  const copies = db.prepare(
    `SELECT id, agent_group_id, messaging_group_id, channel_type, channel_name,
            platform_id, thread_id, role, sender_id, sender_name, text, sent_at
       FROM messages_archive
      WHERE ${scope.sql}
        AND sent_at = ?
        AND platform_id IS ?
        AND thread_id IS ?
        AND text = ?
      ORDER BY id ASC`,
  );
  return input.messages.map((message) =>
    (
      copies.all(...scope.params, message.sentAt, message.platformId, message.threadId, message.text) as ArchiveSqlRow[]
    ).map((row) => rankedEvidence(row, input.currentMessagingGroupId, input.currentThreadId)),
  );
}

interface EvidenceSearch {
  tenantKey: string;
  fts: string;
  currentMessagingGroupId: string | null;
  currentThreadId: string | null;
  currentNormalizedContent: string;
  candidateLimit: number;
}

/**
 * A tenant's table indexes one copy of each message archived for it, so a hit is widened back to every copy recorded
 * with it there, and to no copy archived for another tenant.
 */
function searchTenant(db: Database.Database, input: EvidenceSearch): ArchiveSqlRow[] {
  const partitionId = searchablePartitionId(db, input.tenantKey);
  if (partitionId === undefined) return [];
  const table = archiveSearchTable(partitionId);
  const hits = `SELECT rowid AS rowid, bm25(${table}, 1.0, 1.0, 0.0) AS score FROM ${table} WHERE ${table} MATCH @fts`;
  return db
    .prepare(
      `WITH hits AS MATERIALIZED (${hits}),
       matches AS MATERIALIZED (
         SELECT copy.rowid AS rowid,
                hits.score AS score,
                CASE
                  WHEN (@thread IS NOT NULL AND copy.thread_id = @thread)
                    OR (@thread IS NULL AND copy.messaging_group_id = @messagingGroup AND copy.thread_id IS NULL)
                  THEN 0 ELSE 1
                END AS current_rank
           FROM hits
           JOIN messages_archive hit_row ON hit_row.rowid = hits.rowid
           JOIN messages_archive copy ON ${archiveDedupMatch('copy', 'hit_row')}
           JOIN archive_search_rows placed ON placed.row_id = copy.rowid AND placed.partition_id = @partition
          -- rowid completes the sort key so the rows that survive the cut are ours to choose, not the planner's.
          ORDER BY current_rank ASC, score ASC, copy.rowid ASC
          LIMIT @inner
       )
       SELECT a.id, a.agent_group_id, a.messaging_group_id, a.channel_type,
              a.channel_name, a.platform_id, a.thread_id, a.role, a.sender_id,
              a.sender_name, a.text, a.sent_at
         FROM messages_archive a
         JOIN matches m ON m.rowid = a.rowid
        WHERE trim(a.text) <> trim(@current)
        ORDER BY m.current_rank ASC, m.score ASC, a.sent_at DESC, a.id ASC
        LIMIT @limit`,
    )
    .all({
      fts: `{text sender_name} : (${input.fts})`,
      thread: input.currentThreadId,
      messagingGroup: input.currentMessagingGroupId,
      partition: partitionId,
      inner: input.candidateLimit * 8,
      current: input.currentNormalizedContent,
      limit: input.candidateLimit,
    }) as ArchiveSqlRow[];
}

export type ArchivePermalink =
  | { kind: 'slack'; url: string; channel: string; timestamp: string; threadTimestamp: string | null }
  | { kind: 'discord'; url: string; guild: string; channel: string; message: string | null };

/** Parse every supported permalink from untrusted current input without using it for authorization. */
export function parseArchivePermalinks(content: string): ArchivePermalink[] {
  const urls = content.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  const parsed: ArchivePermalink[] = [];
  for (const rawUrl of urls.slice(0, 8)) {
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      continue;
    }
    if (/(^|\.)slack\.com$/i.test(url.hostname)) {
      const match = url.pathname.match(/^\/archives\/([A-Z0-9]+)\/p(\d{10})(\d+)$/i);
      if (!match) continue;
      parsed.push({
        kind: 'slack',
        url: rawUrl,
        channel: match[1]!,
        timestamp: `${match[2]}.${match[3]}`,
        threadTimestamp: url.searchParams.get('thread_ts'),
      });
      continue;
    }
    if (/^(?:www\.)?discord(?:app)?\.com$/i.test(url.hostname)) {
      const match = url.pathname.match(/^\/channels\/(\d+)\/(\d+)(?:\/(\d+))?/);
      if (!match) continue;
      parsed.push({
        kind: 'discord',
        url: rawUrl,
        guild: match[1]!,
        channel: match[2]!,
        message: match[3] ?? null,
      });
    }
  }
  return parsed;
}

/** Resolve parsed permalinks against exact archive routing, bounded to the reading agent group's tenant table. */
export function queryArchiveExactLinks(input: {
  /** `archiveTenantKey` of the reading agent group's workgroup, from the central DB. */
  tenantKey: string;
  normalizedContent: string;
  candidateLimit: number;
}): ArchiveEvidenceRow[] {
  const links = parseArchivePermalinks(input.normalizedContent);
  if (links.length === 0 || input.candidateLimit <= 0) return [];
  const db = openDb();
  const scope = tenantClause(db, input.tenantKey);
  const selected: ArchiveEvidenceRow[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const remaining = Math.max(0, Math.floor(input.candidateLimit) - selected.length);
    if (remaining === 0) break;
    let rows: ArchiveSqlRow[];
    if (link.kind === 'slack') {
      const threadId = `slack:${link.channel}:${link.threadTimestamp ?? link.timestamp}`;
      rows = db
        .prepare(
          `SELECT id, agent_group_id, messaging_group_id, channel_type, channel_name,
                  platform_id, thread_id, role, sender_id, sender_name, text, sent_at
             FROM messages_archive
            WHERE ${scope.sql}
              AND channel_type LIKE 'slack%'
              AND platform_id = ?
              AND thread_id = ?
            ORDER BY sent_at ASC, id ASC
            LIMIT ?`,
        )
        .all(...scope.params, `slack:${link.channel}`, threadId, remaining) as ArchiveSqlRow[];
    } else {
      const platformId = `discord:${link.guild}:${link.channel}`;
      const encodedChannel = `discord:${link.guild}:${link.channel}`;
      const encodedThreadSuffix = `discord:${link.guild}:%:${link.channel}`;
      if (link.message) {
        // Thread rows keep the parent channel in platform_id and the thread in thread_id; match both identities.
        rows = db
          .prepare(
            `SELECT id, agent_group_id, messaging_group_id, channel_type, channel_name,
                    platform_id, thread_id, role, sender_id, sender_name, text, sent_at
               FROM messages_archive
              WHERE ${scope.sql}
                AND channel_type LIKE 'discord%'
                AND (id = ? OR id LIKE ?)
                AND (
                  platform_id = ?
                  OR thread_id = ?
                  OR thread_id = ?
                  OR thread_id LIKE ?
                )
              ORDER BY sent_at ASC, id ASC
              LIMIT ?`,
          )
          .all(
            ...scope.params,
            link.message,
            `${link.message}:%`,
            platformId,
            link.channel,
            encodedChannel,
            encodedThreadSuffix,
            remaining,
          ) as ArchiveSqlRow[];

        // Outbound rows lack the platform message id; fall back to a real thread, never to a whole channel.
        if (rows.length === 0) {
          rows = db
            .prepare(
              `SELECT id, agent_group_id, messaging_group_id, channel_type, channel_name,
                      platform_id, thread_id, role, sender_id, sender_name, text, sent_at
                 FROM messages_archive
                WHERE ${scope.sql}
                  AND channel_type LIKE 'discord%'
                  AND (thread_id = ? OR thread_id = ? OR thread_id LIKE ?)
                ORDER BY sent_at ASC, id ASC
                LIMIT ?`,
            )
            .all(...scope.params, link.channel, encodedChannel, encodedThreadSuffix, remaining) as ArchiveSqlRow[];
        }
      } else {
        rows = db
          .prepare(
            `SELECT id, agent_group_id, messaging_group_id, channel_type, channel_name,
                    platform_id, thread_id, role, sender_id, sender_name, text, sent_at
               FROM messages_archive
              WHERE ${scope.sql}
                AND channel_type LIKE 'discord%'
                AND (
                  platform_id = ?
                  OR thread_id = ?
                  OR thread_id = ?
                  OR thread_id LIKE ?
                )
              ORDER BY sent_at ASC, id ASC
              LIMIT ?`,
          )
          .all(
            ...scope.params,
            platformId,
            link.channel,
            encodedChannel,
            encodedThreadSuffix,
            remaining,
          ) as ArchiveSqlRow[];
      }
    }
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      selected.push(toEvidence(row, 'exact-link'));
    }
  }
  return selected;
}
