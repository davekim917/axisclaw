import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';
import { scaledTimeout } from '../src/test-timeout-scale.js';

allowSubprocess(['bash', 'git']);
enforceHermeticity();

/**
 * scripts/test-safe.sh, the one way to run vitest on a host that also runs production. vitest
 * and pnpm are faked: each fake records its argv, its niceness and IO class, and when it ran,
 * so the tests see exactly what the wrapper started and under which priority and lock.
 */

const SCRIPT = path.resolve('scripts/test-safe.sh');
const roots: string[] = [];

const FAKE = `#!/usr/bin/env bash
rec="$RECORD_DIR/$(basename "$0")-$$"
{
  echo "start $(date +%s%N)"
  echo "nice $(nice)"
  echo "io $(ionice -p $$)"
  printf 'arg %s\\n' "$@"
} >"$rec"
sleep "\${FAKE_SLEEP:-0}"
echo "end $(date +%s%N)" >>"$rec"
`;

function sandbox(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'test-safe-'));
  roots.push(root);
  spawnSync('git', ['init', '-q', root], { env: { PATH: process.env.PATH ?? '' } });
  for (const dir of ['node_modules/.bin', 'bin', 'records']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  for (const fake of ['node_modules/.bin/vitest', 'bin/pnpm']) {
    fs.writeFileSync(path.join(root, fake), FAKE, { mode: 0o755 });
  }
  return root;
}

function env(root: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return {
    PATH: `${path.join(root, 'bin')}:${process.env.PATH ?? ''}`,
    HOME: root,
    RECORD_DIR: path.join(root, 'records'),
    TEST_SAFE_LOCK: path.join(root, 'vitest.lock'),
    ...extra,
  };
}

function run(root: string, args: string[], extra: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], { cwd: root, env: env(root, extra), encoding: 'utf8' });
}

interface Run {
  start: bigint;
  end: bigint;
  nice: number;
  io: string;
  args: string[];
}

function records(root: string, tool: 'vitest' | 'pnpm'): Run[] {
  const dir = path.join(root, 'records');
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(`${tool}-`))
    .map((f) => {
      const lines = fs.readFileSync(path.join(dir, f), 'utf8').trim().split('\n');
      const field = (k: string) => lines.filter((l) => l.startsWith(`${k} `)).map((l) => l.slice(k.length + 1));
      return {
        start: BigInt(field('start')[0]),
        end: BigInt(field('end')[0]),
        nice: Number(field('nice')[0]),
        io: field('io')[0],
        args: field('arg'),
      };
    });
}

interface Row {
  name: string;
  extra: Record<string, string>;
  args: string[] | null;
  status: number;
  leading?: boolean;
}

const expectedNice = Math.min(19, os.getPriority() + 10);

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('test-safe.sh', () => {
  it('refuses an installed host checkout and never starts vitest', () => {
    const root = sandbox();
    fs.mkdirSync(path.join(root, 'data'));
    fs.writeFileSync(path.join(root, 'data', 'v2.db'), '');
    const r = run(root, ['src/a.test.ts']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('it is an installed host (data/v2.db exists)');
    expect(records(root, 'vitest')).toEqual([]);
  });

  it('runs the named files on two workers at idle IO and ten nice levels lower', () => {
    const root = sandbox();
    const r = run(root, ['src/a.test.ts', '--reporter=dot']);
    expect(r.status, r.stderr).toBe(0);
    const [rec] = records(root, 'vitest');
    expect(rec.args).toEqual([
      'run',
      '--maxWorkers=2',
      '--testTimeout=15000',
      '--hookTimeout=30000',
      'src/a.test.ts',
      '--reporter=dot',
    ]);
    expect(rec.nice).toBe(expectedNice);
    expect(rec.io).toBe('idle');
  });

  it.each<Row>([
    {
      name: 'TEST_SAFE_MAX_WORKERS=1 lowers the worker count',
      extra: { TEST_SAFE_MAX_WORKERS: '1' },
      args: [],
      status: 0,
    },
    { name: 'TEST_SAFE_MAX_WORKERS=3 is refused', extra: { TEST_SAFE_MAX_WORKERS: '3' }, args: [], status: 2 },
    { name: 'a --maxWorkers flag is refused', extra: {}, args: ['--maxWorkers=8'], status: 2 },
    { name: 'a run that names no test file (the full suite) is refused', extra: {}, args: null, status: 2 },
    {
      name: "a flag's split value is not taken for a test file",
      extra: {},
      args: ['--config', 'vitest.config.ts'],
      status: 2,
      leading: false,
    },
  ])('$name', ({ extra, args, status, leading = true }) => {
    const root = sandbox();
    const argv = args === null ? ['--reporter=dot'] : leading ? ['src/a.test.ts', ...args] : args;
    const r = run(root, argv, extra);
    expect(r.status, r.stderr).toBe(status);
    const recs = records(root, 'vitest');
    if (status === 0) expect(recs[0].args.slice(0, 2)).toEqual(['run', '--maxWorkers=1']);
    else expect(recs).toEqual([]);
  });

  // vitest aborts on a repeated option, so each row asserts the wrapper's default is gone, not merely later.
  it.each<{ name: string; args: string[]; timeouts: string[] }>([
    {
      name: "a caller's --testTimeout replaces the default and keeps the hook default",
      args: ['--testTimeout=2000'],
      timeouts: ['--hookTimeout=30000', '--testTimeout=2000'],
    },
    {
      name: "a caller's split --hookTimeout replaces the default and keeps the test default",
      args: ['--hookTimeout', '2000'],
      timeouts: ['--testTimeout=15000', '--hookTimeout'],
    },
    {
      name: 'the kebab spelling counts as the same option',
      args: ['--test-timeout=2000', '--hook-timeout=2000'],
      timeouts: ['--test-timeout=2000', '--hook-timeout=2000'],
    },
    { name: '--coverage keeps the longer limits vitest.config.ts sets', args: ['--coverage'], timeouts: [] },
    {
      name: 'a --coverage. option counts as coverage',
      args: ['--coverage.include=src/a.ts'],
      timeouts: [],
    },
  ])('$name', ({ args, timeouts }) => {
    const root = sandbox();
    const r = run(root, ['src/a.test.ts', ...args]);
    expect(r.status, r.stderr).toBe(0);
    const [rec] = records(root, 'vitest');
    expect(rec.args.filter((a) => /^--(test|hook)-?[tT]imeout/.test(a))).toEqual(timeouts);
  });

  it('runs the typed lint under the same priority', () => {
    const root = sandbox();
    const r = run(root, ['lint']);
    expect(r.status, r.stderr).toBe(0);
    const [rec] = records(root, 'pnpm');
    expect(rec.args).toEqual(['run', 'lint']);
    expect(rec.nice).toBe(expectedNice);
  });

  it(
    'a second run waits for the first instead of running beside it',
    async () => {
      const root = sandbox();
      const start = () =>
        new Promise<string>((resolve) => {
          const child = spawn('bash', [SCRIPT, 'src/a.test.ts'], { cwd: root, env: env(root, { FAKE_SLEEP: '0.6' }) });
          let stderr = '';
          child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
          child.on('close', () => resolve(stderr));
        });
      const stderrs = await Promise.all([start(), start()]);
      const [a, b] = records(root, 'vitest').sort((x, y) => (x.start < y.start ? -1 : 1));
      expect(b.start >= a.end).toBe(true);
      expect(stderrs.some((s) => s.includes('another run holds'))).toBe(true);
    },
    scaledTimeout(15_000),
  );
});
