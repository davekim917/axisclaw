/**
 * The deploy's nightly warning, run through the real script up to its first refusal.
 *
 * A dirty tracked file stops every run at the preflight step after the warning, so nothing past it runs and
 * reaching that refusal is what proves the warning let the deploy carry on.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { execFileSync, spawnSync } from 'child_process';
import { fileURLToPath } from 'url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { scaledTimeout } from './test-timeout-scale.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ORIGIN = 'https://example.invalid/fixture-owner/fixture-repo.git';
const HANG_TIMEOUT_MS = scaledTimeout(15_000);
/** The five-second budget, plus what the script itself costs on a loaded runner. */
const BUDGET_MS = 6_000;

interface FakeRun {
  status: string;
  conclusion: string;
  createdAt: string;
}

const run = (conclusion: string, date: string, status = 'completed'): FakeRun => ({
  status,
  conclusion,
  createdAt: `${date}T09:30:00Z`,
});

interface GhBehaviour {
  runs?: FakeRun[];
  runsMode?: 'fail' | 'hang' | 'slow';
  issue?: string;
  issueMode?: 'fail' | 'hang';
}

let dir: string;
let repo: string;
let bin: string;

/**
 * Honours the filters the way gh does: only the right repo gets an answer, and only the scheduled main runs of the
 * right workflow are the fixture. Anything wider sees a green decoy, so a dropped filter reads as green and fails.
 */
function writeFakeGh(behaviour: GhBehaviour): void {
  const runsFile = path.join(dir, 'runs.json');
  fs.writeFileSync(runsFile, JSON.stringify(behaviour.runs ?? []));
  const decoyFile = path.join(dir, 'decoy.json');
  fs.writeFileSync(decoyFile, JSON.stringify([run('success', '2099-01-01')]));
  const fake = [
    '#!/bin/bash',
    'args=" $* "',
    `[[ "$args" == *" --repo ${ORIGIN} "* ]] || exit 1`,
    'while [ $# -gt 0 ]; do [ "$1" = "--jq" ] && prog="$2"; shift; done',
    'if [[ "$args" == *" run list "* ]]; then',
    `  case "${behaviour.runsMode ?? ''}" in`,
    '    fail) echo "HTTP 502" >&2; exit 1 ;;',
    '    hang) exec sleep 30 ;;',
    '    slow) sleep 3 ;;',
    '  esac',
    `  fixture="${decoyFile}"`,
    '  if [[ "$args" == *" --workflow ci-full.yml "* && "$args" == *" --branch main "* && "$args" == *" --event schedule "* ]]; then',
    `    fixture="${runsFile}"`,
    '  fi',
    '  exec jq -r "$prog" "$fixture"',
    'fi',
    `case "${behaviour.issueMode ?? ''}" in`,
    '  fail) exit 1 ;;',
    '  hang) exec sleep 30 ;;',
    'esac',
    `[[ "$args" == *" --state open "* ]] && echo "${behaviour.issue ?? ''}"`,
  ].join('\n');
  fs.writeFileSync(path.join(bin, 'gh'), `${fake}\n`, { mode: 0o755 });
}

function deploy(behaviour: GhBehaviour): { stdout: string; exitCode: number | null; ms: number; error: string } {
  writeFakeGh(behaviour);
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: dir, NANOCLAW_DEPLOY_ROOT: repo };
  const started = Date.now();
  const result = spawnSync('bash', [path.join(projectRoot, 'scripts', 'deploy.sh')], {
    cwd: repo,
    encoding: 'utf-8',
    env,
  });
  const status = JSON.parse(fs.readFileSync(path.join(repo, 'logs', 'deploy-status.json'), 'utf-8')) as {
    error: string;
  };
  return { stdout: result.stdout, exitCode: result.status, ms: Date.now() - started, error: status.error };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-deploy-nightly-'));
  repo = path.join(dir, 'checkout');
  bin = path.join(dir, 'bin');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(bin);
  fs.copyFileSync(
    path.join(projectRoot, 'scripts', 'write-deploy-json.mjs'),
    path.join(repo, 'scripts', 'write-deploy-json.mjs'),
  );
  fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nexit 99\n', { mode: 0o755 });
  const git = (...args: string[]) =>
    execFileSync('git', args, { cwd: repo, env: { PATH: process.env.PATH, HOME: dir }, stdio: 'ignore' });
  git('init', '-q', '-b', 'main');
  git('remote', 'add', 'origin', ORIGIN);
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'one\n');
  git('add', 'tracked.txt');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-q', '-m', 'seed');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'two\n');
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function expectDeployCarriedOn(result: ReturnType<typeof deploy>): void {
  expect(result.exitCode).toBe(1);
  expect(result.error).toContain('tracked source changes present');
}

describe('deploy preflight nightly warning', () => {
  it.each<[string, FakeRun[], string]>([
    [
      'a red nightly, dated from the start of the streak',
      [run('failure', '2031-03-09'), run('failure', '2031-03-08'), run('success', '2031-03-07')],
      'NIGHTLY RED on main since 2031-03-08: #4242\n',
    ],
    [
      'the last finished run while a newer one is running',
      [run('', '2031-03-09', 'in_progress'), run('failure', '2031-03-08'), run('success', '2031-03-07')],
      'NIGHTLY RED on main since 2031-03-08: #4242\n',
    ],
    [
      'a run that timed out, which is not a pass',
      [run('timed_out', '2031-03-09'), run('success', '2031-03-08')],
      'NIGHTLY RED on main since 2031-03-09: #4242\n',
    ],
    [
      'a red history with no green in the window, from its oldest run',
      [run('failure', '2031-03-09'), run('failure', '2031-03-08')],
      'NIGHTLY RED on main since 2031-03-08: #4242\n',
    ],
    ['nothing for a green nightly', [run('success', '2031-03-09'), run('failure', '2031-03-08')], ''],
    [
      'the verdict under a cancelled or skipped run',
      [run('cancelled', '2031-03-10'), run('skipped', '2031-03-09'), run('failure', '2031-03-08')],
      'NIGHTLY RED on main since 2031-03-08: #4242\n',
    ],
    ['unknown when no run has finished', [run('', '2031-03-09', 'in_progress')], 'nightly state unknown\n'],
    ['unknown when there are no runs at all', [], 'nightly state unknown\n'],
    ['unknown when only cancelled runs exist', [run('cancelled', '2031-03-09')], 'nightly state unknown\n'],
  ])('prints %s', (_name, runs, expected) => {
    const result = deploy({ runs, issue: '4242' });
    expect(result.stdout).toBe(expected);
    expectDeployCarriedOn(result);
  });

  it('a gh failure neither stops the deploy nor reads as green', () => {
    const result = deploy({ runsMode: 'fail' });
    expect(result.stdout).toBe('nightly state unknown\n');
    expectDeployCarriedOn(result);
  });

  it(
    'a gh that hangs is cut off, reads as unknown, and the deploy carries on',
    () => {
      const result = deploy({ runsMode: 'hang' });
      expect(result.stdout).toBe('nightly state unknown\n');
      expect(result.ms).toBeLessThan(BUDGET_MS);
      expectDeployCarriedOn(result);
    },
    HANG_TIMEOUT_MS,
  );

  it('still reports red when the issue lookup fails', () => {
    const result = deploy({ runs: [run('failure', '2031-03-09')], issueMode: 'fail' });
    expect(result.stdout).toBe('NIGHTLY RED on main since 2031-03-09\n');
    expectDeployCarriedOn(result);
  });

  it('still reports red with no open issue to name', () => {
    const result = deploy({ runs: [run('failure', '2031-03-09')] });
    expect(result.stdout).toBe('NIGHTLY RED on main since 2031-03-09\n');
    expectDeployCarriedOn(result);
  });

  it(
    'a slow run lookup and a hung issue lookup stay inside the budget together',
    () => {
      const result = deploy({ runs: [run('failure', '2031-03-09')], runsMode: 'slow', issueMode: 'hang' });
      expect(result.stdout).toBe('NIGHTLY RED on main since 2031-03-09\n');
      expect(result.ms).toBeLessThan(BUDGET_MS);
      expectDeployCarriedOn(result);
    },
    HANG_TIMEOUT_MS,
  );

  it('records the warning in the deploy log, which is all a detached deploy leaves', () => {
    deploy({ runs: [run('failure', '2031-03-09')], issue: '4242' });
    expect(fs.readFileSync(path.join(repo, 'logs', 'deploy.log'), 'utf-8')).toContain(
      'NIGHTLY RED on main since 2031-03-09: #4242',
    );
  });
});
