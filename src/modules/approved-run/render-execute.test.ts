import * as fs from 'fs';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RunClaimedError, interruptedRuns, type RunMeta } from './execute.js';
import type { RenderApiResponse } from './render-api.js';
import { executeRenderRun, type RenderExecuteDeps, type RenderRunResult } from './render-execute.js';
import { maskValue } from './render-mask.js';
import { classifyRenderRequest, type RenderRequest } from './render-request.js';
import type { RenderExecuteConfig, RenderTarget } from './targets.js';

const EXECUTE: RenderExecuteConfig = {
  secret: 'approved-run-acme-render token',
  onecliAgent: 'approved-run-acme-render',
  adminUserId: 'usr-aaaaaaaaaaaaaaaaaaaa',
};
const REQUEST: RenderRequest = {
  method: 'PUT',
  path: '/v1/services/srv-aaaaaaaaaaaaaaaaaaaa/env-vars/FEATURE_X',
  body: { value: 'on' },
};
const TARGET: RenderTarget = {
  id: 'acme-render',
  label: 'Acme Render',
  entrySha: 'e'.repeat(64),
  kind: 'render',
  mode: 'execute',
  agentGroups: ['ag-1'],
  approvers: ['slack:U1'],
  execute: EXECUTE,
  resources: { 'srv-aaaaaaaaaaaaaaaaaaaa': { label: 'Acme backend', plaintextEnv: [] } },
};
const KEY = Buffer.alloc(32, 7);
const C = classifyRenderRequest(TARGET, REQUEST);

let root: string;
let writes: string[];
let settled: RenderRunResult[];

function meta(runId = 'ag-1--req-1'): RunMeta {
  return {
    runId,
    target: 'acme-render',
    sha256: 'f'.repeat(64),
    reason: 'flag',
    agentGroupId: 'ag-1',
    sessionId: 'sess-1',
    approvedBy: 'Alice',
    decidedAt: new Date().toISOString(),
    route: null,
  };
}

/** Render as the gateway shows it: `GET /v1/users` names `user`, and the write gets `write`. */
function deps(
  write: () => RenderApiResponse | Error,
  opts: { holders?: string[]; user?: string } = {},
): RenderExecuteDeps {
  return {
    api: async (method, p) => {
      if (method === 'GET' && p === '/v1/users') {
        return { status: 200, body: { id: opts.user ?? EXECUTE.adminUserId, email: 'admin@example.com' } };
      }
      writes.push(`${method} ${p}`);
      const res = write();
      if (res instanceof Error) throw res;
      return res;
    },
    holders: async () => opts.holders ?? [EXECUTE.onecliAgent],
    settled: (r) => settled.push(r),
    maskKey: KEY,
  };
}

beforeEach(() => {
  root = uniqueTmpRoot('render-execute-test');
  writes = [];
  settled = [];
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('executeRenderRun', () => {
  it('sends the approved request once and reports it settled', async () => {
    const result = await executeRenderRun(
      TARGET,
      C,
      meta(),
      deps(() => ({ status: 200, body: { key: 'FEATURE_X', value: 'on' } })),
      root,
    );
    expect(result).toEqual({ kind: 'ok', status: 200, body: { key: 'FEATURE_X', value: 'on' } });
    expect(writes).toEqual([`PUT ${REQUEST.path}`]);
    expect(settled).toEqual([result]);
  });

  it("stores Render's answer with the value it echoes masked, for a write Render accepted or refused", async () => {
    for (const [runId, status] of [
      ['ag-1--req-ok', 200],
      ['ag-1--req-no', 422],
    ] as const) {
      await executeRenderRun(
        TARGET,
        C,
        meta(runId),
        deps(() => ({ status, body: { key: 'FEATURE_X', value: 'on' } })),
        root,
      );
      const stored = JSON.parse(fs.readFileSync(path.join(root, runId, 'finished.json'), 'utf8')) as { body: unknown };
      expect(stored.body).toEqual({ key: 'FEATURE_X', value: maskValue('on', KEY) });
    }
  });

  it('records a lost answer as unknown and never resends the write', async () => {
    const result = await executeRenderRun(
      TARGET,
      C,
      meta(),
      deps(() => new Error('socket hang up')),
      root,
    );
    expect(result).toEqual({ kind: 'unknown', detail: 'no answer from Render: socket hang up' });
    expect(writes).toHaveLength(1);
  });

  it("treats Render's own 5xx as unknown, since the change may have landed", async () => {
    const result = await executeRenderRun(
      TARGET,
      C,
      meta(),
      deps(() => ({ status: 502, body: {} })),
      root,
    );
    expect(result.kind).toBe('unknown');
    expect(writes).toHaveLength(1);
  });

  it('reports a 4xx as a clean refusal', async () => {
    const result = await executeRenderRun(
      TARGET,
      C,
      meta(),
      deps(() => ({ status: 403, body: { message: 'forbidden' } })),
      root,
    );
    expect(result).toEqual({ kind: 'failed', status: 403, body: { message: 'forbidden' } });
  });

  it('sends nothing when the key belongs to another user', async () => {
    const result = await executeRenderRun(
      TARGET,
      C,
      meta(),
      deps(() => ({ status: 200, body: {} }), { user: 'usr-bbbbbbbbbbbbbbbbbbbb' }),
      root,
    );
    expect(result).toEqual({
      kind: 'refused',
      detail: `the token belongs to usr-bbbbbbbbbbbbbbbbbbbb, not ${EXECUTE.adminUserId}`,
    });
    expect(writes).toEqual([]);
  });

  it('sends nothing when the token is granted to anyone else', async () => {
    const result = await executeRenderRun(
      TARGET,
      C,
      meta(),
      deps(() => ({ status: 200, body: {} }), { holders: [EXECUTE.onecliAgent, 'ag-intruder'] }),
      root,
    );
    expect(result.kind).toBe('refused');
    expect(writes).toEqual([]);
  });

  it('runs a request id at most once', async () => {
    await executeRenderRun(
      TARGET,
      C,
      meta(),
      deps(() => ({ status: 200, body: {} })),
      root,
    );
    expect(() =>
      executeRenderRun(
        TARGET,
        C,
        meta(),
        deps(() => ({ status: 200, body: {} })),
        root,
      ),
    ).toThrow(RunClaimedError);
    expect(writes).toHaveLength(1);
  });

  it('leaves a record the next boot reports as unknown when the host dies after sending', async () => {
    await executeRenderRun(
      TARGET,
      C,
      meta(),
      deps(() => new Error('host killed')),
      root,
    );
    // A host that dies mid-request never writes finished.json; its log ends at the step it sent.
    fs.rmSync(path.join(root, 'ag-1--req-1', 'finished.json'));
    const [run] = interruptedRuns(root);
    expect(run).toMatchObject({ ran: 0, open: 1, meta: { runId: 'ag-1--req-1', steps: 1, kind: 'render' } });
  });
});
