import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../../test-hermeticity.js';

const { ROOT, STUB } = vi.hoisted(() => {
  const root = uniqueTmpRoot('test-migrate-sandbox');
  return { ROOT: root, STUB: `${root}/docker` };
});
vi.mock('../../container-runtime.js', () => ({ CONTAINER_RUNTIME_BIN: STUB }));

const { docker, sandboxArgs, stopLeftoverSandboxes, OUTPUT_MAX_BYTES } = await import('./migrate-sandbox.js');
const { INSTALL_SLUG } = await import('../../config.js');

enforceHermeticity();
allowSubprocess([STUB, 'bash', 'sleep', 'head', 'tr']);

const CALLS = path.join(ROOT, 'calls');

/** A container runtime that records each call: `run` prints, then exits or sleeps; `ps` lists two containers, `network ls` one network. */
function stub(run: string): void {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(
    STUB,
    `#!/bin/bash\necho "$*" >> ${CALLS}\ncase "$1 $2" in\n  run*) ${run} ;;\n  ps*) printf 'id-1\\nid-2\\n' ;;\n  "network ls") printf 'net-1\\n' ;;\nesac\n`,
    { mode: 0o755 },
  );
}

const calls = () => fs.readFileSync(CALLS, 'utf8').trim().split('\n');

beforeEach(() => fs.rmSync(CALLS, { force: true }));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('docker', () => {
  it('returns the exit code and both streams of a run that finishes', async () => {
    stub('echo out; echo err >&2; exit 3');
    expect(await docker(['run', 'x'], 'sandbox-1', 5000)).toEqual({
      code: 3,
      timedOut: false,
      overflowed: false,
      stdout: 'out\n',
      stderr: 'err\n',
    });
  });

  it('interrupts the named container once the run outlives its time, and reports it timed out', async () => {
    stub('sleep 1');
    const result = await docker(['run', 'x'], 'sandbox-2', 100);
    expect(result.timedOut).toBe(true);
    await vi.waitFor(() => expect(calls()).toContain('kill --signal INT sandbox-2'));
  });
});

describe('docker output', () => {
  it('keeps no more than the cap, and interrupts a sandbox that prints past it', async () => {
    stub("head -c 1500000 /dev/zero | tr '\\\\0' x; sleep 1");
    const result = await docker(['run', 'x'], 'sandbox-3', 5000);
    expect(result.overflowed).toBe(true);
    expect(result.stdout.length).toBe(OUTPUT_MAX_BYTES);
    await vi.waitFor(() => expect(calls()).toContain('kill --signal INT sandbox-3'));
  });
});

describe('sandboxArgs', () => {
  it('runs the sandbox as the host user, who owns the extracted tree, where session containers do', () => {
    const args = sandboxArgs('s', '/t', 'none', 1001, 1002);
    expect(args[0]).toBe('run');
    expect(args.slice(1, 3)).toEqual(['--user', '1001:1002']);
    expect(sandboxArgs('s', '/t', 'none', 1000, 1000)).not.toContain('--user');
  });
});

describe('sandbox hardening', () => {
  it('mounts the tree read-only on a read-only root, drops every capability, and forbids privilege gain', () => {
    const args = sandboxArgs('s', '/t', 'none', 1000, 1000).join(' ');
    for (const flag of [
      '-v /t:/work:ro',
      '--read-only',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--network none',
      '--log-driver none',
    ]) {
      expect(args).toContain(flag);
    }
  });
});

describe('stopLeftoverSandboxes', () => {
  it('removes every sandbox and relay a previous host left, stopped or running, then their networks', async () => {
    stub('true');
    await stopLeftoverSandboxes();
    expect(calls()).toEqual([
      `ps -aq --filter label=nanoclaw.approved-run=${INSTALL_SLUG}`,
      'rm -f id-1 id-2',
      `network ls -q --filter label=nanoclaw.approved-run=${INSTALL_SLUG}`,
      'network rm net-1',
    ]);
  });
});
