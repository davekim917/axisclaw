import Database from 'better-sqlite3';

import {
  archiveChannelToken,
  archivePartitionId,
  archiveSearchReady,
  archiveSearchTable,
  archiveThreadToken,
} from '../../archive-search-index.js';

/** One wiring the walk may read through: its agent group's tenant, and that one channel of it. */
interface WalkScope {
  /** `archiveTenantKey` of the wiring's agent group, from the same central read as the wiring. */
  tenantKey: string;
  /** The tenant as the list names it. */
  workgroupId: string;
  platformId: string;
  /** The Discord threads in this channel this person may search: no other thread of it is read. */
  threadIds: string[];
}

export interface WalkRequest {
  archivePath: string;
  match: string;
  since: string;
  scopes: WalkScope[];
  /** Per tenant, so one tenant's matches never crowd out another's. */
  maxThreads: number;
}

export interface ThreadHit {
  workgroupId: string;
  threadRef: string;
}

interface HitRow {
  at: bigint;
  platform_id: string | null;
  thread_id: string | null;
  role: string;
  sent_at: string;
}

interface PartitionWalk {
  partitionId: number;
  workgroupId: string;
  scopeTokens: Set<string>;
}

/**
 * One statement holds the file's read lock, which blocks every archive write, and those run on the host's main thread.
 * `Worker.terminate()` waits for a native call to return, so this size is also how soon a walk can be stopped.
 */
const ROWS_PER_READ = 1000;
const BUSY_WAIT_MS = 200;

const readHits = (table: string) => `
  SELECT hit.rowid AS at, a.platform_id, a.thread_id, a.role, a.sent_at
    FROM (SELECT rowid FROM ${table}
           WHERE ${table} MATCH ? AND rowid < ?
           ORDER BY rowid DESC LIMIT ?) hit
    JOIN messages_archive a ON a.rowid = hit.rowid
   ORDER BY hit.rowid DESC`;

/** The tenants this walk's scopes name, and which of their channels and threads. */
function partitionsToWalk(db: Database.Database, request: WalkRequest): PartitionWalk[] {
  const walks = new Map<string, PartitionWalk | null>();
  for (const scope of request.scopes) {
    let walk = walks.get(scope.tenantKey);
    if (walk === undefined) {
      const partitionId = archivePartitionId(db, scope.tenantKey);
      walk = partitionId === undefined ? null : { partitionId, workgroupId: scope.workgroupId, scopeTokens: new Set() };
      walks.set(scope.tenantKey, walk);
    }
    if (!walk) continue;
    walk.scopeTokens.add(archiveChannelToken(scope.platformId));
    for (const threadId of scope.threadIds) walk.scopeTokens.add(archiveThreadToken(threadId));
  }
  return [...walks.values()]
    .filter((walk): walk is PartitionWalk => walk !== null)
    .sort((a, b) => a.partitionId - b.partitionId);
}

/** The scope filter rides in the MATCH, so a channel or thread the caller cannot see costs SQLite a doclist and no more. */
function matchFor(match: string, scopeTokens: Set<string>): string {
  return `${match} AND channel : (${[...scopeTokens].map((token) => `"${token}"`).join(' OR ')})`;
}

/**
 * Newest first within each tenant, one bounded read at a time with no lock held between reads. A row past the window
 * counts for nothing but does not end the walk: recovery archives an old message after newer ones, so rowids do not
 * follow `sent_at`. Synchronous: run it on a worker, never on the host's main thread. False, having read nothing, until
 * the boot migration has placed every row: every word then answers alike, and the caller says the search fell short.
 */
export function walkArchiveText(request: WalkRequest, found: (hits: ThreadHit[]) => void): boolean {
  const { archivePath, since, maxThreads } = request;
  const db = new Database(archivePath, { readonly: true, fileMustExist: true, timeout: BUSY_WAIT_MS });
  try {
    if (!archiveSearchReady(db)) return false;
    const windowStart = Date.parse(since);
    for (const walk of partitionsToWalk(db, request)) {
      // FTS5 ignores a rowid bound that is not an integer, and better-sqlite3 binds a JS number as REAL: every read
      // would start over from the newest row.
      const read = db.prepare(readHits(archiveSearchTable(walk.partitionId))).safeIntegers();
      const match = matchFor(request.match, walk.scopeTokens);
      const seen = new Set<string>();
      let before = BigInt(Number.MAX_SAFE_INTEGER);
      while (seen.size < maxThreads) {
        const rows = read.all(match, before, ROWS_PER_READ) as HitRow[];
        const fresh: ThreadHit[] = [];
        for (const row of rows) {
          if (!row.platform_id || row.role === 'system') continue;
          if (Date.parse(row.sent_at) < windowStart) continue;
          const threadRef = row.thread_id || row.platform_id;
          if (seen.has(threadRef) || seen.size >= maxThreads) continue;
          seen.add(threadRef);
          fresh.push({ workgroupId: walk.workgroupId, threadRef });
        }
        if (fresh.length > 0) found(fresh);
        if (rows.length < ROWS_PER_READ) break;
        before = rows[rows.length - 1]!.at;
      }
    }
    return true;
  } finally {
    db.close();
  }
}
