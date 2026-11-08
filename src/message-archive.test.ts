import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_ROOT } = vi.hoisted(() => ({ TEST_ROOT: uniqueTmpRoot('message-archive-read-test') }));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_ROOT,
}));

const { logMock } = vi.hoisted(() => ({
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./log.js', () => ({ log: logMock }));

import Database from 'better-sqlite3';

import {
  __resetArchiveConnectionForTest,
  archiveCopiesOf,
  archiveMessage,
  archiveTextMatch,
  ensureArchiveSchema,
  initArchiveSchema,
  writeArchiveRow,
  parseArchivePermalinks,
  queryArchiveExactLinks,
  recentConversationSenders,
  sanitizeArchiveFtsQuery,
  searchArchiveEvidence,
  upsertArchiveMessage,
} from './message-archive.js';
import { archivePartitionId, archiveSearchTable } from './archive-search-index.js';

/** Archives as the writers do, under the workgroup the central DB has the agent group in at this write. */
function add(
  id: string,
  agentGroupId: string,
  text: string,
  threadId: string | null = 'discord:g:c:t',
  messagingGroupId = 'mg',
  workgroupId: string | null = null,
): void {
  upsertArchiveMessage(
    {
      id,
      agentGroupId,
      messagingGroupId,
      channelType: 'discord',
      channelName: 'room',
      platformId: 'discord:g:c',
      threadId,
      role: 'user',
      senderId: 'discord:u',
      senderName: 'Operator',
      text,
      sentAt: `2026-07-25T00:00:0${id.length}.000Z`,
    },
    { workgroupId },
  );
}

const evidence = (tenantKey: string, query: string) =>
  searchArchiveEvidence({
    tenantKey,
    query,
    currentMessagingGroupId: 'mg',
    currentThreadId: 'discord:g:c:t',
    currentNormalizedContent: '',
    candidateLimit: 20,
  }).map((row) => row.id);

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
});

afterEach(() => fs.rmSync(TEST_ROOT, { recursive: true, force: true }));

describe('archive retrieval helpers', () => {
  it('removes high-frequency stop words from bounded FTS candidate generation', () => {
    expect(sanitizeArchiveFtsQuery('Where is https://initech.com DNS hosted?')).toBe('"initech" OR "dns" OR "hosted"');
  });

  it('refuses every read of the index until the boot migration has completed', () => {
    add('1:ag-a', 'ag-a', 'The zeppelin landed', undefined, undefined, 'acme');
    const db = new Database(path.join(TEST_ROOT, 'archive.db'));
    db.prepare(`UPDATE archive_search_state SET value = '0' WHERE key = 'partitions_ready'`).run();
    db.close();
    const message = {
      platformId: 'discord:g:c',
      threadId: 'discord:g:c:t',
      sentAt: '2026-07-25T00:00:06.000Z',
      text: 'The zeppelin landed',
    };

    expect(() => evidence('workgroup:acme', 'zeppelin')).toThrow('boot migration');
    expect(() => evidence('workgroup:acme', 'the')).toThrow('boot migration');
    expect(() =>
      queryArchiveExactLinks({
        tenantKey: 'workgroup:acme',
        normalizedContent: 'https://discord.com/channels/123/456/789',
        candidateLimit: 5,
      }),
    ).toThrow('boot migration');
    expect(() =>
      archiveCopiesOf({
        tenantKey: 'workgroup:acme',
        messages: [message],
        currentMessagingGroupId: null,
        currentThreadId: null,
      }),
    ).toThrow('boot migration');
  });

  it('reads only its own tenant’s table and prioritizes the current thread', () => {
    add('a', 'ag-a', 'Initech DNS is managed in Wix.');
    add('b', 'ag-a', 'Initech DNS notes from another thread.', 'discord:g:c:other');
    add('x', 'ag-foreign', 'Initech DNS is managed by a malicious foreign row.');

    expect(evidence('agent-group:ag-a', 'Where is Initech DNS managed?')).toEqual(['a', 'b']);
    expect(evidence('agent-group:ag-nobody', 'Initech DNS')).toEqual([]);
  });

  it('returns every copy its workgroup recorded for a message, though it indexes one, and no other workgroup’s', () => {
    add('1:ag-a', 'ag-a', 'Initech DNS is managed in Wix.', undefined, undefined, 'acme');
    add('1:ag-b', 'ag-b', 'Initech DNS is managed in Wix.', undefined, undefined, 'acme');
    add('1:ag-c', 'ag-c', 'Initech DNS is managed in Wix.', undefined, undefined, 'globex');
    const db = new Database(path.join(TEST_ROOT, 'archive.db'));
    expect(
      db.prepare(`SELECT COUNT(*) AS n FROM ${archiveSearchTable(archivePartitionId(db, 'workgroup:acme')!)}`).get(),
    ).toEqual({ n: 1 });
    db.close();

    expect(evidence('workgroup:acme', 'Initech DNS').sort()).toEqual(['1:ag-a', '1:ag-b']);
  });

  it('finds a message by any of its copies’ sender names, through an edit to either copy', () => {
    const copy = (agentGroupId: string, senderName: string, text = 'The airship landed at noon.') =>
      upsertArchiveMessage(
        {
          id: `1:${agentGroupId}`,
          agentGroupId,
          messagingGroupId: 'mg',
          channelType: 'discord',
          channelName: 'room',
          platformId: 'discord:g:c',
          threadId: 'discord:g:c:t',
          role: 'user',
          senderId: 'discord:u',
          senderName,
          text,
          sentAt: '2026-07-25T00:00:01.000Z',
        },
        { workgroupId: 'acme' },
      );
    const byName = (name: string) => evidence('workgroup:acme', name).sort();
    copy('ag-a', 'Ana Example');
    copy('ag-b', 'Bea Example');

    expect(byName('Bea')).toEqual(['1:ag-a', '1:ag-b']);

    copy('ag-b', 'Cyd Example');
    expect(byName('Cyd')).toEqual(['1:ag-a', '1:ag-b']);
    expect(byName('Bea')).toEqual([]);

    copy('ag-a', 'Ana Example', 'The airship left at dawn.');
    expect(byName('Cyd')).toEqual(['1:ag-b']);
    expect(byName('Ana')).toEqual(['1:ag-a']);
  });

  it('finds an agent group’s message in the workgroup it was in when it archived it, and only there', () => {
    add('1:ag-b', 'ag-b', 'Initech DNS is managed in Wix.', undefined, undefined, 'acme');
    add('22:ag-b', 'ag-b', 'Initech DNS moved to a new registrar.', undefined, undefined, 'globex');

    expect(evidence('workgroup:acme', 'Initech DNS')).toEqual(['1:ag-b']);
    expect(evidence('workgroup:globex', 'Initech DNS')).toEqual(['22:ag-b']);
  });

  it('uses the actual messaging group as the current-thread boundary when thread_id is null', () => {
    add('dm-current', 'ag-a', 'Deployment owner is Jordan.', null, 'mg-current');
    add('dm-other', 'ag-a', 'Deployment owner is Taylor with extra deployment detail.', null, 'mg-other');

    const rows = searchArchiveEvidence({
      tenantKey: 'agent-group:ag-a',
      query: 'deployment owner',
      currentMessagingGroupId: 'mg-current',
      currentThreadId: null,
      currentNormalizedContent: '',
      candidateLimit: 20,
    });

    expect(rows.map((row) => row.id)).toEqual(['dm-current', 'dm-other']);
    expect(rows.map((row) => row.rank)).toEqual(['current-thread', 'workgroup']);
  });

  it('parses and resolves exact Slack/Discord permalinks with trusted scope only', () => {
    upsertArchiveMessage(
      {
        id: 'slack-row',
        agentGroupId: 'ag-a',
        messagingGroupId: 'mg-s',
        channelType: 'slack-team',
        channelName: 'ops',
        platformId: 'slack:C123ABC',
        threadId: 'slack:C123ABC:1770000000.123456',
        role: 'user',
        senderId: 'slack:U1',
        senderName: 'Operator',
        text: 'Slack exact evidence',
        sentAt: '2026-07-25T00:00:00.000Z',
      },
      { workgroupId: null },
    );
    upsertArchiveMessage(
      {
        id: '333333333333333333:ag-a',
        agentGroupId: 'ag-a',
        messagingGroupId: 'mg-d',
        channelType: 'discord',
        channelName: 'ops',
        platformId: 'discord:111111111111111111:222222222222222222',
        threadId: 'discord:111111111111111111:222222222222222222:444444444444444444',
        role: 'user',
        senderId: 'discord:U1',
        senderName: 'Operator',
        text: 'Discord exact evidence',
        sentAt: '2026-07-25T00:00:01.000Z',
      },
      { workgroupId: null },
    );
    const query =
      'Compare https://acme.slack.com/archives/C123ABC/p1770000000123456?thread_ts=1770000000.123456 and https://discord.com/channels/111111111111111111/444444444444444444/333333333333333333';
    expect(parseArchivePermalinks(query)).toHaveLength(2);
    expect(
      queryArchiveExactLinks({ tenantKey: 'agent-group:ag-a', normalizedContent: query, candidateLimit: 10 }).map(
        (r) => r.id,
      ),
    ).toEqual(['slack-row', '333333333333333333:ag-a']);
    expect(
      queryArchiveExactLinks({ tenantKey: 'agent-group:ag-foreign', normalizedContent: query, candidateLimit: 10 }),
    ).toEqual([]);
    expect(
      queryArchiveExactLinks({ tenantKey: 'agent-group:ag-nobody', normalizedContent: query, candidateLimit: 10 }),
    ).toEqual([]);
  });

  it('resolves a link to a moved agent group’s earlier message, and finds its copies, only in the old workgroup', () => {
    upsertArchiveMessage(
      {
        id: '333333333333333333:ag-b',
        agentGroupId: 'ag-b',
        messagingGroupId: 'mg',
        channelType: 'discord',
        channelName: 'room',
        platformId: 'discord:111111111111111111:444444444444444444',
        threadId: null,
        role: 'user',
        senderId: 'discord:u',
        senderName: 'Operator',
        text: 'Initech DNS is managed in Wix.',
        sentAt: '2026-07-25T00:00:01.000Z',
      },
      { workgroupId: 'acme' },
    );
    const query = 'https://discord.com/channels/111111111111111111/444444444444444444/333333333333333333';
    const linked = (tenantKey: string) =>
      queryArchiveExactLinks({ tenantKey, normalizedContent: query, candidateLimit: 10 }).map((row) => row.id);
    const copies = (tenantKey: string) =>
      archiveCopiesOf({
        tenantKey,
        messages: [
          {
            platformId: 'discord:111111111111111111:444444444444444444',
            threadId: null,
            sentAt: '2026-07-25T00:00:01.000Z',
            text: 'Initech DNS is managed in Wix.',
          },
        ],
        currentMessagingGroupId: 'mg',
        currentThreadId: null,
      }).map((found) => found.map((row) => row.id));

    expect([linked('workgroup:acme'), copies('workgroup:acme')]).toEqual([
      ['333333333333333333:ag-b'],
      [['333333333333333333:ag-b']],
    ]);
    expect([linked('workgroup:globex'), copies('workgroup:globex')]).toEqual([[], [[]]]);
  });

  it('resolves a Discord thread permalink by routing when an outbound platform message id was not archived', () => {
    for (const [id, agentGroupId, text] of [
      ['internal-assistant-id', 'ag-a', 'Assistant thread evidence'],
      ['foreign-id', 'ag-foreign', 'Foreign thread evidence'],
    ] as const) {
      upsertArchiveMessage(
        {
          id,
          agentGroupId,
          messagingGroupId: 'mg-d',
          channelType: 'discord',
          channelName: 'ops',
          platformId: 'discord:111111111111111111:222222222222222222',
          threadId: 'discord:111111111111111111:222222222222222222:444444444444444444',
          role: 'assistant',
          senderId: agentGroupId,
          senderName: 'assistant',
          text,
          sentAt: '2026-07-25T00:00:02.000Z',
        },
        { workgroupId: null },
      );
    }

    const query = 'Read https://discord.com/channels/111111111111111111/444444444444444444/999999999999999999';
    expect(
      queryArchiveExactLinks({ tenantKey: 'agent-group:ag-a', normalizedContent: query, candidateLimit: 10 }).map(
        (row) => row.id,
      ),
    ).toEqual(['internal-assistant-id']);
  });

  it('does not broaden an unknown Discord root-channel message link to unrelated channel history', () => {
    upsertArchiveMessage(
      {
        id: 'unrelated-root-message:ag-a',
        agentGroupId: 'ag-a',
        messagingGroupId: 'mg-d',
        channelType: 'discord',
        channelName: 'ops',
        platformId: 'discord:111111111111111111:222222222222222222',
        threadId: null,
        role: 'user',
        senderId: 'discord:U1',
        senderName: 'Operator',
        text: 'Unrelated channel-root evidence',
        sentAt: '2026-07-25T00:00:03.000Z',
      },
      { workgroupId: null },
    );

    const query = 'Read https://discord.com/channels/111111111111111111/222222222222222222/999999999999999999';
    expect(
      queryArchiveExactLinks({ tenantKey: 'agent-group:ag-a', normalizedContent: query, candidateLimit: 10 }),
    ).toEqual([]);
  });

  // idx_archive_conv_recent lets the planner satisfy `ORDER BY sent_at DESC,
  // id DESC` by walking the index instead of temp-B-tree sorting. That is only
  // result-preserving because `id` is a UNIQUE primary key, which makes the
  // tie-break total — sent_at alone is not (47k duplicated values on the live
  // archive). Pin the ordering under duplicate sent_at so a future index or
  // ORDER BY edit that drops the tie-break fails here.
  it('orders sender recall by the total (sent_at, id) key when sent_at ties', () => {
    for (const id of ['m-b', 'm-a', 'm-c']) {
      upsertArchiveMessage(
        {
          id,
          agentGroupId: 'ag-a',
          messagingGroupId: 'mg-tie',
          channelType: 'discord',
          channelName: 'room',
          platformId: 'discord:g:c',
          threadId: 'discord:g:c:t',
          role: 'user',
          senderId: `discord:${id}`,
          senderName: `Sender ${id}`,
          text: `tie ${id}`,
          sentAt: '2026-07-25T00:00:05.000Z',
        },
        { workgroupId: null },
      );
    }

    expect(
      recentConversationSenders({
        memberAgentGroupIds: ['ag-a'],
        messagingGroupId: 'mg-tie',
        threadId: 'discord:g:c:t',
      }),
    ).toEqual([
      { senderName: 'Sender m-c', senderId: 'discord:m-c' },
      { senderName: 'Sender m-b', senderId: 'discord:m-b' },
      { senderName: 'Sender m-a', senderId: 'discord:m-a' },
    ]);
  });

  // Guards the sender_id-keyed dedupe: a shared per-message display name must
  // not collapse two distinct people into one, and a mid-thread rename must
  // not leave two rows for the same person.
  it('keeps both senders when two different sender_ids share a display name', () => {
    upsertArchiveMessage(
      {
        id: 'sam-1',
        agentGroupId: 'ag-a',
        messagingGroupId: 'mg-samename',
        channelType: 'discord',
        channelName: 'room',
        platformId: 'discord:g:c',
        threadId: 'discord:g:c:t',
        role: 'user',
        senderId: 'discord:sam-1',
        senderName: 'Sam',
        text: 'first Sam',
        sentAt: '2026-07-25T00:00:01.000Z',
      },
      { workgroupId: null },
    );
    upsertArchiveMessage(
      {
        id: 'sam-2',
        agentGroupId: 'ag-a',
        messagingGroupId: 'mg-samename',
        channelType: 'discord',
        channelName: 'room',
        platformId: 'discord:g:c',
        threadId: 'discord:g:c:t',
        role: 'user',
        senderId: 'discord:sam-2',
        senderName: 'Sam',
        text: 'second Sam',
        sentAt: '2026-07-25T00:00:02.000Z',
      },
      { workgroupId: null },
    );

    expect(
      recentConversationSenders({
        memberAgentGroupIds: ['ag-a'],
        messagingGroupId: 'mg-samename',
        threadId: 'discord:g:c:t',
      }),
    ).toEqual([
      { senderName: 'Sam', senderId: 'discord:sam-2' },
      { senderName: 'Sam', senderId: 'discord:sam-1' },
    ]);
  });

  it('keeps only the newest name for a sender_id that renamed mid-thread', () => {
    upsertArchiveMessage(
      {
        id: 'rename-1',
        agentGroupId: 'ag-a',
        messagingGroupId: 'mg-rename',
        channelType: 'discord',
        channelName: 'room',
        platformId: 'discord:g:c',
        threadId: 'discord:g:c:t',
        role: 'user',
        senderId: 'discord:renamed',
        senderName: 'Morgan',
        text: 'before rename',
        sentAt: '2026-07-25T00:00:01.000Z',
      },
      { workgroupId: null },
    );
    upsertArchiveMessage(
      {
        id: 'rename-2',
        agentGroupId: 'ag-a',
        messagingGroupId: 'mg-rename',
        channelType: 'discord',
        channelName: 'room',
        platformId: 'discord:g:c',
        threadId: 'discord:g:c:t',
        role: 'user',
        senderId: 'discord:renamed',
        senderName: 'Morgan Lee',
        text: 'after rename',
        sentAt: '2026-07-25T00:00:02.000Z',
      },
      { workgroupId: null },
    );

    expect(
      recentConversationSenders({
        memberAgentGroupIds: ['ag-a'],
        messagingGroupId: 'mg-rename',
        threadId: 'discord:g:c:t',
      }),
    ).toEqual([{ senderName: 'Morgan Lee', senderId: 'discord:renamed' }]);
  });
});

describe('archive evidence candidate ordering', () => {
  // Pins the CTE tie-break in searchArchiveEvidence. 12 rows share one text, so
  // they share a bm25 score and a current_rank; candidateLimit 1 sets the inner
  // cut at 8, which lands inside that tie. rowid ASC keeps the 8 oldest rowids,
  // and the outer sort (sent_at DESC) then picks m07 as the newest survivor.
  //
  // Honest scope: deleting ', copy.rowid ASC' does NOT currently
  // fail this — SQLite happens to emit FTS matches in rowid order and its sorter
  // is stable, so the result is the same either way (verified). This is a
  // determinism pin, not a tripwire: it fails if a SQLite upgrade, a new index,
  // or a CTE rewrite ever makes the tied set come out in a different order.
  it('keeps a tie-straddling candidate cut deterministic', () => {
    for (let i = 0; i < 12; i++) {
      upsertArchiveMessage(
        {
          id: `m${String(i).padStart(2, '0')}`,
          agentGroupId: 'ag-a',
          messagingGroupId: 'mg-1',
          channelType: 'slack',
          channelName: 'room',
          platformId: 'slack:C1',
          threadId: 'thr-other',
          role: 'user',
          senderId: 'slack:U1',
          senderName: 'Sender',
          text: 'alpha',
          sentAt: `2026-07-${String(10 + i).padStart(2, '0')}T00:00:00.000Z`,
        },
        { workgroupId: null },
      );
    }

    const rows = searchArchiveEvidence({
      tenantKey: 'agent-group:ag-a',
      query: 'alpha',
      currentMessagingGroupId: 'mg-1',
      currentThreadId: 'thr-current',
      currentNormalizedContent: 'unrelated current message',
      candidateLimit: 1,
    });

    expect(rows.map((r) => r.id)).toEqual(['m07']);
  });
});

describe('archiveMessage', () => {
  const message = (id: string, text: string) => ({
    id,
    agentGroupId: 'ag-a',
    messagingGroupId: 'mg-a',
    channelType: 'discord',
    channelName: 'ops',
    platformId: 'discord:g:c',
    threadId: 'discord:g:c:t',
    role: 'user' as const,
    senderId: 'discord:u',
    senderName: 'Operator',
    text,
    sentAt: '2026-07-26T00:00:00.000Z',
  });

  const found = (query: string) =>
    searchArchiveEvidence({
      tenantKey: 'agent-group:ag-a',
      query,
      currentMessagingGroupId: 'mg-a',
      currentThreadId: 'discord:g:c:t',
      currentNormalizedContent: '',
      candidateLimit: 20,
    }).map((row) => row.id);

  it('writes the row and reports it', () => {
    expect(archiveMessage(message('a-1', 'durable archive text'), { workgroupId: null })).toBe(true);
    expect(found('durable archive')).toEqual(['a-1']);
  });

  it('reports false for empty text instead of writing', () => {
    expect(archiveMessage(message('a-2', ''), { workgroupId: null })).toBe(false);
    expect(found('durable archive')).toEqual([]);
  });

  it.each([
    ['another role', { role: 'assistant' as const }],
    ['another sender', { senderId: 'discord:someone-else' }],
    ['another agent group', { agentGroupId: 'ag-b' }],
  ])("a row reusing a person's message id from %s cannot rewrite what they said", (_label, rewrite) => {
    archiveMessage(message('a-said', 'no, withdrawn'), { workgroupId: null });
    archiveMessage({ ...message('a-said', 'replacement wording'), ...rewrite }, { workgroupId: null });

    expect(found('withdrawn')).toEqual(['a-said']);
    expect(found('replacement')).toEqual([]);
  });

  // router.ts's non-engaged session skip uses the boolean as a durability
  // precondition, so a write failure must surface rather than be swallowed.
  it('throws on a write failure rather than reporting success', () => {
    expect(() =>
      archiveMessage({ ...message('a-3', 'text'), sentAt: null as unknown as string }, { workgroupId: null }),
    ).toThrow();
  });
});

describe('#360 — the archive schema is materialized at startup', () => {
  function schemaObjects(): string[] {
    const db = new Database(path.join(TEST_ROOT, 'archive.db'), { readonly: true });
    try {
      return (
        db
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE name IN ('archive_row_marks', 'messages_archive_mark_update', 'messages_archive_mark_delete')
              ORDER BY name`,
          )
          .all() as Array<{ name: string }>
      ).map((row) => row.name);
    } finally {
      db.close();
    }
  }

  it('creates the marks table and both triggers, and says so exactly once', () => {
    logMock.info.mockClear();

    // First call on a host that has never opened the archive: the whole point
    // of the eager call is that this happens at boot rather than on the first
    // chat message, because until it does every projection stamp fails closed
    // and every spawn does the full rebuild.
    ensureArchiveSchema();
    expect(schemaObjects()).toEqual([
      'archive_row_marks',
      'messages_archive_mark_delete',
      'messages_archive_mark_update',
    ]);

    const created = logMock.info.mock.calls.filter((call) => call[0] === 'Archive row-marks schema created');
    expect(created).toHaveLength(1);
    expect(created[0][1]).toHaveProperty('ms');
    expect(typeof (created[0][1] as { ms: unknown }).ms).toBe('number');
  });

  it('is a no-op on every later boot', () => {
    ensureArchiveSchema();
    logMock.info.mockClear();

    // A fresh connection, as a restarted host would open — not the cached one.
    __resetArchiveConnectionForTest();
    ensureArchiveSchema();

    expect(schemaObjects()).toHaveLength(3);
    expect(logMock.info.mock.calls.filter((call) => call[0] === 'Archive row-marks schema created')).toEqual([]);
  });

  it('counts an edit but not an idempotent re-archive', () => {
    ensureArchiveSchema();
    add('marks-1', 'ag-test-a', 'original text');
    expect(markCount('ag-test-a')).toBe(0);

    // Same content again: the trigger is guarded, so nothing moves.
    add('marks-1', 'ag-test-a', 'original text');
    expect(markCount('ag-test-a')).toBe(0);

    // Changed text: counted.
    add('marks-1', 'ag-test-a', 'edited text');
    expect(markCount('ag-test-a')).toBe(1);
  });

  function markCount(agentGroupId: string): number {
    const db = new Database(path.join(TEST_ROOT, 'archive.db'), { readonly: true });
    try {
      const row = db
        .prepare('SELECT COALESCE(SUM(mutations), 0) AS n FROM archive_row_marks WHERE agent_group_id = ?')
        .get(agentGroupId) as { n: number };
      return row.n;
    } finally {
      db.close();
    }
  }
});

describe('archiveTextMatch', () => {
  it.each<[string, string]>([
    ['Zeppelin', 'text : ("zeppelin"*)'],
    ['feature branch', 'text : ("feature" "branch"*)'],
    ['con', 'text : ("con"*)'],
    ['br', 'text : ("br")'],
    ['x-br', 'text : ("br")'],
    ['foo-', 'text : ("foo"*)'],
    ['x-con', 'text : ("con"*)'],
    ['zeppelin-harbour', 'text : ("zeppelin" "harbour"*)'],
    ['snake_case', 'text : ("snake" "case"*)'],
    ['zeppelin OR walrus', 'text : ("zeppelin" "or" "walrus"*)'],
    ['s-s-s-s', ''],
    ['s_s_s_s', ''],
    ['s.s.s.s', ''],
    ['s/s/s/s', ''],
    ["s's's's", ''],
    ['s:s:s:s', ''],
    ['s\uff0ds\uff0ds', ''],
    ['s\u19b0s\u19b0s', ''],
    ['s\u1cf2s\u1cf2s', ''],
    ['ab-ab-ab-ab', 'text : ("ab")'],
    ['not not not', 'text : ("not"*)'],
    ['ab.cd.ab.cd', 'text : ("ab" "cd")'],
    ['the zeppelin', 'text : ("zeppelin"*)'],
    ['the', ''],
    ['a', ''],
    ['--', ''],
    ['-_-', ''],
    ['"*():{}^', ''],
  ])('turns %j into %j', (query, match) => {
    expect(archiveTextMatch(query)).toBe(match);
  });

  it('keeps one prefix and eight terms however long the text, because each one costs every statement', () => {
    const match = archiveTextMatch(Array.from({ length: 30 }, (_, at) => `term${at}`).join(' '));
    expect(match.match(/\*/g)).toHaveLength(1);
    expect(match.match(/"term/g)).toHaveLength(8);
  });

  it('leaves no quoted term that FTS5 would split into a phrase, whatever the character', () => {
    const terms: string[] = [];
    for (let codePoint = 0x80; codePoint <= 0x10ffff; codePoint += 1) {
      if (codePoint >= 0xd800 && codePoint <= 0xdfff) continue;
      const character = String.fromCodePoint(codePoint);
      if (!/[\p{L}\p{N}]/u.test(character)) continue;
      for (const [, term] of archiveTextMatch(`ab${character}cd`).matchAll(/"([^"]+)"/g)) terms.push(term);
    }
    const db = new Database(':memory:');
    initArchiveSchema(db);
    writeArchiveRow(
      db,
      {
        id: 'm1',
        agentGroupId: 'ag-1',
        messagingGroupId: null,
        channelType: 'slack',
        channelName: null,
        platformId: 'slack:C1',
        threadId: null,
        role: 'user',
        senderId: 'slack:U1',
        senderName: '',
        senderIsBot: 0,
        text: terms.join(' '),
        sentAt: '2026-06-01T00:00:00.000Z',
      },
      { workgroupId: null },
    );
    db.exec(
      `CREATE VIRTUAL TABLE tokens USING fts5vocab(${archiveSearchTable(archivePartitionId(db, 'agent-group:ag-1')!)}, 'instance');`,
    );

    expect(terms.length).toBeGreaterThan(100_000);
    expect(db.prepare(`SELECT count(*) FROM tokens WHERE col = 'text'`).pluck().get()).toBe(terms.length);
    db.close();
  });
});
