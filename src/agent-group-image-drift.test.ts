/**
 * Driven through `wakeContainer` over a real migrated DB. The two boundaries a unit test cannot cross are faked: the
 * `docker inspect` behind the deps-drift check (answered from whether the fake build has landed), and the
 * `docker build` the real `buildAgentGroupImage` runs through `exec`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, TEST_GROUPS_DIR } = vi.hoisted(() => {
  const root = uniqueTmpRoot('agent-group-image-drift');
  return { TEST_DATA_DIR: `${root}/data`, TEST_GROUPS_DIR: `${root}/groups` };
});

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_DATA_DIR,
  GROUPS_DIR: TEST_GROUPS_DIR,
}));

// NOT spread: log.ts installs process-wide handlers at module scope (src/log-mock-tripwire.test.ts).
vi.mock('./log.js', () => ({
  setLogScrubber: vi.fn(),
  isSurvivableIoError: vi.fn(() => false),
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

// An absent runtime binary: `spawn()` still returns a child, which fails with ENOENT and finalizes.
const ABSENT_CONTAINER_RUNTIME_BIN = vi.hoisted(() => 'nanoclaw-absent-container-runtime');
vi.mock('./container-runtime.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-runtime.js')>()),
  CONTAINER_RUNTIME_BIN: ABSENT_CONTAINER_RUNTIME_BIN,
  runtimeShowsRunning: () => false,
}));

const hooks = vi.hoisted(() => ({
  /** Session ids whose container reached `spawn()`. */
  spawned: new Set<string>(),
  /** Image tags the fake `docker build` was asked for, in order. */
  builds: [] as string[],
  /** Tags whose fake build has landed: the drift check answers "in sync" for them. */
  built: new Set<string>(),
  /** Holds every fake build open until released. */
  buildGate: null as Promise<void> | null,
  buildFails: false,
  baseDrifted: false,
  /** Parks the base-image drift check, the one await between a rebuild's guard and its build. */
  baseCheckGate: null as Promise<void> | null,
  baseChecksParked: 0,
  baseChecks: 0,
  inspectFails: false,
  baseInspectFails: false,
  /** Routes the drift check through the real predicate, over the fake labels and base ID below. */
  realCheck: false,
  baseMissing: false,
  currentBaseId: 'sha256:base-fixture-current',
  /** The base ID each tag's image records, as the fake build read it from the Dockerfile. */
  recordedBase: new Map<string, string>(),
  reset(): void {
    this.realCheck = false;
    this.baseMissing = false;
    this.currentBaseId = 'sha256:base-fixture-current';
    this.recordedBase.clear();
    this.baseInspectFails = false;
    this.inspectFails = false;
    this.baseChecks = 0;
    this.baseCheckGate = null;
    this.baseChecksParked = 0;
    this.spawned.clear();
    this.builds = [];
    this.built.clear();
    this.buildGate = null;
    this.buildFails = false;
    this.baseDrifted = false;
  },
}));

vi.mock('child_process', async (importOriginal) => {
  const real = await importOriginal<typeof import('child_process')>();
  const { readFileSync } = await import('fs');
  const exec = ((
    command: string,
    options: unknown,
    callback?: (err: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const done = (typeof options === 'function' ? options : callback) as (
      err: Error | null,
      stdout: string,
      stderr: string,
    ) => void;
    const build = new RegExp(`^${ABSENT_CONTAINER_RUNTIME_BIN} build -t (\\S+) `).exec(command);
    if (!build) return real.exec(command, options as never, callback as never);
    const tag = build[1];
    hooks.builds.push(tag);
    const dockerfile = / -f (\S+) /.exec(command)?.[1];
    const recorded = dockerfile && /^LABEL nanoclaw\.baseImageId=(".*")$/m.exec(readFileSync(dockerfile, 'utf8'));
    void (async () => {
      if (hooks.buildGate) await hooks.buildGate;
      if (hooks.buildFails) return done(new Error('apt-get install exited 100'), '', '');
      hooks.built.add(tag);
      if (recorded) hooks.recordedBase.set(tag, JSON.parse(recorded[1]) as string);
      done(null, '', '');
    })();
    return undefined as unknown as import('child_process').ChildProcess;
  }) as typeof real.exec;
  return {
    ...real,
    exec,
    spawn: ((...spawnArgs: Parameters<typeof real.spawn>) => {
      if (spawnArgs[0] === ABSENT_CONTAINER_RUNTIME_BIN) {
        const argv = Array.isArray(spawnArgs[1]) ? (spawnArgs[1] as readonly string[]) : [];
        for (const arg of argv) {
          const match = /v2-sessions\/[^/]+\/([^/:]+)/.exec(arg);
          if (match) hooks.spawned.add(match[1]);
        }
      }
      return real.spawn(...spawnArgs);
    }) as typeof real.spawn,
  };
});

vi.mock('./agent-runner-image-check.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./agent-runner-image-check.js')>();
  const { CONTAINER_IMAGE } = await import('./config.js');
  const inspect = async (imageRef: string): Promise<string> => {
    const labels: Record<string, string> = { 'nanoclaw.agentRunnerDepsHash': await real.computeAgentRunnerDepsHash() };
    const recorded = hooks.recordedBase.get(imageRef);
    if (recorded) labels[real.BASE_IMAGE_ID_LABEL] = recorded;
    return JSON.stringify(labels);
  };
  const inspectId = async (imageRef: string): Promise<string> => {
    if (hooks.baseMissing) throw new Error(`Error: No such image: ${imageRef}`);
    return `${hooks.currentBaseId}\n`;
  };
  return {
    ...real,
    readBaseImageId: () => real.readBaseImageId(inspectId),
    checkAgentRunnerDepsDrift: async (
      imageRef: string = CONTAINER_IMAGE,
      options: import('./agent-runner-image-check.js').DriftCheckOptions = {},
    ) => {
      if (hooks.realCheck) {
        return real.checkAgentRunnerDepsDrift(imageRef, { ...options, inspect, inspectId, retryDelayMs: 0 });
      }
      if (imageRef === CONTAINER_IMAGE) hooks.baseChecks += 1;
      if (imageRef === CONTAINER_IMAGE && hooks.baseCheckGate) {
        hooks.baseChecksParked += 1;
        await hooks.baseCheckGate;
      }
      if (imageRef === CONTAINER_IMAGE ? hooks.baseInspectFails : hooks.inspectFails) {
        return {
          ok: false,
          imageRef,
          expected: 'current',
          actual: null,
          lookup: { kind: 'inspect-error' as const, reason: 'context deadline exceeded' },
          retried: false,
          message: `agent-runner deps check: docker inspect ${imageRef} failed`,
        };
      }
      const inSync = imageRef === CONTAINER_IMAGE ? !hooks.baseDrifted : hooks.built.has(imageRef);
      const actual = inSync ? 'current' : 'stale';
      return {
        ok: inSync,
        imageRef,
        expected: 'current',
        actual,
        lookup: { kind: 'found' as const, value: actual },
        retried: false,
        message: inSync ? 'agent-runner deps in sync' : `agent-runner deps drift on ${imageRef}`,
      };
    },
  };
});

// The real watcher runs git fetch and build.sh; only whether the spawn path asked for it matters here.
vi.mock('./container-rebuild-watcher.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./container-rebuild-watcher.js')>()),
  requestContainerRebuild: vi.fn(),
}));

vi.mock('./notify-owner.js', () => ({
  notifyOwner: vi.fn(async () => ({ code: 0, message: 'delivered' })),
}));

vi.mock('./onecli-apply.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./onecli-apply.js')>()),
  applyOnecliContainerConfig: async () => ({ applied: true, attempts: 1, durationsMs: [0], diagnosis: null }),
}));
vi.mock('./onecli-secrets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./onecli-secrets.js')>()),
  ensureOnecliAgent: async () => undefined,
  applyOnecliSecrets: async () => undefined,
}));

vi.mock('./storage-maintenance-worker.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./storage-maintenance-worker.js')>()),
  assertStorageAdmissionInBackground: async () =>
    ({ allowed: true }) as Awaited<
      ReturnType<typeof import('./storage-maintenance-worker.js').assertStorageAdmissionInBackground>
    >,
}));

// The real controller sizes its budget from a `docker info` probe.
vi.mock('./memory-admission.js', () => {
  class AlwaysAdmits {
    readonly budgetMb: number;
    constructor(budgetMb: number) {
      this.budgetMb = budgetMb;
    }
    get reservedMb(): number {
      return 0;
    }
    get queuedCount(): number {
      return 0;
    }
    isQueued(): boolean {
      return false;
    }
    hasReservation(): boolean {
      return false;
    }
    request(_id: string, requestMb: number): { status: 'admitted'; budgetMb: number; requestMb: number } {
      return { status: 'admitted', budgetMb: this.budgetMb, requestMb };
    }
    release(): never[] {
      return [];
    }
    cancel(): never[] {
      return [];
    }
    shutdown(): void {}
  }
  return {
    MemoryAdmissionController:
      AlwaysAdmits as unknown as typeof import('./memory-admission.js').MemoryAdmissionController,
  };
});

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';

import { resetDepsDriftCacheForTests } from './agent-runner-image-check.js';
import { requestContainerRebuild, MIN_RETRY_INTERVAL_MS } from './container-rebuild-watcher.js';
import {
  _agentGroupImageRebuildForTesting,
  agentGroupImageTag,
  buildAgentGroupImage,
  isContainerRunning,
  prewarmAgentGroupImages,
  wakeContainer,
} from './container-runner.js';
import { closeDb, getDb, initDb } from './db/connection.js';
import { runMigrations } from './db/index.js';
import { stopHostInstanceLease } from './host-instance.js';
import { log } from './log.js';
import { getAgentMailbox } from './mailbox/index.js';
import { notifyOwner } from './notify-owner.js';
import { allowSubprocess } from './test-hermeticity.js';
import type { Session } from './types.js';

const STAMP = '2026-11-04T00:00:00.000Z';
// Under the 15 s test timeout, so a missing rebuild fails with its own message rather than a timeout.
const WAIT_BUDGET_MS = 10_000;

async function until(done: () => boolean, describeFailure: string): Promise<void> {
  // performance.now, not Date.now: the cooldown case fakes Date.
  const deadline = performance.now() + WAIT_BUDGET_MS;
  while (!done() && performance.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  expect(done(), describeFailure).toBe(true);
}

async function seedGroup(agentGroupId: string, imageTag = agentGroupImageTag(agentGroupId)): Promise<void> {
  const folder = `${agentGroupId}-folder`;
  fs.mkdirSync(path.join(TEST_GROUPS_DIR, folder), { recursive: true });
  fs.writeFileSync(path.join(TEST_GROUPS_DIR, folder, 'container.json'), JSON.stringify({ imageTag }));
  await getDb().run(
    'INSERT INTO agent_groups (id, name, folder, agent_provider, workgroup_id, created_at) VALUES (?, ?, ?, NULL, ?, ?)',
    agentGroupId,
    agentGroupId,
    folder,
    'wg-image-drift',
    STAMP,
  );
  await getDb().run(
    `INSERT INTO container_configs (agent_group_id, image_tag, packages_apt, packages_npm, updated_at)
     VALUES (?, ?, '["jq"]', '[]', ?)`,
    agentGroupId,
    imageTag,
    STAMP,
  );
}

async function seedSession(agentGroupId: string, id: string): Promise<Session> {
  fs.mkdirSync(path.join(TEST_DATA_DIR, 'v2-sessions', agentGroupId, id), { recursive: true });
  getAgentMailbox().prepare({ agentGroupId, sessionId: id });
  await getDb().run(
    `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status,
                           container_status, last_active, created_at)
     VALUES (?, ?, NULL, ?, NULL, 'active', 'stopped', NULL, ?)`,
    id,
    agentGroupId,
    id,
    STAMP,
  );
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: id,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: STAMP,
  };
}

async function sweepRetry(session: Session): Promise<void> {
  await wakeContainer(session);
  if (hooks.spawned.has(session.id)) {
    await until(() => !isContainerRunning(session.id), `the container for ${session.id} never finalized`);
  }
}

async function rebuildSettled(agentGroupId: string): Promise<void> {
  for (let pending = _agentGroupImageRebuildForTesting(agentGroupId); pending; ) {
    await pending;
    pending = _agentGroupImageRebuildForTesting(agentGroupId);
  }
}

function failedRebuildLogs(): number {
  return vi
    .mocked(log.error)
    .mock.calls.filter((call) => call[0] === 'Per-agent-group image rebuild failed; its spawns stay refused').length;
}

describe('a drifted per-agent image rebuilds itself', () => {
  beforeEach(async () => {
    hooks.reset();
    resetDepsDriftCacheForTests();
    vi.mocked(log.error).mockClear();
    vi.mocked(notifyOwner).mockClear();
    vi.mocked(requestContainerRebuild).mockClear();
    fs.mkdirSync(TEST_DATA_DIR, { recursive: true });
    const dbPath = path.join(TEST_DATA_DIR, `central-${crypto.randomUUID()}.db`);
    const seed = new BetterSqlite3(dbPath);
    runMigrations(seed);
    seed.close();
    await initDb(dbPath, { role: 'test' });
    await getDb().run(
      "INSERT INTO workgroups (id, display_name, created_at) VALUES ('wg-image-drift', 'image drift', ?)",
      STAMP,
    );
    vi.stubEnv('NANOCLAW_STORAGE_MANAGER_ENABLED', '0');
    allowSubprocess([ABSENT_CONTAINER_RUNTIME_BIN]);
  });

  afterEach(async () => {
    vi.useRealTimers();
    await stopHostInstanceLease();
    vi.unstubAllEnvs();
    await closeDb();
  });

  it('starts one build across repeated refused spawns, and the spawn goes through once it lands', async () => {
    await seedGroup('ag-drift-heal');
    const session = await seedSession('ag-drift-heal', 'sess-drift-heal');
    let releaseBuild!: () => void;
    hooks.buildGate = new Promise<void>((resolve) => (releaseBuild = resolve));

    await sweepRetry(session);
    await until(() => hooks.builds.length === 1, 'the refused spawn started no rebuild of the per-agent image');
    for (let retry = 0; retry < 5; retry++) await sweepRetry(session);
    expect(hooks.spawned.has(session.id)).toBe(false);
    expect(hooks.baseChecks, 'retries during the build each started an attempt of their own').toBe(1);

    releaseBuild();
    await until(() => hooks.built.has(agentGroupImageTag('ag-drift-heal')), 'the rebuild never landed');
    await until(
      () => !fs.existsSync(path.join(TEST_DATA_DIR, 'Dockerfile.ag-drift-heal')),
      'the rebuild never finished',
    );
    await sweepRetry(session);
    await rebuildSettled('ag-drift-heal');

    expect(hooks.spawned.has(session.id), 'the spawn was still refused after the rebuild landed').toBe(true);
    expect(hooks.builds).toEqual([agentGroupImageTag('ag-drift-heal')]);
    expect(vi.mocked(requestContainerRebuild)).not.toHaveBeenCalled();
  });

  it('does not build on a drifted base: it asks for the base rebuild and leaves the group to the next retry', async () => {
    await seedGroup('ag-drift-base');
    const session = await seedSession('ag-drift-base', 'sess-drift-base');
    hooks.baseDrifted = true;

    await sweepRetry(session);
    await until(
      () => vi.mocked(requestContainerRebuild).mock.calls.length > 0,
      'the per-agent refusal never asked for the drifted base to be rebuilt',
    );

    expect(hooks.builds).toEqual([]);
    expect(hooks.spawned.has(session.id)).toBe(false);
  });

  it('alerts the owner once per failure episode, not once per retry', async () => {
    await seedGroup('ag-drift-fail');
    const session = await seedSession('ag-drift-fail', 'sess-drift-fail');
    hooks.buildFails = true;
    vi.useFakeTimers({ toFake: ['Date'] });

    await sweepRetry(session);
    await until(() => vi.mocked(notifyOwner).mock.calls.length === 1, 'a failed rebuild never alerted the owner');
    await rebuildSettled('ag-drift-fail');
    await sweepRetry(session);
    expect(_agentGroupImageRebuildForTesting('ag-drift-fail')).toBeUndefined();
    expect(hooks.builds).toHaveLength(1);

    vi.setSystemTime(Date.now() + MIN_RETRY_INTERVAL_MS + 1);
    await sweepRetry(session);
    await until(() => failedRebuildLogs() === 2, 'the retry after the cooldown never rebuilt');

    expect(hooks.builds).toHaveLength(2);
    expect(vi.mocked(notifyOwner)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(notifyOwner).mock.calls[0][0].title).toContain('ag-drift-fail');
  });

  it('a rebuild by hand ends the failure episode, so the next deploy that breaks the image alerts again', async () => {
    await seedGroup('ag-drift-manual');
    const session = await seedSession('ag-drift-manual', 'sess-drift-manual');
    hooks.buildFails = true;
    await sweepRetry(session);
    await until(() => vi.mocked(notifyOwner).mock.calls.length === 1, 'a failed rebuild never alerted the owner');
    await rebuildSettled('ag-drift-manual');

    hooks.buildFails = false;
    await buildAgentGroupImage('ag-drift-manual');
    hooks.built.clear();
    hooks.buildFails = true;
    await sweepRetry(session);

    await until(
      () => vi.mocked(notifyOwner).mock.calls.length === 2,
      'a failure after a successful manual rebuild was treated as the old episode',
    );
  });

  it('a build that lands while the alert is in flight still ends the episode', async () => {
    await seedGroup('ag-drift-alert-race');
    const session = await seedSession('ag-drift-alert-race', 'sess-drift-alert-race');
    hooks.buildFails = true;
    vi.mocked(notifyOwner).mockImplementationOnce(async () => {
      hooks.buildFails = false;
      await buildAgentGroupImage('ag-drift-alert-race');
      return { code: 0, message: 'delivered' };
    });
    await sweepRetry(session);
    await rebuildSettled('ag-drift-alert-race');
    expect(vi.mocked(notifyOwner)).toHaveBeenCalledTimes(1);

    hooks.built.clear();
    hooks.buildFails = true;
    await sweepRetry(session);

    await until(
      () => vi.mocked(notifyOwner).mock.calls.length === 2,
      'the in-flight alert re-marked an episode the build had already ended',
    );
  });

  it('does not rebuild on an inspect error', async () => {
    await seedGroup('ag-drift-inspect');
    const session = await seedSession('ag-drift-inspect', 'sess-drift-inspect');
    hooks.inspectFails = true;

    await sweepRetry(session);

    expect(_agentGroupImageRebuildForTesting('ag-drift-inspect')).toBeUndefined();
    expect(hooks.builds).toEqual([]);
  });

  it('neither builds nor asks for a base rebuild when the base inspect fails', async () => {
    await seedGroup('ag-drift-base-inspect');
    const session = await seedSession('ag-drift-base-inspect', 'sess-drift-base-inspect');
    hooks.baseInspectFails = true;

    await sweepRetry(session);
    await rebuildSettled('ag-drift-base-inspect');

    expect(hooks.baseChecks).toBe(1);
    expect(vi.mocked(requestContainerRebuild)).not.toHaveBeenCalled();
    expect(hooks.builds).toEqual([]);
  });

  it('leaves an admin image_tag override alone', async () => {
    await seedGroup('ag-drift-override', 'custom-registry/agent:pinned');
    const session = await seedSession('ag-drift-override', 'sess-drift-override');

    await sweepRetry(session);

    expect(_agentGroupImageRebuildForTesting('ag-drift-override')).toBeUndefined();
    expect(hooks.builds).toEqual([]);
    expect(hooks.spawned.has(session.id)).toBe(false);
  });

  it('does not queue behind an install build that started while it checked the base', async () => {
    await seedGroup('ag-drift-install');
    const session = await seedSession('ag-drift-install', 'sess-drift-install');
    let releaseBaseCheck!: () => void;
    hooks.baseCheckGate = new Promise<void>((resolve) => (releaseBaseCheck = resolve));

    await sweepRetry(session);
    await until(() => hooks.baseChecksParked === 1, 'the drift rebuild never checked the base');
    const install = buildAgentGroupImage('ag-drift-install', { apt: ['curl'], npm: [] });
    releaseBaseCheck();
    await install;
    await rebuildSettled('ag-drift-install');

    expect(hooks.builds).toEqual([agentGroupImageTag('ag-drift-install')]);
  });
  it.each([
    ['records an older base', 'ag-base-old', 'sha256:base-fixture-old'],
    ['records no base', 'ag-base-unrecorded', undefined],
  ])(
    'refuses a per-agent image that %s, rebuilds it on the current base, then spawns it',
    async (_case, id, recorded) => {
      await seedGroup(id);
      const session = await seedSession(id, `sess-${id}`);
      const tag = agentGroupImageTag(id);
      hooks.realCheck = true;
      if (recorded) hooks.recordedBase.set(tag, recorded);

      await sweepRetry(session);
      expect(hooks.spawned.has(session.id), 'a per-agent image on a stale base spawned').toBe(false);
      await until(() => hooks.builds.length === 1, 'the stale-base refusal requested no rebuild');
      await rebuildSettled(id);
      expect(hooks.recordedBase.get(tag)).toBe(hooks.currentBaseId);

      await sweepRetry(session);
      expect(hooks.spawned.has(session.id), 'the rebuilt image on the current base was still refused').toBe(true);
      expect(hooks.builds).toEqual([tag]);
    },
  );

  it('a base gone after its deps check passed asks for the base rebuild, not a group failure', async () => {
    await seedGroup('ag-base-missing');
    const session = await seedSession('ag-base-missing', 'sess-base-missing');
    hooks.realCheck = true;
    hooks.recordedBase.set(agentGroupImageTag('ag-base-missing'), hooks.currentBaseId);
    hooks.baseMissing = true;

    await sweepRetry(session);
    await until(
      () => vi.mocked(requestContainerRebuild).mock.calls.length > 0,
      'a missing base never asked for the base rebuild',
    );
    await rebuildSettled('ag-base-missing');

    expect(hooks.spawned.has(session.id)).toBe(false);
    expect(hooks.builds).toEqual([]);
    expect(failedRebuildLogs()).toBe(0);
    expect(vi.mocked(notifyOwner)).not.toHaveBeenCalled();
  });

  it('spawns a per-agent image built on the current base without rebuilding it', async () => {
    await seedGroup('ag-base-current');
    const session = await seedSession('ag-base-current', 'sess-base-current');
    hooks.realCheck = true;
    hooks.recordedBase.set(agentGroupImageTag('ag-base-current'), hooks.currentBaseId);

    await sweepRetry(session);
    await rebuildSettled('ag-base-current');

    expect(hooks.spawned.has(session.id)).toBe(true);
    expect(hooks.builds).toEqual([]);
  });

  it('at boot, rebuilds each per-agent image on a stale base once and leaves a current one alone', async () => {
    await seedGroup('ag-boot-stale');
    await seedGroup('ag-boot-current');
    hooks.realCheck = true;
    hooks.recordedBase.set(agentGroupImageTag('ag-boot-stale'), 'sha256:base-fixture-old');
    hooks.recordedBase.set(agentGroupImageTag('ag-boot-current'), hooks.currentBaseId);

    await prewarmAgentGroupImages();

    expect(hooks.builds).toEqual([agentGroupImageTag('ag-boot-stale')]);
    expect(hooks.recordedBase.get(agentGroupImageTag('ag-boot-stale'))).toBe(hooks.currentBaseId);
  });
});
