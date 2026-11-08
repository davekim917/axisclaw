import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Classification } from './classify.js';
import {
  RunClaimedError,
  executeRun,
  interruptedRuns,
  runResultLabel,
  type ExecuteDeps,
  type RunMeta,
} from './execute.js';
import type { SqlApiResponse } from './sql-api.js';
import type { ExecuteConfig } from './targets.js';

const EXECUTE: ExecuteConfig = {
  account: 'acme-xy12345',
  user: 'APPROVED_RUN_ACME',
  secret: 'approved-run-acme token',
  onecliAgent: 'approved-run-acme',
  warehouse: null,
};
const IDENTITY_OK = ['APPROVED_RUN_ACME', 'SECURITYADMIN', '{"roles":"","value":""}'];

let root: string;
let calls: Array<{ method: string; path: string; query: Record<string, string>; body?: Record<string, unknown> }>;

function classification(steps: Array<{ text: string; role?: string; database?: string }>): Classification {
  return {
    tier: 'card',
    denyReasons: [],
    classifierSha256: 'c'.repeat(64),
    statements: [
      { text: 'USE ROLE SECURITYADMIN;', kind: 'context', tier: 'none', role: 'SECURITYADMIN' },
      ...steps.map((s) => ({
        text: s.text,
        kind: 'create_role',
        tier: 'card' as const,
        role: s.role ?? 'SECURITYADMIN',
        database: s.database ?? null,
        schema: null,
        warehouse: null,
      })),
    ],
  };
}

function meta(runId = 'ag-1--req-1'): RunMeta {
  return {
    runId,
    target: 'acme',
    sha256: 'f'.repeat(64),
    reason: 'roles',
    agentGroupId: 'ag-1',
    sessionId: 'sess-1',
    approvedBy: 'Alice',
    decidedAt: new Date().toISOString(),
    route: null,
  };
}

/** Answers the identity check with `identity`, then each statement with `answer(text, attempt)`. */
function deps(
  answer: (text: string, attempt: number) => SqlApiResponse | Error = () => ({ status: 200, body: {} }),
  opts: { holders?: string[] | Error; identity?: unknown[] } = {},
): ExecuteDeps {
  const attempts = new Map<string, number>();
  return {
    api: async (method, p, query, body) => {
      calls.push({ method, path: p, query, body });
      const text = method === 'GET' ? `GET ${p}` : String(body?.statement);
      if (text.startsWith('SELECT CURRENT_USER()'))
        return { status: 200, body: { data: [opts.identity ?? IDENTITY_OK] } };
      const n = (attempts.get(text) ?? 0) + 1;
      attempts.set(text, n);
      const res = answer(text, n);
      if (res instanceof Error) throw res;
      return res;
    },
    holders: async () => {
      if (opts.holders instanceof Error) throw opts.holders;
      return opts.holders ?? ['approved-run-acme'];
    },
    sleep: async () => undefined,
    settled: () => undefined,
  };
}

function statementsSent(): string[] {
  return calls
    .filter((c) => c.method === 'POST' && !String(c.body?.statement).startsWith('SELECT CURRENT_USER()'))
    .map((c) => String(c.body?.statement));
}

beforeEach(() => {
  root = uniqueTmpRoot('approved-run-execute');
  calls = [];
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('executeRun', () => {
  it('sends each card statement verbatim, one per request, under its own role and context, as one-statement requests', async () => {
    const result = await executeRun(
      EXECUTE,
      classification([
        { text: 'CREATE ROLE AR_A;' },
        { text: 'CREATE ROLE AR_B;', role: 'USERADMIN', database: 'DEV' },
      ]),
      meta(),
      deps(),
      root,
    );
    expect(result.kind).toBe('done');
    const posts = calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path)).toEqual(['/api/v2/statements', '/api/v2/statements', '/api/v2/statements']);
    expect(posts[1].body).toEqual({
      statement: 'CREATE ROLE AR_A;',
      timeout: 600,
      role: 'SECURITYADMIN',
      parameters: { MULTI_STATEMENT_COUNT: '1', QUERY_TAG: 'approved-run ag-1--req-1 step 1' },
    });
    expect(posts[2].body).toMatchObject({ statement: 'CREATE ROLE AR_B;', role: 'USERADMIN', database: 'DEV' });
    expect(new Set(posts.map((c) => c.query.requestId)).size).toBe(3);
    expect(fs.existsSync(path.join(root, 'ag-1--req-1', 'finished.json'))).toBe(true);
  });

  it.each([
    ['a run that finished', () => deps(), 'done'],
    [
      'a run refused before its first statement',
      () => deps(undefined, { holders: ['approved-run-acme', 'ag-x'] }),
      'refused',
    ],
  ])('queues the report of %s before recording the run as finished', async (_name, makeDeps, kind) => {
    const finishedSeen: boolean[] = [];
    const settled: string[] = [];
    await executeRun(
      EXECUTE,
      classification([{ text: 'CREATE ROLE AR_A;' }]),
      meta(),
      {
        ...makeDeps(),
        settled: (result) => {
          settled.push(result.kind);
          finishedSeen.push(fs.existsSync(path.join(root, 'ag-1--req-1', 'finished.json')));
        },
      },
      root,
    );
    expect(settled).toEqual([kind]);
    expect(finishedSeen).toEqual([false]);
    expect(fs.existsSync(path.join(root, 'ag-1--req-1', 'finished.json'))).toBe(true);
  });

  it('stops at the first failed statement and never sends the ones after it', async () => {
    const result = await executeRun(
      EXECUTE,
      classification([{ text: 'CREATE ROLE AR_A;' }, { text: 'CREATE ROLE AR_B;' }, { text: 'CREATE ROLE AR_C;' }]),
      meta(),
      deps((text) =>
        text === 'CREATE ROLE AR_B;'
          ? { status: 422, body: { message: 'SQL compilation error', code: '002003' } }
          : { status: 200, body: {} },
      ),
      root,
    );
    expect(statementsSent()).toEqual(['CREATE ROLE AR_A;', 'CREATE ROLE AR_B;']);
    expect(result).toMatchObject({
      kind: 'done',
      total: 3,
      steps: [
        { outcome: { status: 'ok' } },
        { outcome: { status: 'failed', detail: 'HTTP 422: SQL compilation error (002003)' } },
      ],
    });
    expect(runResultLabel(result)).toBe('stopped at step 2 of 3 (failed)');
  });

  it('labels a run that ran every statement completed, and a refused one refused', async () => {
    const ran = await executeRun(
      EXECUTE,
      classification([{ text: 'CREATE ROLE AR_A;' }, { text: 'CREATE ROLE AR_B;' }]),
      meta(),
      deps(),
      root,
    );
    expect(runResultLabel(ran)).toBe('completed');
    const refused = await executeRun(
      EXECUTE,
      classification([{ text: 'CREATE ROLE AR_A;' }]),
      meta('ag-1--req-2'),
      deps(undefined, { holders: ['approved-run-acme', 'ag-x'] }),
      root,
    );
    expect(runResultLabel(refused)).toBe('refused');
  });

  it('resends a lost request under the same request id with retry=true, so Snowflake cannot run it twice', async () => {
    const result = await executeRun(
      EXECUTE,
      classification([{ text: 'CREATE ROLE AR_A;' }]),
      meta(),
      deps((_text, attempt) => (attempt === 1 ? new Error('socket hang up') : { status: 200, body: {} })),
      root,
    );
    const sends = calls.filter((c) => c.body?.statement === 'CREATE ROLE AR_A;');
    expect(sends).toHaveLength(2);
    expect(sends[0].query).toEqual({ requestId: sends[1].query.requestId });
    expect(sends[1].query.retry).toBe('true');
    expect(result).toMatchObject({ kind: 'done', steps: [{ outcome: { status: 'ok' } }] });
  });

  it('reports a statement whose answer never arrives as unknown and runs nothing after it', async () => {
    const result = await executeRun(
      EXECUTE,
      classification([{ text: 'CREATE ROLE AR_A;' }, { text: 'CREATE ROLE AR_B;' }]),
      meta(),
      deps((text) =>
        text === 'CREATE ROLE AR_A;' ? { status: 503, body: { message: 'unavailable' } } : { status: 200, body: {} },
      ),
      root,
    );
    expect(statementsSent().every((t) => t === 'CREATE ROLE AR_A;')).toBe(true);
    expect(result).toMatchObject({ kind: 'done', steps: [{ outcome: { status: 'unknown' } }] });
  });

  it.each([
    ['a poll is refused after Snowflake accepted the statement', 202],
    ['a resend is refused after the first answer was lost', 0],
  ])('keeps the outcome unknown when %s', async (_name, first) => {
    const handle = '01b2c3d4-0000-4000-8000-000000000002';
    const result = await executeRun(
      EXECUTE,
      classification([{ text: 'CREATE ROLE AR_A;' }, { text: 'CREATE ROLE AR_B;' }]),
      meta(),
      deps((text, attempt) => {
        if (text === 'CREATE ROLE AR_A;' && attempt === 1) {
          return first === 202 ? { status: 202, body: { statementHandle: handle } } : new Error('socket hang up');
        }
        return { status: 403, body: { message: 'forbidden' } };
      }),
      root,
    );
    expect(result).toMatchObject({ kind: 'done', steps: [{ outcome: { status: 'unknown' } }] });
    expect(statementsSent()).not.toContain('CREATE ROLE AR_B;');
  });

  it('calls a statement failed when Snowflake refuses it outright', async () => {
    const result = await executeRun(
      EXECUTE,
      classification([{ text: 'CREATE ROLE AR_A;' }]),
      meta(),
      deps(() => ({ status: 403, body: { message: 'forbidden' } })),
      root,
    );
    expect(result).toMatchObject({
      kind: 'done',
      steps: [{ outcome: { status: 'failed', detail: 'HTTP 403: forbidden' } }],
    });
  });

  it('follows a still-running statement by its handle until it finishes', async () => {
    const handle = '01b2c3d4-0000-4000-8000-000000000001';
    const result = await executeRun(
      EXECUTE,
      classification([{ text: 'CREATE ROLE AR_A;' }]),
      meta(),
      deps((text) =>
        text === 'CREATE ROLE AR_A;'
          ? { status: 202, body: { statementHandle: handle } }
          : { status: 200, body: { statementHandle: handle, data: [['done']] } },
      ),
      root,
    );
    expect(calls.filter((c) => c.method === 'GET').map((c) => c.path)).toEqual([`/api/v2/statements/${handle}`]);
    expect(result).toMatchObject({ kind: 'done', steps: [{ outcome: { status: 'ok', rows: [['done']] } }] });
  });

  it('never reuses a request id across runs, even under a run id whose record was deleted', async () => {
    const ids = async () => {
      calls = [];
      await executeRun(EXECUTE, classification([{ text: 'CREATE ROLE AR_A;' }]), meta(), deps(), root);
      fs.rmSync(path.join(root, 'ag-1--req-1'), { recursive: true });
      return calls.map((c) => c.query.requestId);
    };
    const first = await ids();
    const second = await ids();
    expect(first.filter((id) => second.includes(id))).toEqual([]);
  });

  it('runs a request at most once, however often it is approved', async () => {
    await executeRun(EXECUTE, classification([{ text: 'CREATE ROLE AR_A;' }]), meta(), deps(), root);
    calls = [];
    expect(() => executeRun(EXECUTE, classification([{ text: 'CREATE ROLE AR_A;' }]), meta(), deps(), root)).toThrow(
      RunClaimedError,
    );
    expect(calls).toEqual([]);
  });

  it.each([
    ['granted to another agent too', { holders: ['approved-run-acme', 'ag-other'] }, 'also granted to ag-other'],
    ['not granted to the lane agent', { holders: [] }, 'is not granted to approved-run-acme'],
    ['an unreadable vault', { holders: new Error('OneCLI GET /v1/agents failed') }, 'the vault could not be checked'],
    [
      'a session as another user',
      { identity: ['SOMEONE_ELSE', 'SECURITYADMIN', '{"roles":"","value":""}'] },
      'as SOMEONE_ELSE',
    ],
    [
      'a session under another role',
      { identity: ['APPROVED_RUN_ACME', 'SYSADMIN', '{"roles":"","value":""}'] },
      'runs as SYSADMIN, not SECURITYADMIN',
    ],
    [
      'secondary roles active',
      { identity: ['APPROVED_RUN_ACME', 'SECURITYADMIN', '{"roles":"SYSADMIN","value":""}'] },
      'secondary roles',
    ],
  ])('runs no statement when the token is %s', async (_name, opts, why) => {
    const result = await executeRun(
      EXECUTE,
      classification([{ text: 'CREATE ROLE AR_A;' }]),
      meta(),
      deps(undefined, opts),
      root,
    );
    expect(result.kind).toBe('refused');
    expect((result as { detail: string }).detail).toContain(why);
    expect(statementsSent()).toEqual([]);
  });

  it('runs no statement under a session name Snowflake would not read as written', async () => {
    const result = await executeRun(
      EXECUTE,
      classification([{ text: 'CREATE ROLE AR_A;', database: 'dev' }]),
      meta(),
      deps(),
      root,
    );
    expect(result.kind).toBe('refused');
    expect(calls).toEqual([]);
  });
});

describe('interruptedRuns', () => {
  function cutOff(runId: string, log: string): void {
    const dir = path.join(root, runId);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta(runId), steps: 3 }));
    fs.writeFileSync(path.join(dir, 'log.jsonl'), log);
  }
  const line = (step: number, status: string) => `${JSON.stringify({ step, status })}\n`;

  it.each([
    [
      'a torn last line',
      line(1, 'sending') + line(1, 'ok') + line(2, 'sending') + '{"step":2,"sta',
      { ran: 1, open: 2 },
    ],
    ['a step whose outcome was unknown', line(1, 'sending') + line(1, 'unknown'), { ran: 0, open: 1 }],
    [
      'a step that failed',
      line(1, 'sending') + line(1, 'ok') + line(2, 'sending') + line(2, 'failed'),
      { ran: 1, open: null },
    ],
    [
      'an entry that is valid JSON but not a step',
      line(1, 'sending') + line(1, 'ok') + 'null\n' + line(2, 'ok'),
      { ran: 1, open: null },
    ],
    [
      'an entry without a step number',
      line(1, 'sending') + line(1, 'ok') + '{"status":"ok"}\n',
      { ran: 1, open: null },
    ],
  ])('keeps what the log proves through %s', (_name, log, expected) => {
    cutOff('ag-1--req-7', log);
    expect(interruptedRuns(root).map(({ ran, open }) => ({ ran, open }))).toEqual([expected]);
  });

  it('names what a dead host proved ran and the step it sent without seeing an answer', () => {
    const dir = path.join(root, 'ag-1--req-9');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta('ag-1--req-9'), steps: 3 }));
    fs.writeFileSync(
      path.join(dir, 'log.jsonl'),
      ['sending', 'ok'].map((status) => JSON.stringify({ step: 1, status })).join('\n') +
        '\n' +
        JSON.stringify({ step: 2, status: 'sending' }) +
        '\n',
    );
    const finished = path.join(root, 'ag-1--req-8');
    fs.mkdirSync(finished);
    fs.writeFileSync(path.join(finished, 'meta.json'), JSON.stringify({ ...meta('ag-1--req-8'), steps: 1 }));
    fs.writeFileSync(path.join(finished, 'finished.json'), '{}');
    expect(interruptedRuns(root).map(({ meta: m, ran, open }) => ({ runId: m.runId, ran, open }))).toEqual([
      { runId: 'ag-1--req-9', ran: 1, open: 2 },
    ]);
  });

  it('skips a record that is not a run of its own directory, and still reports the good one beside it', () => {
    const bad: Record<string, unknown> = {
      'ag-1--null': null,
      'ag-1--number': 7,
      'ag-1--array': [],
      'ag-1--other': { ...meta('ag-1--elsewhere'), steps: 2 },
      'ag-1--nosteps': meta('ag-1--nosteps'),
      'ag-1--good': { ...meta('ag-1--good'), steps: 2 },
    };
    for (const [name, record] of Object.entries(bad)) {
      fs.mkdirSync(path.join(root, name), { recursive: true });
      fs.writeFileSync(path.join(root, name, 'meta.json'), JSON.stringify(record));
    }
    expect(interruptedRuns(root).map(({ meta: m, ran, open }) => ({ runId: m.runId, ran, open }))).toEqual([
      { runId: 'ag-1--good', ran: 0, open: null },
    ]);
  });
});
