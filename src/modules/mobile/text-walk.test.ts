import fs from 'fs';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { allowWritesTo } from '../../test-hermeticity.js';
import { initArchiveSchema, writeArchiveRow } from '../../message-archive.js';
import { walkArchiveText, type ThreadHit, type WalkRequest } from './text-walk.js';

const ROOT = uniqueTmpRoot('mobile-text-walk');
const ARCHIVE = path.join(ROOT, 'archive.db');
/** The central DB's workgroups as each write reads them. */
const central = new Map<string, string>();
const scope = (workgroupId: string, platformId = 'slack:C1', threadIds: string[] = []) => ({
  tenantKey: `workgroup:${workgroupId}`,
  workgroupId,
  platformId,
  threadIds,
});
const SCOPES: WalkRequest['scopes'] = [scope('acme')];

let db: Database.Database;

beforeEach(() => {
  allowWritesTo(ROOT);
  fs.mkdirSync(ROOT, { recursive: true });
  db = new Database(ARCHIVE);
  db.pragma('journal_mode = TRUNCATE');
  initArchiveSchema(db);
  central.clear();
  for (const [agentGroupId, workgroupId] of [
    ['ag-1', 'acme'],
    ['ag-1b', 'acme'],
    ['ag-2', 'globex'],
  ])
    central.set(agentGroupId, workgroupId);
});

afterEach(() => {
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function archive(
  rows: Array<
    Partial<{
      id: string;
      agent: string;
      channelType: string;
      platform: string;
      thread: string;
      sentAt: string;
      text: string;
    }>
  >,
) {
  db.transaction(() => {
    for (const [at, row] of rows.entries()) {
      const agentGroupId = row.agent ?? 'ag-1';
      writeArchiveRow(
        db,
        {
          id: row.id ?? `m${at}`,
          agentGroupId,
          messagingGroupId: null,
          channelType: row.channelType ?? 'slack',
          channelName: null,
          platformId: row.platform ?? 'slack:C1',
          threadId: row.thread ?? `slack:C1:${at}.0`,
          role: 'user',
          senderId: 'slack:U1',
          senderName: 'Ana Example',
          senderIsBot: 0,
          text: row.text ?? 'the zeppelin landed',
          sentAt: row.sentAt ?? new Date().toISOString(),
        },
        { workgroupId: central.get(agentGroupId) ?? null },
      );
    }
  })();
}

function walk(overrides: Partial<WalkRequest> = {}): { batches: ThreadHit[][]; hits: ThreadHit[] } {
  const batches: ThreadHit[][] = [];
  walkArchiveText(
    {
      archivePath: ARCHIVE,
      match: 'text : ("zeppelin")',
      since: '2020-01-01T00:00:00.000Z',
      scopes: SCOPES,
      maxThreads: 100_000,
      ...overrides,
    },
    (hits) => batches.push(hits),
  );
  return { batches, hits: batches.flat() };
}

/** The arguments of every read of the archive, because how a read binds is not visible in what it returns. */
function recordReads(): unknown[][] {
  const reads: unknown[][] = [];
  const prepare = Database.prototype.prepare;
  vi.spyOn(Database.prototype, 'prepare').mockImplementation(function (this: Database.Database, sql: string) {
    const statement = prepare.call(this, sql);
    const all = statement.all.bind(statement) as (...args: unknown[]) => unknown[];
    statement.all = (...args: unknown[]) => {
      reads.push(args);
      return all(...args);
    };
    return statement;
  } as typeof prepare);
  return reads;
}

const byThread = (hits: ThreadHit[]) => [...hits].sort((a, b) => a.threadRef.localeCompare(b.threadRef));

describe('walkArchiveText', () => {
  it('reads newest first, a thousand rows at a time', () => {
    archive(Array.from({ length: 2_500 }, () => ({})));

    const { batches, hits } = walk();

    expect(batches.map((batch) => batch.length)).toEqual([1_000, 1_000, 500]);
    expect(hits[0]).toEqual({ workgroupId: 'acme', threadRef: 'slack:C1:2499.0' });
    expect(hits[hits.length - 1]).toEqual({ workgroupId: 'acme', threadRef: 'slack:C1:0.0' });
  });

  it('holds no lock between reads, so an archive write lands at once', () => {
    archive(Array.from({ length: 2_500 }, () => ({})));
    const writer = new Database(ARCHIVE, { timeout: 0 });
    writer.pragma('journal_mode = TRUNCATE');
    let writes = 0;

    walkArchiveText(
      {
        archivePath: ARCHIVE,
        match: 'text : ("zeppelin")',
        since: '2020',
        scopes: SCOPES,
        maxThreads: 100_000,
      },
      () => {
        writer.prepare(`UPDATE archive_row_marks SET mutations = mutations + 1`).run();
        writes += 1;
      },
    );
    writer.close();

    expect(writes).toBe(3);
  });

  it('reads only the tenants its scopes name, and only their scoped channels', () => {
    archive([
      { thread: 'slack:C1:1.0' },
      { agent: 'ag-1', platform: 'slack:C2', thread: 'slack:C2:2.0' },
      { agent: 'ag-2', thread: 'slack:C1:3.0' },
      { agent: 'ag-2', platform: 'slack:C3', thread: 'slack:C3:4.0' },
    ]);

    expect(byThread(walk().hits)).toEqual([{ workgroupId: 'acme', threadRef: 'slack:C1:1.0' }]);
    expect(
      byThread(
        walk({
          scopes: [...SCOPES, scope('globex', 'slack:C3')],
        }).hits,
      ),
    ).toEqual([
      { workgroupId: 'acme', threadRef: 'slack:C1:1.0' },
      { workgroupId: 'globex', threadRef: 'slack:C3:4.0' },
    ]);
  });

  const DISCORD = { channelType: 'discord', platform: 'discord:g1:c1' };
  const discordScope = (threadIds: string[]) => scope('acme', 'discord:g1:c1', threadIds);

  it.each([
    ['another tenant', { agent: 'ag-2' }, SCOPES],
    ['a channel of its own tenant it is not scoped to', { platform: 'slack:C2', thread: 'slack:C2:1.0' }, SCOPES],
    [
      'a Discord thread whose own check has not passed, in a channel that has',
      { ...DISCORD, thread: 'discord:g1:c1:private' },
      [...SCOPES, discordScope(['discord:g1:c1:open'])],
    ],
  ])('reads a word held only by %s exactly as it reads a word held nowhere', (_name, where, scopes) => {
    archive([
      { ...where, text: 'the zeppelin landed' },
      { thread: 'slack:C1:9.0', text: 'a quiet afternoon' },
    ]);
    const reads = recordReads();

    const held = walk({ match: 'text : ("zeppelin")', scopes }).hits;
    const heldReads = reads.splice(0).map(([, before, limit]) => [typeof before, limit]);
    const absent = walk({ match: 'text : ("absentword")', scopes }).hits;
    const absentReads = reads.splice(0).map(([, before, limit]) => [typeof before, limit]);

    expect(held).toEqual([]);
    expect(absent).toEqual([]);
    expect(heldReads).toEqual(absentReads);
  });

  it('reads a Discord channel’s own messages, and of its threads only those whose check passed', () => {
    archive([
      { ...DISCORD, thread: 'discord:g1:c1' },
      { ...DISCORD, thread: 'discord:g1:c1:open' },
      { ...DISCORD, thread: 'discord:g1:c1:private' },
    ]);

    expect(byThread(walk({ scopes: [discordScope(['discord:g1:c1:open'])] }).hits)).toEqual([
      { workgroupId: 'acme', threadRef: 'discord:g1:c1' },
      { workgroupId: 'acme', threadRef: 'discord:g1:c1:open' },
    ]);
  });

  it('reads an agent group’s messages in the workgroup it was in when it archived each one', () => {
    archive([{ id: 'before', agent: 'ag-1b', thread: 'slack:C1:1.0', text: 'the zeppelin landed' }]);
    central.set('ag-1b', 'globex');
    archive([{ id: 'after', agent: 'ag-1b', thread: 'slack:C1:2.0', text: 'the zeppelin left' }]);

    expect(walk({ scopes: [scope('acme')] }).hits).toEqual([{ workgroupId: 'acme', threadRef: 'slack:C1:1.0' }]);
    expect(walk({ scopes: [scope('globex')] }).hits).toEqual([{ workgroupId: 'globex', threadRef: 'slack:C1:2.0' }]);
  });

  it('reads nothing of a tenant nothing has been indexed for', () => {
    archive([{}]);
    const reads = recordReads();

    expect(walk({ scopes: [scope('initech')] }).hits).toEqual([]);
    expect(reads).toEqual([]);
  });

  it('finds a tenant’s message through any of its agents, whichever one archived it', () => {
    archive([{ agent: 'ag-1b', thread: 'slack:C1:1.0' }]);

    expect(walk().hits).toEqual([{ workgroupId: 'acme', threadRef: 'slack:C1:1.0' }]);
  });

  it('reports a thread once, however many sibling copies of a message it holds', () => {
    archive([
      { id: '1:bot-a', thread: 'slack:C1:1.0', sentAt: '2026-06-01T00:00:00.000Z' },
      { id: '1:bot-b', agent: 'ag-1b', thread: 'slack:C1:1.0', sentAt: '2026-06-01T00:00:00.000Z' },
    ]);

    expect(walk().hits).toEqual([{ workgroupId: 'acme', threadRef: 'slack:C1:1.0' }]);
  });

  it('stops at the thread budget of each tenant, so one never crowds out another', () => {
    archive([
      ...Array.from({ length: 1_500 }, (_, at) => ({ thread: `slack:C1:a${at}` })),
      ...Array.from({ length: 1_500 }, (_, at) => ({ agent: 'ag-2', thread: `slack:C1:b${at}` })),
    ]);

    const { hits } = walk({
      maxThreads: 1_200,
      scopes: [...SCOPES, scope('globex')],
    });

    expect(hits.filter((hit) => hit.workgroupId === 'acme')).toHaveLength(1_200);
    expect(hits.filter((hit) => hit.workgroupId === 'globex')).toHaveLength(1_200);
  });

  it('counts nothing past the window', () => {
    const stale = Array.from({ length: 1_000 }, () => ({ sentAt: '2026-01-01T00:00:00.000Z' }));
    const fresh = Array.from({ length: 1_000 }, () => ({ sentAt: '2026-06-01T00:00:00.000Z' }));
    archive([...stale, ...stale, ...stale, ...fresh]);

    const { batches } = walk({ since: '2026-03-01T00:00:00.000Z' });

    expect(batches.map((batch) => batch.length)).toEqual([1_000]);
  });

  it('finds a recent match beneath a full read of older ones, which recovery can archive after it', () => {
    const stale = Array.from({ length: 1_000 }, () => ({ sentAt: '2026-01-01T00:00:00.000Z' }));
    archive([{ thread: 'slack:C1:1.0', sentAt: '2026-06-01T00:00:00.000Z' }, ...stale]);

    expect(walk({ since: '2026-03-01T00:00:00.000Z' }).hits).toEqual([
      { workgroupId: 'acme', threadRef: 'slack:C1:1.0' },
    ]);
  });

  it('counts no row older than the window, in a read that never fills', () => {
    archive([
      { thread: 'slack:C1:1.0', sentAt: '2020-01-01T00:00:00.000Z' },
      { thread: 'slack:C1:2.0', sentAt: '2026-06-01T00:00:00.000Z' },
    ]);

    expect(walk({ since: '2026-03-01T00:00:00.000Z' }).hits).toEqual([
      { workgroupId: 'acme', threadRef: 'slack:C1:2.0' },
    ]);
  });

  it('binds the rowid as an integer, because FTS5 ignores any other bound and starts from the newest row', () => {
    archive(Array.from({ length: 1_500 }, () => ({})));
    const reads = recordReads();

    walk();
    const textReads = reads.filter((args) => args.length === 3);

    expect(textReads).toHaveLength(2);
    expect(textReads.map(([, before]) => typeof before)).toEqual(['bigint', 'bigint']);
  });

  it('reads nothing, and says the search fell short, until the boot migration has completed', () => {
    archive([{}]);
    db.prepare(`UPDATE archive_search_state SET value = '0' WHERE key = 'partitions_ready'`).run();
    const found: ThreadHit[] = [];

    const complete = walkArchiveText(
      {
        archivePath: ARCHIVE,
        match: 'text : ("zeppelin")',
        since: '2020',
        scopes: SCOPES,
        maxThreads: 10,
      },
      (hits) => found.push(...hits),
    );

    expect(complete).toBe(false);
    expect(found).toEqual([]);
  });

  it('refuses to create an archive that is not there', () => {
    expect(() => walk({ archivePath: path.join(ROOT, 'missing.db') })).toThrow();
    expect(fs.existsSync(path.join(ROOT, 'missing.db'))).toBe(false);
  });
});
