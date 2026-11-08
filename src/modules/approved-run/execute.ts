/**
 * The host runs an approved file itself, one Snowflake SQL API request per classified statement,
 * as the target's service user. The request carries `MULTI_STATEMENT_COUNT: 1`, so Snowflake itself refuses a
 * request holding more than the one statement the card showed.
 *
 * The run directory is the exactly-once claim, made before any request is sent, and its log is written before and
 * after every step, so a host that dies mid-run leaves a record of which steps ran and which one is unknown.
 * Snowflake DDL commits per statement, so the run stops at the first failure.
 */
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { log } from '../../log.js';

import type { Classification } from './classify.js';
import type { SqlApi, SqlApiResponse } from './sql-api.js';
import { APPROVED_RUN_DIR, type ExecuteConfig } from './targets.js';

const RUNS_DIR = path.join(APPROVED_RUN_DIR, 'runs');
const STATEMENTS = '/api/v2/statements';
const STATEMENT_TIMEOUT_S = 600;
const POLL_MS = 2_000;
const POLL_DEADLINE_MS = (STATEMENT_TIMEOUT_S + 60) * 1000;
/** Resends with `retry=true`, which Snowflake does not re-execute once the request id has succeeded. */
const RESENDS = 3;
const UPPER_NAME = /^[A-Z_][A-Z0-9_$]{0,254}$/;
const HANDLE_RE = /^[0-9a-f-]{36}$/;
const ROWS_KEPT = 50;

export interface RunMeta {
  runId: string;
  target: string;
  sha256: string;
  reason: string;
  agentGroupId: string;
  sessionId: string;
  approvedBy: string | null;
  decidedAt: string;
  route: unknown;
}

type StepOutcome =
  | { status: 'ok'; handle: string | null; rows: unknown[][] | null }
  | { status: 'failed'; detail: string }
  | { status: 'unknown'; detail: string };

export type RunResult =
  | { kind: 'refused'; detail: string }
  | { kind: 'interrupted'; detail: string }
  | { kind: 'done'; steps: Array<{ text: string; role: string; outcome: StepOutcome }>; total: number };

/**
 * What a run's log line calls its result. A run that ends because a step failed is still `done` to the runner, which
 * a reader takes for success, so the label names the step it stopped at.
 */
export function runResultLabel(result: {
  kind: string;
  steps?: ReadonlyArray<{ outcome: { status: string } }>;
  total?: number;
}): string {
  if (result.kind !== 'done' || !result.steps) return result.kind;
  const stopped = result.steps.findIndex((s) => s.outcome.status !== 'ok');
  if (stopped >= 0)
    return `stopped at step ${stopped + 1} of ${result.total} (${result.steps[stopped].outcome.status})`;
  return result.steps.length === result.total
    ? 'completed'
    : `stopped after step ${result.steps.length} of ${result.total}`;
}

export class RunClaimedError extends Error {}

export interface ExecuteDeps {
  api: SqlApi;
  /** Identifiers of every OneCLI agent the gateway would inject `secret` for. */
  holders: (secret: string) => Promise<string[]>;
  sleep: (ms: number) => Promise<void>;
  /** Queues the run's report; called before the run is recorded as finished, so a finished run is never unreported. */
  settled: (result: RunResult) => void;
}

/**
 * Snowflake wants a UUID; derived from the step so a resend after a lost response reuses it, and from this run's
 * own seed so no other run, even one reusing the run id after its record was deleted, can collide with it.
 */
function requestIdFor(seed: string, step: number): string {
  const h = createHash('sha256').update(`${seed}\0${step}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

function message(body: Record<string, unknown>): string {
  const text = typeof body.message === 'string' ? body.message : 'no message';
  const code = typeof body.code === 'string' ? ` (${body.code})` : '';
  return `${text.slice(0, 300)}${code}`;
}

function transient(status: number): boolean {
  return status === 429 || status >= 500;
}

async function send(
  deps: ExecuteDeps,
  method: 'GET' | 'POST',
  urlPath: string,
  query: Record<string, string>,
  body?: Record<string, unknown>,
): Promise<(SqlApiResponse & { resent: boolean }) | { lost: string }> {
  let last = 'no response';
  for (let attempt = 0; attempt <= RESENDS; attempt++) {
    if (attempt > 0) await deps.sleep(POLL_MS * attempt);
    try {
      const res = await deps.api(
        method,
        urlPath,
        attempt > 0 && method === 'POST' ? { ...query, retry: 'true' } : query,
        body,
      );
      if (!transient(res.status)) return { ...res, resent: attempt > 0 };
      last = `HTTP ${res.status}: ${message(res.body)}`;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a lost response is resent under the same request id
    } catch (err) {
      last = err instanceof Error ? err.message.slice(0, 200) : 'request failed';
    }
  }
  return { lost: last };
}

async function runStatement(deps: ExecuteDeps, body: Record<string, unknown>, requestId: string): Promise<StepOutcome> {
  let res = await send(deps, 'POST', STATEMENTS, { requestId }, body);
  // Once Snowflake may have taken the statement, only its own verdict (200 or 422) settles the outcome.
  let mayHaveRun = !('lost' in res) && (res.resent || res.status === 202);
  const deadline = Date.now() + POLL_DEADLINE_MS;
  while (!('lost' in res) && res.status === 202) {
    const handle = res.body.statementHandle;
    if (typeof handle !== 'string' || !HANDLE_RE.test(handle)) {
      return { status: 'unknown', detail: 'Snowflake accepted the statement but gave no handle to follow' };
    }
    if (Date.now() > deadline)
      return { status: 'unknown', detail: `still running after ${POLL_DEADLINE_MS / 1000}s (handle ${handle})` };
    await deps.sleep(POLL_MS);
    res = await send(deps, 'GET', `${STATEMENTS}/${handle}`, { requestId });
    mayHaveRun = true;
  }
  if ('lost' in res) return { status: 'unknown', detail: `no answer from Snowflake: ${res.lost}` };
  if (res.status === 200) {
    const handle = typeof res.body.statementHandle === 'string' ? res.body.statementHandle : null;
    const rows = Array.isArray(res.body.data) ? (res.body.data as unknown[][]).slice(0, ROWS_KEPT) : null;
    return { status: 'ok', handle, rows };
  }
  // A timeout cancels the statement, but DDL may have committed before the cancel landed.
  if (res.status === 408) return { status: 'unknown', detail: `timed out: ${message(res.body)}` };
  if (res.status === 422 || !mayHaveRun)
    return { status: 'failed', detail: `HTTP ${res.status}: ${message(res.body)}` };
  return { status: 'unknown', detail: `HTTP ${res.status} after Snowflake may have taken it: ${message(res.body)}` };
}

function statementBody(
  text: string,
  context: { role: string; database?: string | null; schema?: string | null; warehouse?: string | null },
  tag: string,
): Record<string, unknown> {
  return {
    statement: text,
    timeout: STATEMENT_TIMEOUT_S,
    role: context.role,
    ...(context.database ? { database: context.database } : {}),
    ...(context.schema ? { schema: context.schema } : {}),
    ...(context.warehouse ? { warehouse: context.warehouse } : {}),
    parameters: { MULTI_STATEMENT_COUNT: '1', QUERY_TAG: tag },
  };
}

/** The session the token opens must be the configured user, under the role asked for, with no secondary roles. */
async function checkIdentity(
  deps: ExecuteDeps,
  execute: ExecuteConfig,
  role: string,
  runId: string,
  seed: string,
): Promise<string | null> {
  const outcome = await runStatement(
    deps,
    statementBody(
      'SELECT CURRENT_USER(), CURRENT_ROLE(), CURRENT_SECONDARY_ROLES()',
      { role, warehouse: execute.warehouse },
      `approved-run ${runId} identity`,
    ),
    requestIdFor(seed, 0),
  );
  if (outcome.status !== 'ok') return `the identity check failed: ${outcome.detail}`;
  const [user, current, secondary] = (outcome.rows?.[0] ?? []) as unknown[];
  if (user !== execute.user) return `the token opens a session as ${String(user)}, not ${execute.user}`;
  if (current !== role) return `the session runs as ${String(current)}, not ${role}`;
  let roles: unknown;
  try {
    roles = (JSON.parse(String(secondary)) as { roles?: unknown }).roles;
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable answer fails the check below
  } catch {
    roles = undefined;
  }
  if (roles !== '') return 'the session has secondary roles active';
  return null;
}

export function append(dir: string, entry: Record<string, unknown>): void {
  fs.appendFileSync(path.join(dir, 'log.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', {
    mode: 0o600,
  });
}

export function finish<R>(dir: string, result: R): R {
  fs.writeFileSync(path.join(dir, 'finished.json'), JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
  return result;
}

/**
 * Makes the run directory, the exactly-once claim, before any request is sent; a second claim on the same run id
 * throws. Its meta is written at once, so a host that dies mid-run leaves a record the next boot can report.
 */
export function claimRun(root: string, meta: RunMeta, extra: Record<string, unknown>): string {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const dir = path.join(root, meta.runId);
  try {
    fs.mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new RunClaimedError(meta.runId);
    throw err;
  }
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify({ ...meta, ...extra }, null, 2) + '\n', {
    mode: 0o600,
  });
  return dir;
}

/** Null when the vault injects `secret` for `agent` and no one else; otherwise why the run must not start. */
export async function tokenHeldOnlyBy(
  holdersOf: (secret: string) => Promise<string[]>,
  secret: string,
  agent: string,
): Promise<string | null> {
  return (await tokenHolding(holdersOf, secret, agent))?.problem ?? null;
}

/** Why `agent` is not the token's sole holder, or null; `unreadable` means the vault could not answer at all. */
export async function tokenHolding(
  holdersOf: (secret: string) => Promise<string[]>,
  secret: string,
  agent: string,
): Promise<{ unreadable: boolean; problem: string } | null> {
  let holders: string[];
  try {
    holders = await holdersOf(secret);
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable vault refuses the run
  } catch (err) {
    return {
      unreadable: true,
      problem: `the vault could not be checked: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}`,
    };
  }
  const others = holders.filter((h) => h !== agent);
  if (others.length > 0)
    return {
      unreadable: false,
      problem: `the ${secret} token is also granted to ${others.join(', ')}; only ${agent} may hold it`,
    };
  if (!holders.includes(agent)) return { unreadable: false, problem: `the ${secret} token is not granted to ${agent}` };
  return null;
}

export function executeRun(
  execute: ExecuteConfig,
  classification: Classification,
  meta: RunMeta,
  deps: ExecuteDeps,
  root = RUNS_DIR,
): Promise<RunResult> {
  const steps = classification.statements.filter((s) => s.tier === 'card');
  const nonce = randomUUID();
  const seed = `${meta.runId}\0${meta.sha256}\0${nonce}`;
  const dir = claimRun(root, meta, { nonce, steps: steps.length });
  return runClaimed(execute, steps, meta, deps, dir, seed);
}

async function runClaimed(
  execute: ExecuteConfig,
  steps: Classification['statements'],
  meta: RunMeta,
  deps: ExecuteDeps,
  dir: string,
  seed: string,
): Promise<RunResult> {
  const settle = (result: RunResult): RunResult => {
    deps.settled(result);
    return finish(dir, result);
  };

  if (steps.length === 0) return settle({ kind: 'refused', detail: 'the classified file has no runnable steps' });
  for (const s of steps) {
    const names = [s.role, s.database, s.schema, s.warehouse].filter((n): n is string => Boolean(n));
    if (!s.role || !names.every((n) => UPPER_NAME.test(n))) {
      return settle({
        kind: 'refused',
        detail: 'a statement runs under a session name that is not a plain upper-case identifier',
      });
    }
  }
  const held = await tokenHeldOnlyBy(deps.holders, execute.secret, execute.onecliAgent);
  if (held) return settle({ kind: 'refused', detail: held });
  const identity = await checkIdentity(deps, execute, steps[0].role as string, meta.runId, seed);
  if (identity) return settle({ kind: 'refused', detail: identity });

  const done: Array<{ text: string; role: string; outcome: StepOutcome }> = [];
  for (const [i, s] of steps.entries()) {
    const n = i + 1;
    const requestId = requestIdFor(seed, n);
    append(dir, { step: n, status: 'sending', requestId });
    const outcome = await runStatement(
      deps,
      statementBody(
        s.text,
        { role: s.role as string, database: s.database, schema: s.schema, warehouse: s.warehouse },
        `approved-run ${meta.runId} step ${n}`,
      ),
      requestId,
    );
    append(dir, { step: n, ...(outcome.status === 'ok' ? { status: 'ok', handle: outcome.handle } : outcome) });
    done.push({ text: s.text, role: s.role as string, outcome });
    if (outcome.status !== 'ok') break;
  }
  return settle({ kind: 'done', steps: done, total: steps.length });
}

export interface InterruptedRun {
  meta: RunMeta & { steps: number };
  ran: number;
  open: number | null;
  /** The step log exists but could not be read, so nothing is known about what ran. */
  logUnreadable?: true;
}

function interruptedRun(dir: string, name: string): InterruptedRun | null {
  if (fs.existsSync(path.join(dir, 'finished.json'))) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8'));
    // eslint-disable-next-line no-catch-all/no-catch-all -- a claim that died before its meta was written ran nothing
  } catch {
    return null;
  }
  const m = raw as Partial<RunMeta & { steps: number }> | null;
  // Only a record whose own run id it names can be reported.
  if (
    !m ||
    typeof m !== 'object' ||
    m.runId !== name ||
    typeof m.sessionId !== 'string' ||
    typeof m.steps !== 'number'
  ) {
    return null;
  }
  const logFile = path.join(dir, 'log.jsonl');
  let lines: string[];
  try {
    lines = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean) : [];
    // eslint-disable-next-line no-catch-all/no-catch-all -- any read failure means nothing is known of what ran, which is itself the report
  } catch (err) {
    log.error('Approved-run step log unreadable; reporting its outcome as unknown', { run: name, err });
    return { meta: m as RunMeta & { steps: number }, ran: 0, open: null, logUnreadable: true };
  }
  let ran = 0;
  let open: number | null = null;
  for (const line of lines) {
    let entry: unknown;
    try {
      entry = JSON.parse(line);
      // eslint-disable-next-line no-catch-all/no-catch-all -- a host killed mid-append leaves a torn last line; what came before it stands
    } catch {
      break;
    }
    const e = entry as { step?: unknown; status?: unknown } | null;
    // Anything that is not a step entry ends what the log can prove, like a torn line.
    if (!e || typeof e !== 'object' || typeof e.step !== 'number' || typeof e.status !== 'string') break;
    if (e.status === 'ok') {
      ran = e.step;
      open = null;
    } else if (e.status === 'failed') open = null;
    else open = e.step;
  }
  return { meta: m as RunMeta & { steps: number }, ran, open };
}

/** Runs a dead host left mid-flight: what its log proves ran, and the step whose outcome nobody saw. */
export function interruptedRuns(root = RUNS_DIR): InterruptedRun[] {
  if (!fs.existsSync(root)) return [];
  const found: InterruptedRun[] = [];
  for (const name of fs.readdirSync(root)) {
    // Each run directory is read on its own: one unreadable record must not hide the others.
    try {
      const run = interruptedRun(path.join(root, name), name);
      if (run) found.push(run);
      // eslint-disable-next-line no-catch-all/no-catch-all -- a record that cannot be read is skipped and logged
    } catch (err) {
      log.error('Could not read an approved-run record at startup', { run: name, err });
    }
  }
  return found;
}

export function markInterrupted(runId: string, detail: string, root = RUNS_DIR): void {
  finish(path.join(root, runId), { kind: 'interrupted', detail });
}
