/**
 * An approved list of migrations, applied in order with the repository's own apply script from the same commit as
 * the files, so its hash, identity and ledger checks stay in one place. Each file is its own apply-script run and its
 * own transaction; the list stops at the first file that does not apply. The script runs in a sandbox, never on the
 * host. The host reads each database's connection details itself, as the reserved identity, and hands the sandbox
 * only those, as a read-only file for that run: no gateway identity or Render key enters it. A list holds every
 * database it touches until it finishes.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { log } from '../../log.js';
import { append, claimRun, finish, tokenHeldOnlyBy, type RunMeta } from './execute.js';
import { dbEndpoint, openRelay, type DbEndpoint, type OpenRelay, type Relay } from './migrate-relay.js';
import { recordExecutor } from './migrate-drift.js';
import { migrationPath, type MigrationEntry, type MigrationProposal } from './migrate-request.js';
import type { RepoReader } from './migrate-repo.js';
import { OUTPUT_MAX_BYTES, SANDBOX_IMAGE, docker, sandboxArgs, type Docker } from './migrate-sandbox.js';
import { renderApiFor } from './render-api.js';
import { APPROVED_RUN_DIR, type MigrateTarget } from './targets.js';

const RUNS_DIR = path.join(APPROVED_RUN_DIR, 'runs');
/** The apply script's own `--budget`. */
const APPLY_BUDGET_S = 1080;
const KILL_AFTER_MS = (APPLY_BUDGET_S + 60) * 1000;
const RELAY_LIFETIME_MS = KILL_AFTER_MS + 5 * 60_000;
const OUTPUT_MAX = 6000;
/** Printed by the apply script right before it sends the migration; without it, nothing was sent. */
const SENDING_LINE = / identity ok, \S+ pending, sha256 /;
const CONNECTION_FILE = '/run/approved-run/connection-info.json';

interface ConnectionInfo {
  externalConnectionString: string;
}

export type FileOutcome =
  | { status: 'ok'; output: string }
  /** Stopped before the apply script began sending the migration. */
  | { status: 'failed'; output: string }
  | { status: 'unknown'; detail: string; output: string };

export type MigrateRunResult =
  | { kind: 'refused'; detail: string }
  | { kind: 'done'; steps: Array<{ file: MigrationEntry; outcome: FileOutcome }>; total: number };

export interface MigrateExecuteDeps {
  repo: RepoReader;
  holders: (secret: string) => Promise<string[]>;
  /** Render's connection details for one Postgres instance, read on the host as the reserved identity. */
  connectionInfo?: (onecliAgent: string, postgresId: string) => Promise<ConnectionInfo>;
  docker?: Docker;
  relay?: OpenRelay;
  /** Queues the run's report; called before the run is recorded as finished, so a finished run is never unreported. */
  settled: (result: MigrateRunResult) => void;
}

/**
 * `<postgresId>.json` here wins over Render: the OneCLI gateway can block connection-info for an instance whose admin
 * string no agent may read, and its org rules cannot exempt one identity, so this lane reads the host's copy instead.
 */
const HOST_CONNECTIONS_DIR = path.join(APPROVED_RUN_DIR, 'connections');
const POSTGRES_ID = /^dpg-[a-z0-9-]+$/;

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
}

/** The connection file's path only when it sits physically inside the tree mount-security keeps from containers. */
function heldConnectionFile(postgresId: string): string | null {
  if (!POSTGRES_ID.test(postgresId)) throw new Error(`${postgresId} is not a Render Postgres id`);
  const dir = lstatOrNull(HOST_CONNECTIONS_DIR);
  if (!dir) return null;
  if (!dir.isDirectory()) throw new Error('the host-held connections directory is not a real directory');
  const file = path.join(HOST_CONNECTIONS_DIR, `${postgresId}.json`);
  const stat = lstatOrNull(file);
  if (!stat) return null;
  if (!stat.isFile()) throw new Error(`the host-held connection file for ${postgresId} is not a regular file`);
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(`the host-held connection file for ${postgresId} is readable beyond its owner; chmod 600 it`);
  }
  return file;
}

function hostHeldConnectionInfo(postgresId: string): ConnectionInfo | null {
  const file = heldConnectionFile(postgresId);
  if (!file) return null;
  let body: Partial<ConnectionInfo> | null;
  try {
    body = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ConnectionInfo> | null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- JSON.parse quotes the file's text in its message, and that text is a secret
  } catch {
    body = null;
  }
  if (typeof body?.externalConnectionString !== 'string') {
    throw new Error(`the host-held connection file for ${postgresId} holds no externalConnectionString`);
  }
  return { externalConnectionString: body.externalConnectionString };
}

async function fetchConnectionInfo(onecliAgent: string, postgresId: string): Promise<ConnectionInfo> {
  const held = hostHeldConnectionInfo(postgresId);
  if (held) return held;
  const api = await renderApiFor(onecliAgent);
  const r = await api('GET', `/v1/postgres/${postgresId}/connection-info`);
  const body = r.body as Partial<ConnectionInfo> | null;
  if (r.status !== 200 || typeof body?.externalConnectionString !== 'string') {
    throw new Error(`Render answered ${r.status} for ${postgresId}'s connection details`);
  }
  return { externalConnectionString: body.externalConnectionString };
}

function passwordOf(info: ConnectionInfo): string {
  try {
    return decodeURIComponent(new URL(info.externalConnectionString).password);
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unparsable string still has its URL password scrubbed by pattern
  } catch {
    return '';
  }
}

/**
 * Removes the known secrets and every value the apply script asked GitHub to mask, wherever they appear in either
 * stream, the `::add-mask::` lines themselves, and any password in a postgres URL, a `PGPASSWORD=` setting or a JSON
 * `password` field. Nothing is stored or posted before this runs.
 */
export function redact(streams: string[], known: string[] = []): string[] {
  const secrets = new Set(known.filter(Boolean));
  for (const s of streams) {
    for (const m of s.matchAll(/^::add-mask::(.*)$/gm)) {
      const v = m[1].trim();
      if (v) secrets.add(v);
    }
  }
  for (const v of [...secrets]) secrets.add(encodeURIComponent(v));
  const ordered = [...secrets].sort((a, b) => b.length - a.length);
  return streams.map((s) => {
    let out = s
      .split('\n')
      .filter((line) => !line.startsWith('::add-mask::'))
      .join('\n');
    for (const v of ordered) out = out.split(v).join('***');
    return out
      .replace(/(postgres(?:ql)?:\/\/[^:@\s/]*:)[^@\s]*@/g, '$1***@')
      .replace(/(PGPASSWORD=)\S+/g, '$1***')
      .replace(/("password"\s*:\s*")(?:[^"\\]|\\.)*"/gi, '$1***"')
      .replace(/^::error::/gm, '');
  });
}

function tail(text: string): string {
  const t = text.trim();
  return t.length > OUTPUT_MAX ? `…${t.slice(-OUTPUT_MAX)}` : t;
}

const lanes = new Map<string, Promise<unknown>>();

/** Runs `fn` once every earlier run on any of these databases has finished, and holds them all until it does. */
function holding<T>(databases: string[], fn: () => Promise<T>): Promise<T> {
  const before = Promise.all(databases.map((d) => lanes.get(d) ?? Promise.resolve()));
  const next = before.then(fn, fn);
  const done = next.catch(() => undefined);
  for (const d of databases) lanes.set(d, done);
  return next;
}

export function executeMigrateRun(
  target: MigrateTarget,
  proposal: MigrationProposal,
  /** Blob ids of the executor files the card showed, recorded once the apply script is about to run. */
  executor: Record<string, string | null>,
  meta: RunMeta,
  deps: MigrateExecuteDeps,
  root = RUNS_DIR,
): Promise<MigrateRunResult> {
  const dir = claimRun(root, meta, { kind: 'repo-migrate', steps: proposal.files.length, files: proposal.files });
  const databases = [...new Set(proposal.files.map((f) => f.database))];
  return holding(databases, () => runClaimed(target, proposal, executor, meta, deps, dir));
}

/**
 * A host that died mid-run never reached that run's cleanup, so its connection file (the database password) and
 * extracted tree are still on disk. Run at boot, after leftover sandboxes are stopped.
 */
export function removeRunLeftovers(root = RUNS_DIR): void {
  if (!fs.existsSync(root)) return;
  // Host start awaits this, and a throw aborts the boot: nothing here may stop the host from booting.
  let runs: string[];
  try {
    runs = fs.readdirSync(root);
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable runs directory is logged, never fatal at boot
  } catch (err) {
    log.error('Could not list approved-run leftovers at startup', { err });
    return;
  }
  for (const run of runs) {
    try {
      for (const leftover of ['connection', 'tree']) {
        fs.rmSync(path.join(root, run, leftover), { recursive: true, force: true });
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- an entry that cannot be cleaned is skipped and logged
    } catch (err) {
      log.error('Could not remove an approved-run leftover at startup', { run, err });
    }
  }
}

async function applyOne(
  target: MigrateTarget,
  file: MigrationEntry,
  tree: string,
  connection: { file: string; password: string; endpoint: DbEndpoint },
  name: string,
  deps: MigrateExecuteDeps,
): Promise<FileOutcome> {
  let relay: Relay;
  try {
    relay = await (deps.relay ?? openRelay)(name, connection.endpoint, RELAY_LIFETIME_MS);
    // eslint-disable-next-line no-catch-all/no-catch-all -- without its relay the sandbox cannot reach the database, so nothing was sent
  } catch (err) {
    return {
      status: 'failed',
      output: `the database relay did not start: ${err instanceof Error ? err.message : 'unknown error'}`,
    };
  }
  try {
    return await sandboxed(target, file, tree, connection.file, connection.password, name, relay, deps);
  } finally {
    await relay.close();
  }
}

async function sandboxed(
  target: MigrateTarget,
  file: MigrationEntry,
  tree: string,
  connectionFile: string,
  password: string,
  name: string,
  relay: Relay,
  deps: MigrateExecuteDeps,
): Promise<FileOutcome> {
  const args = [
    ...sandboxArgs(name, tree, relay.network),
    '--add-host',
    relay.addHost,
    '-v',
    `${connectionFile}:${CONNECTION_FILE}:ro`,
    '-e',
    `RENDER_CONNECTION_INFO_FILE=${CONNECTION_FILE}`,
    SANDBOX_IMAGE,
    target.layout.applyScript,
    'apply',
    '--target',
    file.database,
    '--migration',
    file.migration,
    '--file',
    migrationPath(target, file),
    '--sha256',
    file.sha256,
    '--budget',
    String(APPLY_BUDGET_S),
  ];
  const r = await (deps.docker ?? docker)(args, name, KILL_AFTER_MS);
  const [stdout, stderr] = redact([r.stdout, r.stderr], [password]);
  const output = tail([stdout, stderr].filter((s) => s.trim()).join('\n'));
  if (r.code === 0 && !r.overflowed) return { status: 'ok', output };
  if (r.overflowed) {
    // A secret cut at the cap no longer matches the redaction, so none of it is kept.
    return {
      status: 'unknown',
      detail: `the apply script printed more than ${OUTPUT_MAX_BYTES} bytes and was stopped; its output was discarded`,
      output: '',
    };
  }
  // After the send, an exit cannot tell a rollback from a connection lost after COMMIT.
  if (SENDING_LINE.test(stdout)) {
    const detail = r.timedOut
      ? `the apply script ran past ${APPLY_BUDGET_S + 60}s and was stopped after it began sending the migration`
      : `the apply script exited ${r.code ?? 'abnormally'} after it began sending the migration`;
    return { status: 'unknown', detail, output };
  }
  return { status: 'failed', output };
}

/** The extracted file must be a regular file holding exactly the bytes the card's sha256 names. */
function extractedMatches(tree: string, file: string, sha256: string): boolean {
  const full = path.join(tree, file);
  try {
    if (!fs.lstatSync(full).isFile()) return false;
    return createHash('sha256').update(fs.readFileSync(full)).digest('hex') === sha256;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a file that cannot be read does not match
  } catch {
    return false;
  }
}

async function runClaimed(
  target: MigrateTarget,
  p: MigrationProposal,
  executor: Record<string, string | null>,
  meta: RunMeta,
  deps: MigrateExecuteDeps,
  dir: string,
): Promise<MigrateRunResult> {
  const settle = (result: MigrateRunResult): MigrateRunResult => {
    deps.settled(result);
    return finish(dir, result);
  };
  const refuse = (detail: string) => settle({ kind: 'refused', detail });
  const tree = path.join(dir, 'tree');
  const secrets = path.join(dir, 'connection');
  const connections = new Map<string, { file: string; password: string; endpoint: DbEndpoint }>();
  try {
    try {
      const databases = [...new Set(p.files.map((f) => f.database))];
      for (const db of databases) {
        const identity = target.execute.agents[db];
        if (!identity) return refuse(`${target.label} has no identity for ${db}`);
        const held = await tokenHeldOnlyBy(deps.holders, identity.secret, identity.onecliAgent);
        if (held) return refuse(held);
      }
      await deps.repo.refresh();
      if (!(await deps.repo.branchOf(p.commit))) {
        return refuse(`commit ${p.commit.slice(0, 12)} is no longer on develop or main`);
      }
      for (const f of p.files) {
        const bytes = await deps.repo.blob(p.commit, migrationPath(target, f));
        const actual = bytes ? createHash('sha256').update(bytes).digest('hex') : null;
        if (actual !== f.sha256) return refuse(`${migrationPath(target, f)} no longer hashes to ${f.sha256}`);
      }
      await deps.repo.extract(
        p.commit,
        [...target.layout.extract, ...p.files.map((f) => migrationPath(target, f))],
        tree,
      );
      for (const f of p.files) {
        if (!extractedMatches(tree, migrationPath(target, f), f.sha256)) {
          return refuse(`${migrationPath(target, f)} as extracted is not a regular file holding sha256 ${f.sha256}`);
        }
      }
      fs.mkdirSync(secrets, { recursive: true, mode: 0o700 });
      for (const db of databases) {
        const info = await (deps.connectionInfo ?? fetchConnectionInfo)(
          target.execute.agents[db].onecliAgent,
          target.postgresIds[db],
        );
        const file = path.join(secrets, `${db}.json`);
        fs.writeFileSync(file, JSON.stringify(info), { mode: 0o600 });
        connections.set(db, { file, password: passwordOf(info), endpoint: dbEndpoint(info.externalConnectionString) });
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- anything that fails before the first file refuses the whole list
    } catch (err) {
      return refuse(err instanceof Error ? err.message.slice(0, 300) : 'preparing the run failed');
    }

    recordExecutor(target.id, { commit: p.commit, blobs: executor, at: new Date().toISOString() });
    const base = `nanoclaw-approved-run-${meta.runId.replace(/[^A-Za-z0-9_.-]/g, '-')}`.slice(0, 110);
    const steps: Array<{ file: MigrationEntry; outcome: FileOutcome }> = [];
    for (const [i, file] of p.files.entries()) {
      const step = i + 1;
      const connection = connections.get(file.database)!;
      append(dir, { step, status: 'sending' });
      const outcome = await applyOne(target, file, tree, connection, `${base}-${step}`, deps);
      append(dir, { step, status: outcome.status });
      steps.push({ file, outcome });
      if (outcome.status !== 'ok') break;
    }
    return settle({ kind: 'done', steps, total: p.files.length });
  } finally {
    fs.rmSync(secrets, { recursive: true, force: true });
    fs.rmSync(tree, { recursive: true, force: true });
  }
}
