import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

import { FAILED_CODEX_HOME } from '../codex-home-sentinel.js';
import { resetGuardCorePathsForTest, setGuardCorePathsForTest } from '../guard-core-paths.js';
import { getInboundDb, getOutboundDb } from '../mailbox/sqlite/connection.js';
import { queueWorkContinuation } from '../modules/mailbox/index.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { runPollLoop } from '../poll-loop.js';
import type { ProviderEvent } from '../providers/types.js';
import { allowSubprocess } from '../test-hermeticity.js';
import { getPendingMessages, markProcessing } from '../db/messages-in.js';
import { runEarlyTaskGate } from './early-gate.js';
import { gateBatchScripts } from './task-script.js';

const REAL_CORE = '/home/ubuntu/plugins/bootstrap/plugins/workflow-agents/hooks/guards/block-destructive-core.ts';
const savedCodexHome = process.env.CODEX_HOME;
const savedWorkgroup = process.env.NANOCLAW_WORKGROUP_ID;
const runMarker = `/tmp/nanoclaw-early-gate-${process.pid}-runs`;
const logs: string[] = [];
const deps = { log: (m: string) => logs.push(m), snapshot: async () => null };

// Running the fire's real script is the behavior under test; each script here is a fixed literal touching only /tmp.
allowSubprocess(['bash']);

beforeEach(() => {
  setGuardCorePathsForTest({ destructive: REAL_CORE });
  delete process.env.CODEX_HOME;
  fs.rmSync(runMarker, { force: true });
  logs.length = 0;
  initTestSessionDb();
});

afterEach(() => {
  resetGuardCorePathsForTest();
  if (savedCodexHome === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = savedCodexHome;
  if (savedWorkgroup === undefined) delete process.env.NANOCLAW_WORKGROUP_ID;
  else process.env.NANOCLAW_WORKGROUP_ID = savedWorkgroup;
  fs.rmSync(runMarker, { force: true });
  closeSessionDb();
});

function insertRow(id: string, kind: string, content: object, opts: { onWake?: 0 | 1; seq?: number } = {}): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, trigger, on_wake, content)
       VALUES (?, ?, ?, datetime('now'), 'pending', 1, ?, ?)`,
    )
    .run(id, opts.seq ?? null, kind, opts.onWake ?? 0, JSON.stringify(content));
}

/** Occurrence id → carried script output, as stored in outbound.db's session_state. */
const carriedInOutbound = (): Record<string, unknown> => {
  const row = getOutboundDb().prepare("SELECT value FROM session_state WHERE key = 'carried_script_wakes'").get() as
    | { value: string }
    | undefined;
  if (!row) return {};
  const wakes = JSON.parse(row.value) as Record<string, { output: unknown }>;
  return Object.fromEntries(Object.entries(wakes).map(([id, wake]) => [id, wake.output]));
};

const restartNote = {
  sender: 'system',
  senderId: 'system',
  text: 'Restarted with new config: resume the release check.',
};

/** A task whose script records each run, then prints `verdict` as its last line. */
function insertGatedTask(id: string, verdict: string, before = ''): void {
  insertRow(id, 'task', { prompt: 'check the queue', script: `${before}echo run >> ${runMarker}\necho '${verdict}'` });
}

const scriptRuns = (): number =>
  fs.existsSync(runMarker) ? fs.readFileSync(runMarker, 'utf8').trim().split('\n').length : 0;

const ackStatus = (id: string): string | undefined =>
  (
    getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
      | { status: string }
      | undefined
  )?.status;

const gateRows = (): Array<{ occurrenceId: string; wakeAgent: boolean; error?: string; observation?: unknown }> =>
  (
    getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").all() as Array<{
      content: string;
    }>
  ).map((row) => JSON.parse(row.content).gate);

/** Run the poll loop as runner-main would after the gate, until `id` completes; returns every prompt sent. */
async function bootUntilCompleted(id: string, gate: Awaited<ReturnType<typeof runEarlyTaskGate>>): Promise<string[]> {
  if (gate.exit) throw new Error('the gate exited; there is no boot to run');
  const prompts: string[] = [];
  const abort = new AbortController();
  const provider = {
    supportsNativeSlashCommands: false,
    registerMemorySessionHook: () => {},
    isSessionInvalid: () => false,
    query: (input: { prompt: string }) => {
      prompts.push(input.prompt);
      async function* events(): AsyncGenerator<ProviderEvent> {
        yield { type: 'init', continuation: 'woken-session' };
        yield { type: 'result', text: 'Looked at the three failed checks.' };
      }
      return { push: () => {}, end: () => {}, abort: () => {}, events: events() };
    },
  };
  const loop = runPollLoop({
    provider: provider as never,
    providerName: 'claude',
    cwd: '/tmp',
    signal: abort.signal,
    autosaveWorktrees: async () => ({ committed: [], failed: [], skipped: [] }),
    recordWorktreeInFlight: async () => {},
    firstPollDone: gate.afterScripts !== undefined,
  });
  const deadline = Date.now() + 3_000;
  while (ackStatus(id) !== 'completed') {
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${id} to complete`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  abort.abort();
  await loop;
  return prompts;
}

describe('early task gate', () => {
  it('exits before the agent boots when every trigger is a task its script gated', async () => {
    insertGatedTask('t-quiet', '{"wakeAgent": false}');

    expect(await runEarlyTaskGate(deps)).toEqual({ exit: true });
    expect(scriptRuns()).toBe(1);
    expect(ackStatus('t-quiet')).toBe('completed');
    expect(gateRows()).toEqual([{ occurrenceId: 't-quiet', wakeAgent: false }]);
  });

  it.each([
    ['an erroring script', 'echo boom >&2; exit 1'],
    ['a script the destructive classifier refuses', 'rm -rf /workspace/workgroup\necho \'{"wakeAgent": false}\''],
  ])('%s still acks as a failed run, so the series backs off', async (_label, script) => {
    insertRow('t-bad', 'task', { prompt: 'check', script });

    expect(await runEarlyTaskGate(deps)).toEqual({ exit: true });
    expect(ackStatus('t-bad')).toBe('script-skip:error');
    expect(gateRows()).toEqual([expect.objectContaining({ occurrenceId: 't-bad', wakeAgent: false })]);
    expect(gateRows()[0].error).toBeString();
    expect(scriptRuns()).toBe(0);
  });

  it('boots the agent with the script data, and the poll loop does not run the script again', async () => {
    insertGatedTask('t-wake', '{"wakeAgent": true, "data": {"failedChecks": 3}}');

    const gate = await runEarlyTaskGate(deps);
    expect(gate).toEqual({ exit: false, afterScripts: { worktreeBaseline: null } });
    expect(ackStatus('t-wake')).toBeUndefined();

    const prompts = await bootUntilCompleted('t-wake', gate);

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('"failedChecks": 3');
    expect(scriptRuns()).toBe(1);
    expect(gateRows()).toEqual([{ occurrenceId: 't-wake', wakeAgent: true }]);
  }, 10_000);

  it('leaves a fire due alongside other inbound to the full session, without running its script early', async () => {
    insertGatedTask('t-alongside', '{"wakeAgent": false}');
    insertRow('m-chat', 'chat', { sender: 'Operator', text: 'is the queue clear?' });

    expect(await runEarlyTaskGate(deps)).toEqual({ exit: false });
    expect(scriptRuns()).toBe(0);
    expect(ackStatus('t-alongside')).toBeUndefined();
    expect(gateRows()).toEqual([]);
  });

  it('keeps the agent when inbound lands while the script runs', async () => {
    insertGatedTask('t-slow', '{"wakeAgent": false}', 'sleep 0.4\n');

    const gate = runEarlyTaskGate(deps);
    await new Promise((resolve) => setTimeout(resolve, 100));
    insertRow('m-late', 'chat', { sender: 'Operator', text: 'arrived mid-script' });

    expect(await gate).toEqual({ exit: false, afterScripts: { worktreeBaseline: null } });
    expect(ackStatus('t-slow')).toBe('completed');
    expect(ackStatus('m-late')).toBeUndefined();
  });

  it('keeps the agent and runs no script while a work continuation is saved', async () => {
    insertGatedTask('t-promised', '{"wakeAgent": false}');
    queueWorkContinuation('finish the migration check');

    expect(await runEarlyTaskGate(deps)).toEqual({ exit: false });
    expect(scriptRuns()).toBe(0);
  });

  it('exits for a workgroup fire carrying its recall pair, the shape every workgroup task arrives in', async () => {
    process.env.NANOCLAW_WORKGROUP_ID = 'wg-example';
    insertRow('t-paired', 'task', { prompt: 'check', script: 'echo \'{"wakeAgent": false}\'' }, { seq: 2 });
    insertRow('recall-t-paired', 'system', { subtype: 'recall_context', text: 'prior context' }, { seq: 1 });

    expect(await runEarlyTaskGate(deps)).toEqual({ exit: true });
    expect(ackStatus('t-paired')).toBe('completed');
  });

  it('a woken output survives a boot that dies before the poll loop: the next container does not rerun the script', async () => {
    insertGatedTask('t-cursor', '{"wakeAgent": true, "data": {"newItems": 2}}');

    const first = await runEarlyTaskGate(deps);
    expect(first).toEqual({ exit: false, afterScripts: { worktreeBaseline: null } });
    // The respawn below shares this process, so prove the carry is in the container-owned DB, not module memory.
    expect(carriedInOutbound()).toEqual({ 't-cursor': { newItems: 2 } });

    const respawned = await runEarlyTaskGate(deps);
    expect(respawned).toEqual({ exit: false, afterScripts: { worktreeBaseline: null } });
    expect(scriptRuns()).toBe(1);
    const prompts = await bootUntilCompleted('t-cursor', respawned);
    expect(prompts[0]).toContain('"newItems": 2');
    expect(scriptRuns()).toBe(1);
  }, 10_000);

  it('keeps a carried output while its batch is dropped unclaimed, and ends it when the occurrence is claimed', async () => {
    insertGatedTask('t-fenced', '{"wakeAgent": true, "data": {"newItems": 4}}');
    await runEarlyTaskGate(deps);

    // Two poll iterations that each read the batch and drop it at admission (a repository fence) without claiming.
    for (let poll = 0; poll < 2; poll += 1) {
      const { keep } = await gateBatchScripts(getPendingMessages());
      expect(JSON.parse(keep.find((m) => m.id === 't-fenced')!.content).scriptOutput).toEqual({ newItems: 4 });
    }
    expect(scriptRuns()).toBe(1);
    expect(carriedInOutbound()).toEqual({ 't-fenced': { newItems: 4 } });

    markProcessing(['t-fenced']);
    expect(carriedInOutbound()).toEqual({});
  });

  it('leaves an on_wake row written while the script runs to the replacement container, when nothing woke', async () => {
    insertGatedTask('t-quiet-restart', '{"wakeAgent": false}', 'sleep 0.4\n');

    const gate = runEarlyTaskGate(deps);
    await new Promise((resolve) => setTimeout(resolve, 100));
    insertRow('wake-note', 'chat', restartNote, { onWake: 1 });

    expect(await gate).toEqual({ exit: true });
    expect(ackStatus('wake-note')).toBeUndefined();
  });

  it('leaves an on_wake row written while the script runs to the replacement container, when the fire woke', async () => {
    insertGatedTask('t-wake-restart', '{"wakeAgent": true, "data": {"failedChecks": 1}}', 'sleep 0.4\n');

    const gate = runEarlyTaskGate(deps);
    await new Promise((resolve) => setTimeout(resolve, 100));
    insertRow('wake-note', 'chat', restartNote, { onWake: 1 });
    const prompts = await bootUntilCompleted('t-wake-restart', await gate);

    expect(prompts.join('\n')).not.toContain('resume the release check');
    expect(ackStatus('wake-note')).toBeUndefined();
  }, 10_000);

  it('a script that reaches for codex before the full boot gets the fail-closed home, then the env is restored', async () => {
    insertRow('t-codex', 'task', {
      prompt: 'check',
      script: 'printf \'{"wakeAgent": false, "observation": "%s"}\\n\' "$CODEX_HOME"',
    });

    expect(await runEarlyTaskGate(deps)).toEqual({ exit: true });
    expect(gateRows()).toEqual([{ occurrenceId: 't-codex', wakeAgent: false, observation: FAILED_CODEX_HOME }]);
    expect(process.env.CODEX_HOME).toBeUndefined();
  });
});

describe('process entry', () => {
  const SRC = path.resolve(import.meta.dir, '..');
  const STATIC_IMPORT_RE = /^(?:import|export)\s+(?!type\b)(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/gm;
  /** Leaf data modules; a provider implementation or the Codex runtime here would load on every scheduled fire. */
  const PROVIDER_MODULES_BEFORE_GATE = [
    'providers/contract.ts',
    'providers/model-vocabulary.ts',
    'providers/secret-env.ts',
  ];

  /** Modules loaded before the gate decides, following value imports and re-exports (type-only ones are erased). */
  function staticClosure(entry: string): { files: Set<string>; packages: Set<string> } {
    const files = new Set<string>();
    const packages = new Set<string>();
    const stack = [entry];
    while (stack.length > 0) {
      const file = stack.pop()!;
      if (files.has(file)) continue;
      files.add(file);
      for (const [, spec] of fs.readFileSync(file, 'utf8').matchAll(STATIC_IMPORT_RE)) {
        if (!spec.startsWith('.')) {
          packages.add(spec);
          continue;
        }
        const target = path.resolve(path.dirname(file), spec).replace(/\.js$/, '.ts');
        if (fs.existsSync(target)) stack.push(target);
      }
    }
    return { files, packages };
  }

  it('loads no provider, MCP server or agent SDK before the early gate has decided', () => {
    const { files, packages } = staticClosure(path.join(SRC, 'index.ts'));
    const loaded = [...files].map((file) => path.relative(SRC, file));

    expect(loaded).toContain('scheduling/early-gate.ts');
    expect(
      loaded.filter((file) => /^(runner-main|poll-loop|codex-companion-setup)\.ts$|^mcp-tools\//.test(file)),
    ).toEqual([]);
    expect(loaded.filter((file) => file.startsWith('providers/')).sort()).toEqual(PROVIDER_MODULES_BEFORE_GATE);
    expect(
      [...packages].filter((pkg) => pkg.startsWith('@anthropic-ai/') || pkg.startsWith('@modelcontextprotocol/')),
    ).toEqual([]);
  });
});
