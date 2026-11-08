/**
 * Append-only record of data-source calls made in this container, written by the transports the runner owns (the MCP
 * bridge, the Python Snowflake tap, the `gws` and `psql` shims) and read by the reply stamp. One file per container: `/tmp` is
 * container-local, and every recorder process runs inside the same container.
 */
import { Database } from 'bun:sqlite';
import fs from 'fs';
import path from 'path';

const DEFAULT_LEDGER_PATH = '/tmp/nanoclaw-sources/ledger.jsonl';

export function ledgerPath(): string {
  return process.env.NANOCLAW_SOURCE_LEDGER || DEFAULT_LEDGER_PATH;
}

export type LedgerEntry =
  | { v: 1; ts: string; recorder: 'mcp'; server: string; origin?: string; tool: string; args: unknown; ok: boolean }
  | { v: 1; ts: string; recorder: 'snowflake'; sql: string; ok: boolean; truncated?: boolean; process?: string }
  | { v: 1; ts: string; recorder: 'gws'; argv: string[]; ok: boolean }
  /** Parsed at record time: a psql command line carries connection strings, so neither it nor its SQL is kept. */
  | { v: 1; ts: string; recorder: 'postgres'; database?: string; tables: string[]; ok: boolean };

/**
 * Recording is on unless the group set `sourcesFooter: false`, decided once at runner boot. A file, not an
 * env var, because providers filter the environment they hand to MCP servers and shell commands, and every recorder
 * (the bridge, the Python tap, the `gws` shim) checks this same path.
 */
function enabledMarker(): string {
  return path.join(path.dirname(ledgerPath()), 'enabled');
}

export function setSourceRecording(enabled: boolean): void {
  try {
    if (enabled) {
      fs.mkdirSync(path.dirname(enabledMarker()), { recursive: true });
      fs.writeFileSync(enabledMarker(), '');
    } else {
      fs.rmSync(enabledMarker(), { force: true });
    }
  } catch {
    // Unwritable /tmp leaves recording off, which only drops the footer.
  }
}

/** Never throws: a recorder must not fail the call it records. */
export function appendLedgerEntry(entry: LedgerEntry): void {
  try {
    if (!fs.existsSync(enabledMarker())) return;
    const file = ledgerPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`);
  } catch {
    // A lost line drops a source from one footer; the footer says it is a recorded list, not a complete one.
  }
}

function recordingOn(): boolean {
  return fs.existsSync(enabledMarker());
}

/**
 * The cursor lives in SQLite so that one `BEGIN IMMEDIATE` serialises the runner and the `send_message` subprocess,
 * and a consumer that dies mid-take releases it with its process. Busy past the timeout: that reply goes without a
 * footer and the entries wait for the next one.
 */
function openCursorDb(): Database {
  const db = new Database(path.join(path.dirname(ledgerPath()), 'cursor.db'), { create: true });
  db.exec('PRAGMA busy_timeout = 100');
  db.exec('CREATE TABLE IF NOT EXISTS cursor (id INTEGER PRIMARY KEY CHECK (id = 1), offset INTEGER NOT NULL)');
  return db;
}

function readCompleteLines(file: string, start: number): { lines: string[]; end: number; size: number } | null {
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return null;
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    // A cursor past the end means the ledger was emptied or replaced; start over rather than skip its new lines.
    const from = start > size ? 0 : start;
    if (from === size) return { lines: [], end: from, size };
    const buf = Buffer.alloc(size - from);
    fs.readSync(fd, buf, 0, buf.length, from);
    const lastNewline = buf.lastIndexOf(0x0a);
    if (lastNewline === -1) return { lines: [], end: from, size };
    const text = buf.subarray(0, lastNewline).toString('utf8');
    return { lines: text.split('\n'), end: from + lastNewline + 1, size };
  } finally {
    fs.closeSync(fd);
  }
}

function parseEntry(line: string): LedgerEntry | null {
  if (!line.trim()) return null;
  try {
    const raw = JSON.parse(line) as Partial<LedgerEntry> & Record<string, unknown>;
    if (raw.v !== 1 || typeof raw.ts !== 'string' || typeof raw.ok !== 'boolean') return null;
    if (raw.recorder === 'mcp' && typeof raw.server === 'string' && typeof raw.tool === 'string')
      return raw as LedgerEntry;
    if (raw.recorder === 'snowflake' && typeof raw.sql === 'string') return raw as LedgerEntry;
    if (raw.recorder === 'gws' && Array.isArray(raw.argv) && raw.argv.every((a) => typeof a === 'string'))
      return raw as LedgerEntry;
    if (
      raw.recorder === 'postgres' &&
      Array.isArray(raw.tables) &&
      raw.tables.every((t) => typeof t === 'string') &&
      (raw.database === undefined || typeof raw.database === 'string')
    )
      return raw as LedgerEntry;
    return null;
  } catch {
    return null;
  }
}

/**
 * Never throws. The ledger is never rotated or truncated: a recorder may hold it open, and its append to a moved or
 * truncated file would be lost. The recorders' runaway ceiling bounds its size.
 */
function consume(): LedgerEntry[] {
  if (!recordingOn()) return [];
  let db: Database | null = null;
  try {
    db = openCursorDb();
    const cursorDb = db;
    const take = cursorDb.transaction((): LedgerEntry[] => {
      const row = cursorDb.query('SELECT offset FROM cursor WHERE id = 1').get() as { offset: number } | null;
      const read = readCompleteLines(ledgerPath(), row?.offset ?? 0);
      if (!read) return [];
      cursorDb
        .query('INSERT INTO cursor (id, offset) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET offset = excluded.offset')
        .run(read.end);
      return read.lines.map(parseEntry).filter((e): e is LedgerEntry => e !== null);
    });
    return take.immediate();
  } catch {
    return [];
  } finally {
    db?.close();
  }
}

/** Every entry recorded since the last take or discard; each entry is handed out once. */
export function takeUncredited(): LedgerEntry[] {
  return consume();
}

/** Drops entries no reply took, so a later turn never inherits them. */
export function discardUncredited(): void {
  consume();
}
