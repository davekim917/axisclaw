/**
 * The archive's full-text index, one FTS5 table per tenant. A workgroup is a tenant, and an agent group with no
 * workgroup is a tenant of its own. A message is indexed in the tenant the central DB put its agent group in when the
 * message was archived, and stays there: after a move, new messages go to the new tenant and older ones stay in the
 * old. A table's rows are fixed when they are written, so a search of one tenant reads nothing written for another.
 *
 * `archive_search_rows` records where each archive row is indexed. A message several agents of one tenant archived is
 * indexed once (`indexed = 1`) and its other copies are recorded with `indexed = 0`, so a search reads one row per
 * message and a copy can stand in if the indexed one changes.
 */
import Database from 'better-sqlite3';

const senderIdentity = (sql: string) => `substr(${sql}, instr(${sql}, ':') + 1)`;

/**
 * Two archive rows are one message when these match. Each sibling bot archives its own copy under its own messaging
 * group, with the sender id prefixed by its own channel type, so the copies share the platform channel and the sender
 * id after that prefix: `archiveMessageKey`'s identity. Role is kept apart because the text walk drops a system message
 * by the role of the copy the index holds.
 */
const DEDUP_COLUMNS: ReadonlyArray<{ name: string; nullable: boolean; value?: (sql: string) => string }> = [
  { name: 'platform_id', nullable: true },
  { name: 'sent_at', nullable: false },
  { name: 'thread_id', nullable: true },
  { name: 'role', nullable: false },
  { name: 'sender_id', nullable: true, value: senderIdentity },
  { name: 'text', nullable: false },
];

/** The dedup identity against `@column` parameters, or against another alias's columns when `other` is given. */
export function archiveDedupMatch(alias = '', other?: string): string {
  const column = (prefix: string, name: string) => (prefix ? `${prefix}.${name}` : name);
  return DEDUP_COLUMNS.map(({ name, nullable, value = (sql) => sql }) => {
    const left = value(column(alias, name));
    const right = value(other ? column(other, name) : `@${name}`);
    return `${left} ${nullable ? 'IS' : '='} ${right}`;
  }).join(' AND ');
}

/** The central DB's answer, read at the write, for the workgroup the message's agent group is in; null for none. */
export interface ArchiveTenancy {
  workgroupId: string | null;
}

export const archiveTenantKey = (workgroupId: string | null, agentGroupId: string): string =>
  workgroupId ? `workgroup:${workgroupId}` : `agent-group:${agentGroupId}`;

/** One token the tokenizer never splits, so a channel filter is one doclist and never a phrase. */
export const archiveChannelToken = (platformId: string | null): string =>
  `c${Buffer.from(platformId ?? '', 'utf8').toString('hex')}`;

export const archiveThreadToken = (threadId: string): string => `t${Buffer.from(threadId, 'utf8').toString('hex')}`;

/**
 * A Discord thread row is reachable only through its own thread's check: a private thread is hidden from people who can
 * see its channel. A Slack thread shows to everyone in its channel, so its rows stay under the channel.
 */
function scopeToken(row: { platform_id: string | null; thread_id: string | null }): string {
  const discordThread = row.platform_id?.startsWith('discord:') && row.thread_id && row.thread_id !== row.platform_id;
  return discordThread ? archiveThreadToken(row.thread_id!) : archiveChannelToken(row.platform_id);
}

export const archiveSearchTable = (partitionId: number): string => `archive_search_p${Math.trunc(partitionId)}`;

const READY_KEY = 'partitions_ready';
/** Highest archive rowid this code has accounted for that `archive_search_rows` does not record. */
const ROWS_THROUGH_KEY = 'rows_through';
/** `archive_row_marks`' total as this code last left it. */
const MARKS_KEY = 'marks_seen';

export function ensureArchiveSearchSchema(db: Database.Database): void {
  db.exec(`
    -- Finds a message's copies by the dedup identity's leading columns; without it every write scans the archive.
    CREATE INDEX IF NOT EXISTS idx_archive_message ON messages_archive(platform_id, sent_at);
    CREATE TABLE IF NOT EXISTS archive_search_partitions (
      id            INTEGER PRIMARY KEY,
      partition_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS archive_search_rows (
      row_id       INTEGER PRIMARY KEY,
      partition_id INTEGER NOT NULL,
      indexed      INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS archive_search_state (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

const statements = new WeakMap<Database.Database, Map<string, Database.Statement>>();

function stmt(db: Database.Database, sql: string): Database.Statement {
  let cache = statements.get(db);
  if (!cache) statements.set(db, (cache = new Map()));
  let prepared = cache.get(sql);
  if (!prepared) cache.set(sql, (prepared = db.prepare(sql)));
  return prepared;
}

const readState = (db: Database.Database, key: string) =>
  (stmt(db, 'SELECT value FROM archive_search_state WHERE key = ?').get(key) as { value: string } | undefined)?.value;

const writeState = (db: Database.Database, key: string, value: string) =>
  stmt(db, 'INSERT OR REPLACE INTO archive_search_state (key, value) VALUES (?, ?)').run(key, value);

const placedFlag = (db: Database.Database): boolean => readState(db, READY_KEY) === '1';

const archiveMarks = (db: Database.Database): number =>
  (stmt(db, 'SELECT COALESCE(SUM(mutations), 0) AS n FROM archive_row_marks').get() as { n: number }).n;

/** Every row there now is placed, and every edit made so far is indexed. */
export function markArchiveSearchReady(db: Database.Database): void {
  const last = (stmt(db, 'SELECT COALESCE(MAX(rowid), 0) AS n FROM messages_archive').get() as { n: number }).n;
  writeState(db, ROWS_THROUGH_KEY, String(last));
  writeState(db, MARKS_KEY, String(archiveMarks(db)));
  writeState(db, READY_KEY, '1');
}

/**
 * Whether code that does not keep the partitions wrote the archive since this code last did: the code before this
 * change, run after a rollback, keeps the global index and `archive_row_marks` but not the partitions. An insert raises
 * the archive's last rowid past every row this code accounted for, and an edit raises the marks' total.
 */
function writtenElsewhere(db: Database.Database): boolean {
  const { archived, recorded } = stmt(
    db,
    `SELECT (SELECT COALESCE(MAX(rowid), 0) FROM messages_archive) AS archived,
            (SELECT COALESCE(MAX(row_id), 0) FROM archive_search_rows) AS recorded`,
  ).get() as { archived: number; recorded: number };
  return (
    archived > Math.max(recorded, Number(readState(db, ROWS_THROUGH_KEY) ?? 0)) ||
    archiveMarks(db) !== Number(readState(db, MARKS_KEY) ?? Number.NaN)
  );
}

/**
 * The tables hold every row and every edit in the archive. Checked at each read and each write, not only at boot: a boot
 * that failed before it checked must not leave the tables searched, nor let this code's own writes cover the older
 * code's.
 */
export const archiveSearchReady = (db: Database.Database): boolean => placedFlag(db) && !writtenElsewhere(db);

/** The table a search of this tenant reads; undefined while nothing has been indexed for it. */
export const archivePartitionId = (db: Database.Database, tenantKey: string): number | undefined =>
  (
    stmt(db, 'SELECT id FROM archive_search_partitions WHERE partition_key = ?').get(tenantKey) as
      | { id: number }
      | undefined
  )?.id;

/** For a reader: until the boot migration has placed every row, there is nothing to read. */
export function assertArchiveSearchReady(db: Database.Database): void {
  if (!archiveSearchReady(db)) throw new Error('Archive search is off until its boot migration completes');
}

export function searchablePartitionId(db: Database.Database, tenantKey: string): number | undefined {
  assertArchiveSearchReady(db);
  return archivePartitionId(db, tenantKey);
}

function ensureArchivePartition(db: Database.Database, tenantKey: string): number {
  const existing = archivePartitionId(db, tenantKey);
  if (existing !== undefined) return existing;
  const id = Number(
    stmt(db, 'INSERT INTO archive_search_partitions (partition_key) VALUES (?)').run(tenantKey).lastInsertRowid,
  );
  db.exec(
    `CREATE VIRTUAL TABLE IF NOT EXISTS ${archiveSearchTable(id)} USING fts5(` +
      `text, sender_name, channel, content='', contentless_delete=1)`,
  );
  return id;
}

export interface ArchiveIndexRow {
  rowid: number;
  agent_group_id: string;
  thread_id: string | null;
  role: string;
  sender_id: string | null;
  sent_at: string;
  text: string;
  sender_name: string | null;
  platform_id: string | null;
}

export const ARCHIVE_INDEX_ROW_COLUMNS =
  'rowid, agent_group_id, thread_id, role, sender_id, sent_at, text, sender_name, platform_id';

const dedupParams = (row: ArchiveIndexRow) => ({
  platform_id: row.platform_id,
  sent_at: row.sent_at,
  thread_id: row.thread_id,
  role: row.role,
  sender_id: row.sender_id,
  text: row.text,
});

const GROUP_ROW_COLUMNS = `${ARCHIVE_INDEX_ROW_COLUMNS.replace(/(^|, )/g, '$1r.')}, s.indexed AS indexed`;

type RecordedCopy = ArchiveIndexRow & { indexed: number };

/** The recorded copies of `row`'s message in `partitionId`, other than `row` itself. */
function copiesIn(db: Database.Database, partitionId: number, row: ArchiveIndexRow): RecordedCopy[] {
  return (
    stmt(
      db,
      `SELECT ${GROUP_ROW_COLUMNS} FROM messages_archive r
         JOIN archive_search_rows s ON s.row_id = r.rowid
        WHERE ${archiveDedupMatch('r')} AND s.partition_id = @partition
        ORDER BY r.rowid`,
    ).all({ ...dedupParams(row), partition: partitionId }) as RecordedCopy[]
  ).filter((copy) => copy.rowid !== row.rowid);
}

/**
 * The copies share the dedup identity but not always the sender's display name, so the one indexed row carries every
 * copy's name: a search by a name only one copy holds still finds the message.
 */
function indexMessage(
  db: Database.Database,
  partitionId: number,
  indexed: ArchiveIndexRow,
  copies: ArchiveIndexRow[],
  replacing: boolean,
): void {
  const names = [...new Set(copies.map((copy) => copy.sender_name).filter(Boolean))];
  const table = archiveSearchTable(partitionId);
  if (replacing) stmt(db, `DELETE FROM ${table} WHERE rowid = ?`).run(indexed.rowid);
  stmt(db, `INSERT INTO ${table} (rowid, text, sender_name, channel) VALUES (?, ?, ?, ?)`).run(
    indexed.rowid,
    indexed.text,
    names.length > 0 ? names.join(' ') : null,
    scopeToken(indexed),
  );
}

/** Whether `copy`'s name is one no other copy carries, so the indexed row's names change with it. */
const ownName = (copy: ArchiveIndexRow, others: ArchiveIndexRow[]) =>
  Boolean(copy.sender_name) && !others.some((other) => other.sender_name === copy.sender_name);

function addToSearch(db: Database.Database, row: ArchiveIndexRow, partitionId: number): void {
  const copies = copiesIn(db, partitionId, row);
  const indexed = copies.find((copy) => copy.indexed);
  stmt(db, 'INSERT OR REPLACE INTO archive_search_rows (row_id, partition_id, indexed) VALUES (?, ?, ?)').run(
    row.rowid,
    partitionId,
    indexed ? 0 : 1,
  );
  if (!indexed) indexMessage(db, partitionId, row, [...copies, row], false);
  else if (ownName(row, copies)) indexMessage(db, partitionId, indexed, [...copies, row], true);
}

/** `row` carries the values the index holds for it, which an update has already replaced in the archive. */
function removeFromSearch(db: Database.Database, row: ArchiveIndexRow): void {
  const entry = stmt(db, 'SELECT partition_id, indexed FROM archive_search_rows WHERE row_id = ?').get(row.rowid) as
    | { partition_id: number; indexed: number }
    | undefined;
  if (!entry) return;
  stmt(db, 'DELETE FROM archive_search_rows WHERE row_id = ?').run(row.rowid);
  if (entry.indexed) stmt(db, `DELETE FROM ${archiveSearchTable(entry.partition_id)} WHERE rowid = ?`).run(row.rowid);
  const copies = copiesIn(db, entry.partition_id, row);
  const indexed = copies.find((copy) => copy.indexed) ?? copies[0];
  if (!indexed) return;
  if (!indexed.indexed) {
    stmt(db, 'UPDATE archive_search_rows SET indexed = 1 WHERE row_id = ?').run(indexed.rowid);
    indexMessage(db, entry.partition_id, indexed, copies, false);
  } else if (ownName(row, copies)) indexMessage(db, entry.partition_id, indexed, copies, true);
}

const indexedIn = (db: Database.Database, rowid: number) =>
  (
    stmt(db, 'SELECT partition_id FROM archive_search_rows WHERE row_id = ?').get(rowid) as
      | { partition_id: number }
      | undefined
  )?.partition_id;

/**
 * Called inside the write's transaction with the row as it was (undefined for an insert) and as it is now, and only when
 * `archiveSearchReady` held before the write; otherwise the tables are not updated, because the next migration places
 * every row itself. An edit keeps the row in the tenant it was indexed in; `tenancy` places a row indexed nowhere yet,
 * and is undefined for an agent group the central DB does not hold, whose row stays unindexed.
 */
export function reindexArchiveRow(
  db: Database.Database,
  before: ArchiveIndexRow | undefined,
  after: ArchiveIndexRow,
  tenancy: ArchiveTenancy | undefined,
): void {
  if (before) writeState(db, MARKS_KEY, String(archiveMarks(db)));
  if (before && before.text === after.text && before.sender_name === after.sender_name) return;
  const placed = before && indexedIn(db, before.rowid);
  if (before) removeFromSearch(db, before);
  const partitionId =
    placed ?? (tenancy && ensureArchivePartition(db, archiveTenantKey(tenancy.workgroupId, after.agent_group_id)));
  if (partitionId !== undefined) addToSearch(db, after, partitionId);
  else if (!before) writeState(db, ROWS_THROUGH_KEY, String(after.rowid));
}

export interface ArchiveSearchMember {
  agentGroupId: string;
  workgroupId: string | null;
}

export interface MigrateResult {
  rows: number;
  alreadyReady: boolean;
  /** The partitions were complete, but code that does not keep them wrote the archive since. */
  writtenElsewhere: boolean;
}

/** Drops whatever an attempt that did not complete placed, so no row keeps the tenant that attempt gave it. */
function clearPartitions(db: Database.Database): void {
  const partitions = stmt(db, 'SELECT id FROM archive_search_partitions').all() as Array<{ id: number }>;
  for (const { id } of partitions) db.exec(`DROP TABLE IF EXISTS ${archiveSearchTable(id)}`);
  db.exec('DELETE FROM archive_search_rows; DELETE FROM archive_search_partitions;');
}

/**
 * Builds the partitions at boot, before anything can write or search: each row goes to the tenant its agent group is
 * in now, and a row of an agent group the central DB does not hold is not indexed. Until this completes search is off
 * and writes leave the tables alone, so an attempt that fails is never read: the next boot starts over from the central
 * DB as it is then. Partitions that were complete are built again, all of them, when other code wrote the archive
 * since: by choice, since the marks say only that an agent group's rows changed, not which, and a full placement
 * rebuilds each message's copies and their sender names with it.
 */
export function migrateArchiveSearch(
  db: Database.Database,
  members: ArchiveSearchMember[],
  chunkRows: number,
): MigrateResult {
  ensureArchiveSearchSchema(db);
  const placed = placedFlag(db);
  const elsewhere = placed && writtenElsewhere(db);
  if (placed && !elsewhere) return { rows: 0, alreadyReady: true, writtenElsewhere: false };
  const tenantOf = new Map(
    members.map((member) => [member.agentGroupId, archiveTenantKey(member.workgroupId, member.agentGroupId)]),
  );
  db.transaction(() => clearPartitions(db))();
  let rows = 0;
  let cursor = 0;
  for (;;) {
    const batch = db.transaction(() => {
      const read = stmt(
        db,
        `SELECT ${ARCHIVE_INDEX_ROW_COLUMNS} FROM messages_archive WHERE rowid > ? ORDER BY rowid LIMIT ?`,
      ).all(cursor, chunkRows) as ArchiveIndexRow[];
      for (const row of read) {
        const tenantKey = tenantOf.get(row.agent_group_id);
        if (tenantKey !== undefined) addToSearch(db, row, ensureArchivePartition(db, tenantKey));
      }
      return read;
    })();
    rows += batch.length;
    if (batch.length < chunkRows) break;
    cursor = batch[batch.length - 1]!.rowid;
  }
  markArchiveSearchReady(db);
  return { rows, alreadyReady: false, writtenElsewhere: elsewhere };
}

export interface ArchiveSearchMigrateRequest {
  archivePath: string;
  members: ArchiveSearchMember[];
  chunkRows: number;
}

export type ArchiveSearchMigrateResult = MigrateResult & { ms: number };

/** The boot migration against the archive file. It holds the archive's write lock, so run it on a worker. */
export function runArchiveSearchMigration(request: ArchiveSearchMigrateRequest): ArchiveSearchMigrateResult {
  const startedAt = Date.now();
  const db = new Database(request.archivePath, { fileMustExist: true, timeout: 5_000 });
  try {
    db.pragma('journal_mode = TRUNCATE');
    db.pragma('synchronous = NORMAL');
    return { ...migrateArchiveSearch(db, request.members, request.chunkRows), ms: Date.now() - startedAt };
  } finally {
    db.close();
  }
}
