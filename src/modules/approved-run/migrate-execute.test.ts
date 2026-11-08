import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunClaimedError, type RunMeta } from './execute.js';
import {
  executeMigrateRun,
  redact,
  removeRunLeftovers,
  type MigrateExecuteDeps,
  type MigrateRunResult,
} from './migrate-execute.js';
import type { MigrationProposal } from './migrate-request.js';
import type { RepoReader } from './migrate-repo.js';
import type { Spawned } from './migrate-sandbox.js';
import { MIGRATE_TARGET } from '../../test-fixtures/migrate-target.js';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-migrate-execute') }));
vi.mock('../../config.js', async () => ({ ...(await vi.importActual('../../config.js')), DATA_DIR: TEST_DIR }));
const { renderReads, pgUrl } = vi.hoisted(() => ({
  renderReads: [] as Array<[string, string]>,
  pgUrl: (user: string, password: string, host: string) => `postgresql://${user}:${password}${'@'}${host}:5432/db`,
}));
vi.mock('./render-api.js', () => ({
  renderApiFor: async (agent: string) => async (_method: string, url: string) => {
    renderReads.push([agent, url]);
    return {
      status: 200,
      body: { externalConnectionString: pgUrl('app_user', 'remote', 'render.acme.test') },
    };
  },
}));

const COMMIT = 'a'.repeat(40);
const BODY: Record<string, string> = {
  'backend/migrations/301_add_widgets.sql': 'CREATE TABLE widgets (id int);',
  'backend/migrations/302_add_gadgets.sql': 'CREATE TABLE gadgets (id int);',
  'registry/migrations/090_add_sprockets.sql': 'CREATE TABLE sprockets (id int);',
};
const sha = (s: string) => createHash('sha256').update(s).digest('hex');

const TARGET = MIGRATE_TARGET;

function entry(database: 'app' | 'hub', file: string) {
  const migration = path.basename(file, '.sql');
  return { database, migration, sha256: sha(BODY[file]) };
}
const APP_301 = entry('app', 'backend/migrations/301_add_widgets.sql');
const APP_302 = entry('app', 'backend/migrations/302_add_gadgets.sql');
const HUB_090 = entry('hub', 'registry/migrations/090_add_sprockets.sql');

let root: string;
let runs: Array<{ args: string[]; name: string }>;
let branch: 'develop' | 'main' | null;
let holders: string[] | null;
let settled: MigrateRunResult[];
let connectionReads: Array<[string, string]>;
let killAfter: number[];
let relays: Array<{ name: string; endpoint: { host: string; port: number }; lifetimeMs: number; closed: boolean }>;
/** What extraction writes instead of a file's committed bytes: other bytes, or a symlink to the given path. */
let extracted: Record<string, { bytes?: string; linkTo?: string; missing?: boolean }>;

const PASSWORD = 'Hunter2/pass+word';
const CONNECTION = `postgresql://app_user:${encodeURIComponent(PASSWORD)}@db.acme.test:5432/app`;

const repo: RepoReader = {
  refresh: async () => undefined,
  branchOf: async () => branch,
  blob: async (_c, f) => (f in BODY ? Buffer.from(BODY[f]) : null),
  blobId: async () => null,
  names: async () => [],
  extract: async (_c, paths, into) => {
    for (const p of paths.filter((x) => x in BODY)) {
      const full = path.join(into, p);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      const override = extracted[p];
      if (override?.missing) continue;
      if (override?.linkTo) fs.symlinkSync(override.linkTo, full);
      else fs.writeFileSync(full, override?.bytes ?? BODY[p]);
    }
  },
};

/** apply.mjs as the sandbox prints it: the identity line, then success or the given failure. */
function applied(outcome: Partial<Spawned> = {}): Spawned {
  return {
    code: 0,
    timedOut: false,
    overflowed: false,
    stdout: 'app: identity ok, 1 pending, sha256 ok\napplied\n',
    stderr: '',
    ...outcome,
  };
}

function deps(dockerFor: (args: string[]) => Promise<Spawned> | Spawned = () => applied()): MigrateExecuteDeps {
  return {
    repo,
    holders: async (secret) => holders ?? [secret.replace(/ token$/, '')],
    connectionInfo: async (agent, postgresId) => {
      connectionReads.push([agent, postgresId]);
      return { externalConnectionString: CONNECTION };
    },
    docker: async (args, name, killAfterMs) => {
      runs.push({ args, name });
      killAfter.push(killAfterMs);
      return dockerFor(args);
    },
    relay: async (name, endpoint, lifetimeMs) => {
      relays.push({ name, endpoint, lifetimeMs, closed: false });
      const opened = relays[relays.length - 1];
      return {
        network: `${name}-net`,
        addHost: `${endpoint.host}:10.9.0.2`,
        close: async () => {
          opened.closed = true;
        },
      };
    },
    settled: (r) => settled.push(r),
  };
}

let seq = 0;
function meta(): RunMeta {
  return {
    runId: `run-${++seq}`,
    target: TARGET.id,
    sha256: 'f'.repeat(64),
    reason: 'add tables',
    agentGroupId: 'ag-1',
    sessionId: 'sess-1',
    approvedBy: 'Alice',
    decidedAt: new Date().toISOString(),
    route: null,
  };
}

function proposal(...files: MigrationProposal['files']): MigrationProposal {
  return { commit: COMMIT, goLink: 'https://example.invalid/go', files };
}

const flag = (args: string[], name: string) => args[args.indexOf(name) + 1];

beforeEach(() => {
  root = path.join(TEST_DIR, 'runs');
  runs = [];
  branch = 'develop';
  holders = null;
  settled = [];
  connectionReads = [];
  relays = [];
  killAfter = [];
  extracted = {};
});

afterEach(() => fs.rmSync(TEST_DIR, { recursive: true, force: true }));

describe('redact', () => {
  it('removes a known or masked password wherever it appears, in either stream, and the mask lines themselves', () => {
    const [out, err] = redact(
      [
        `::add-mask::other-secret\nconnecting\npassword is ${PASSWORD}\nurl-encoded ${encodeURIComponent(PASSWORD)}\n`,
        'retrying with other-secret\n',
      ],
      [PASSWORD],
    );
    expect(out).toBe('connecting\npassword is ***\nurl-encoded ***\n');
    expect(err).toBe('retrying with ***\n');
  });

  it.each([
    [
      'a postgres URL',
      'dsn postgresql://app_user:s3cr3t@localhost:5432/app',
      'dsn postgresql://app_user:***@localhost:5432/app',
    ],
    ['a PGPASSWORD setting', 'env PGPASSWORD=s3cr3t psql', 'env PGPASSWORD=*** psql'],
    ['a JSON password field', '{"user":"a","password":"s3\\"cr3t"}', '{"user":"a","password":"***"}'],
  ])('removes the password in %s it was never told about', (_name, text, expected) => {
    expect(redact([text])).toEqual([expected]);
  });
});

describe('executeMigrateRun', () => {
  it('runs apply.mjs once per file, in order, with its database named explicitly', async () => {
    const result = await executeMigrateRun(TARGET, proposal(APP_301, HUB_090), {}, meta(), deps(), root);
    expect(result).toMatchObject({
      kind: 'done',
      total: 2,
      steps: [{ outcome: { status: 'ok' } }, { outcome: { status: 'ok' } }],
    });
    expect(runs.map((r) => [flag(r.args, '--target'), flag(r.args, '--migration'), flag(r.args, '--sha256')])).toEqual([
      ['app', APP_301.migration, APP_301.sha256],
      ['hub', HUB_090.migration, HUB_090.sha256],
    ]);
    expect(connectionReads).toEqual([
      ['approved-run-acme-app', 'dpg-aaaaaaaaaaaaaaaaaaaa'],
      ['approved-run-acme-hub', 'dpg-bbbbbbbbbbbbbbbbbbbb'],
    ]);
    expect(settled).toEqual([result]);
  });

  it('hands the sandbox only a read-only connection file for the run, never a proxy or key, and removes it after', async () => {
    let seen: { file: string; content: string } | null = null;
    await executeMigrateRun(
      TARGET,
      proposal(APP_301),
      {},
      meta(),
      deps((args) => {
        const mount = args.find((a) => a.endsWith(':/run/approved-run/connection-info.json:ro'))!;
        const file = mount.split(':')[0];
        seen = { file, content: fs.readFileSync(file, 'utf8') };
        return applied();
      }),
      root,
    );
    const args = runs[0].args.join(' ');
    expect(args).toContain('RENDER_CONNECTION_INFO_FILE=/run/approved-run/connection-info.json');
    expect(args).not.toMatch(/PROXY|RENDER_API_KEY|NODE_EXTRA_CA_CERTS/);
    expect(JSON.parse(seen!.content)).toEqual({ externalConnectionString: CONNECTION });
    expect(fs.existsSync(seen!.file)).toBe(false);
    expect(fs.existsSync(path.join(root, `run-${seq}`, 'tree'))).toBe(false);
  });

  it('puts the sandbox on its run network only, with the database hostname pointed at a relay pinned to it', async () => {
    let open: boolean[] = [];
    await executeMigrateRun(
      TARGET,
      proposal(APP_301),
      {},
      meta(),
      deps(() => {
        open = relays.map((r) => !r.closed);
        return applied();
      }),
      root,
    );
    expect(relays).toMatchObject([
      { name: runs[0].name, endpoint: { host: 'db.acme.test', port: 5432 }, closed: true },
    ]);
    expect(relays[0].lifetimeMs).toBeGreaterThan(killAfter[0] + 15_000);
    expect(open).toEqual([true]);
    const args = runs[0].args;
    expect(args[args.indexOf('--network') + 1]).toBe(`${runs[0].name}-net`);
    expect(args[args.indexOf('--add-host') + 1]).toBe('db.acme.test:10.9.0.2');
    expect(args.filter((a) => a === '--network')).toHaveLength(1);
  });

  it('sends nothing when the relay does not start, and says so', async () => {
    const d = deps();
    d.relay = async () => {
      throw new Error('network create failed: no address pools left');
    };
    const result = await executeMigrateRun(TARGET, proposal(APP_301), {}, meta(), d, root);

    expect(runs).toEqual([]);
    expect(result).toMatchObject({
      kind: 'done',
      steps: [{ outcome: { status: 'failed', output: expect.stringContaining('the database relay did not start') } }],
    });
  });

  it('refuses before reading anything further when the database address is not a hostname it can remap', async () => {
    const d = deps();
    d.connectionInfo = async () => ({ externalConnectionString: 'postgresql://app_user:pw@10.0.0.5:5432/app' });
    const result = await executeMigrateRun(TARGET, proposal(APP_301), {}, meta(), d, root);

    expect(runs).toEqual([]);
    expect(relays).toEqual([]);
    expect(result).toEqual({ kind: 'refused', detail: 'the database address is not a hostname' });
  });

  it('stops at the first file that does not apply and reports the ones before it as applied', async () => {
    const result = await executeMigrateRun(
      TARGET,
      proposal(APP_301, APP_302, HUB_090),
      {},
      meta(),
      deps((args) =>
        flag(args, '--migration') === APP_302.migration
          ? applied({ code: 1, stdout: '', stderr: 'refused: already applied' })
          : applied(),
      ),
      root,
    );
    expect(result).toMatchObject({
      kind: 'done',
      total: 3,
      steps: [{ outcome: { status: 'ok' } }, { outcome: { status: 'failed' } }],
    });
    expect(runs).toHaveLength(2);
  });

  it('reports a file as unknown when the apply script exits nonzero after it began sending it', async () => {
    const result = await executeMigrateRun(
      TARGET,
      proposal(APP_301),
      {},
      meta(),
      deps(() => applied({ code: 1, stderr: 'connection lost' })),
      root,
    );
    expect(result).toMatchObject({ kind: 'done', steps: [{ outcome: { status: 'unknown' } }] });
    expect(JSON.stringify(result)).toContain('exited 1 after it began sending');
  });

  it('reports a file as unknown when its output overflowed after the apply script started sending it', async () => {
    const result = await executeMigrateRun(
      TARGET,
      proposal(APP_301),
      {},
      meta(),
      deps(() => applied({ code: 137, overflowed: true })),
      root,
    );
    expect(result).toMatchObject({ kind: 'done', steps: [{ outcome: { status: 'unknown' } }] });
    expect(JSON.stringify(result)).toContain('printed more than');
    expect(result).toMatchObject({ steps: [{ outcome: { output: '' } }] });
  });

  it('reports a file as unknown when the sandbox dies after apply.mjs started sending it', async () => {
    const result = await executeMigrateRun(
      TARGET,
      proposal(APP_301),
      {},
      meta(),
      deps(() => applied({ code: null, timedOut: true })),
      root,
    );
    expect(result).toMatchObject({ kind: 'done', steps: [{ outcome: { status: 'unknown' } }] });
  });

  it('never stores or posts the database password, even one the apply script never masked', async () => {
    const pw = PASSWORD;
    const result = await executeMigrateRun(
      TARGET,
      proposal(APP_301),
      {},
      meta(),
      deps(() =>
        applied({
          stdout: `app: identity ok, 1 pending, sha256 ok\npassword ${pw}\n`,
          stderr: `${pw}\n`,
        }),
      ),
      root,
    );
    const stored = fs.readFileSync(path.join(root, `run-${seq}`, 'finished.json'), 'utf8');
    expect(JSON.stringify(result)).not.toContain('Hunter2');
    expect(stored).not.toContain('Hunter2');
    expect(JSON.stringify(settled)).not.toContain('Hunter2');
  });

  it.each([
    [
      'a file whose bytes changed since the card',
      () => proposal({ ...APP_301, sha256: 'b'.repeat(64) }),
      /no longer hashes/,
    ],
    [
      'a commit no longer on develop or main',
      () => ((branch = null), proposal(APP_301)),
      /no longer on develop or main/,
    ],
    [
      'a file whose extracted bytes differ from its blob',
      () => ((extracted[`backend/migrations/301_add_widgets.sql`] = { bytes: 'DROP TABLE users;' }), proposal(APP_301)),
      /not a regular file holding sha256/,
    ],
    [
      'a file extracted as a symlink',
      () => ((extracted[`backend/migrations/301_add_widgets.sql`] = { linkTo: '/etc/hostname' }), proposal(APP_301)),
      /not a regular file holding sha256/,
    ],
    [
      'a file missing from the extracted tree',
      () => ((extracted[`backend/migrations/301_add_widgets.sql`] = { missing: true }), proposal(APP_301)),
      /not a regular file holding sha256/,
    ],
    [
      'a token another agent can also use',
      () => ((holders = ['approved-run-acme-app', 'ag-agent']), proposal(APP_301)),
      /ag-agent/,
    ],
  ])('refuses %s before any sandbox starts', async (_name, make, reason) => {
    const result = await executeMigrateRun(TARGET, make(), {}, meta(), deps(), root);
    expect(result.kind).toBe('refused');
    expect((result as { detail: string }).detail).toMatch(reason);
    expect(runs).toEqual([]);
    expect(connectionReads).toEqual([]);
  });

  it('refuses a second run under the same run id before starting anything', async () => {
    const m = meta();
    await executeMigrateRun(TARGET, proposal(APP_301), {}, m, deps(), root);
    expect(() => executeMigrateRun(TARGET, proposal(APP_301), {}, m, deps(), root)).toThrow(RunClaimedError);
    expect(runs).toHaveLength(1);
  });

  it('holds a database until its earlier run finishes, and lets another database run alongside', async () => {
    const open: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const stalling = deps(async (args) => {
      open.push(flag(args, '--migration'));
      if (flag(args, '--migration') === APP_301.migration) await gate;
      return applied();
    });
    const first = executeMigrateRun(TARGET, proposal(APP_301), {}, meta(), stalling, root);
    const sameDb = executeMigrateRun(TARGET, proposal(APP_302), {}, meta(), stalling, root);
    const otherDb = executeMigrateRun(TARGET, proposal(HUB_090), {}, meta(), stalling, root);
    await otherDb;
    expect(open).toEqual([APP_301.migration, HUB_090.migration]);
    release();
    await Promise.all([first, sameDb]);
    expect(open).toEqual([APP_301.migration, HUB_090.migration, APP_302.migration]);
  });
});

describe('executeMigrateRun reading connection details on the host', () => {
  const HELD_DIR = () => path.join(TEST_DIR, 'approved-run', 'connections');
  const HUB_FILE = () => path.join(HELD_DIR(), 'dpg-bbbbbbbbbbbbbbbbbbbb.json');
  const HELD = pgUrl('hub_admin', 'held-secret-value', 'hub.held.test');

  function holdHub(content: string, mode = 0o600): void {
    fs.mkdirSync(HELD_DIR(), { recursive: true });
    fs.writeFileSync(HUB_FILE(), content, { mode });
    fs.chmodSync(HUB_FILE(), mode);
  }

  function hostDeps(): MigrateExecuteDeps {
    const d = deps();
    delete d.connectionInfo;
    return d;
  }

  beforeEach(() => {
    renderReads.length = 0;
  });

  it('uses the host-held file for a database that has one and asks Render only for the others', async () => {
    holdHub(JSON.stringify({ externalConnectionString: HELD }));
    const result = await executeMigrateRun(TARGET, proposal(APP_301, HUB_090), {}, meta(), hostDeps(), root);
    expect(result).toMatchObject({ kind: 'done', total: 2 });
    expect(renderReads).toEqual([['approved-run-acme-app', '/v1/postgres/dpg-aaaaaaaaaaaaaaaaaaaa/connection-info']]);
    expect(relays.map((r) => r.endpoint.host)).toEqual(['render.acme.test', 'hub.held.test']);
  });

  it.each([
    [
      'readable beyond its owner',
      () => holdHub(JSON.stringify({ externalConnectionString: HELD }), 0o644),
      'chmod 600',
    ],
    [
      'not a regular file',
      () => {
        fs.mkdirSync(HELD_DIR(), { recursive: true });
        const real = path.join(TEST_DIR, 'elsewhere.json');
        fs.writeFileSync(real, JSON.stringify({ externalConnectionString: HELD }), { mode: 0o600 });
        fs.symlinkSync(real, HUB_FILE());
      },
      'not a regular file',
    ],
    ['not JSON', () => holdHub('s3cr3t-pw'), 'holds no externalConnectionString'],
    [
      'in a directory linked from outside the approved-run tree',
      () => {
        const outside = path.join(TEST_DIR, 'held-db');
        fs.mkdirSync(outside, { recursive: true });
        fs.writeFileSync(
          path.join(outside, 'dpg-bbbbbbbbbbbbbbbbbbbb.json'),
          JSON.stringify({ externalConnectionString: HELD }),
          { mode: 0o600 },
        );
        fs.mkdirSync(path.dirname(HELD_DIR()), { recursive: true });
        fs.symlinkSync(outside, HELD_DIR());
      },
      'not a real directory',
    ],
  ])('refuses the run, sending nothing and quoting none of it, when the file is %s', async (_name, setup, reason) => {
    setup();
    const result = await executeMigrateRun(TARGET, proposal(HUB_090), {}, meta(), hostDeps(), root);
    expect(result).toMatchObject({ kind: 'refused' });
    const detail = (result as { detail: string }).detail;
    expect(detail).toContain(reason);
    expect(detail).not.toContain('held-secret-value');
    expect(detail).not.toContain('s3cr3t');
    expect(runs).toEqual([]);
    expect(renderReads).toEqual([]);
  });
});

describe('removeRunLeftovers', () => {
  it("removes a run's connection file and tree a dead host left behind, and keeps its records", () => {
    const run = path.join(root, 'run-dead');
    fs.mkdirSync(path.join(run, 'connection'), { recursive: true });
    fs.writeFileSync(
      path.join(run, 'connection', 'app.json'),
      JSON.stringify({ externalConnectionString: CONNECTION }),
    );
    fs.mkdirSync(path.join(run, 'tree', 'backend'), { recursive: true });
    fs.writeFileSync(path.join(run, 'started.json'), '{}');
    fs.writeFileSync(path.join(root, 'stray-file'), '');
    removeRunLeftovers(root);
    expect(fs.readdirSync(run)).toEqual(['started.json']);
    expect(fs.existsSync(path.join(root, 'stray-file'))).toBe(true);
  });

  it('returns without throwing when the runs folder cannot be listed', () => {
    fs.mkdirSync(path.dirname(root), { recursive: true });
    fs.writeFileSync(root, '');
    expect(() => removeRunLeftovers(root)).not.toThrow();
  });
});
