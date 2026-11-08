import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { allowSubprocess } from '../test-hermeticity.js';
import { readSystemCodexHooks } from './codex-app-server.js';

/** The image copies this directory to /etc/codex. */
const CODEX_SYSTEM = new URL('../../../codex-system/', import.meta.url).pathname;
const SHIPPED_HOOKS = path.join(CODEX_SYSTEM, 'hooks.json');
const IMAGE_BUN = '/usr/local/bin/bun';

type Handler = { type: string; command: string; timeout: number };

function shippedHandler(event: 'PreToolUse' | 'PostToolUse'): Handler {
  const hooks = readSystemCodexHooks(SHIPPED_HOOKS) as Record<string, Array<{ hooks: Handler[] }>> | null;
  expect(hooks?.[event]).toHaveLength(1);
  expect(hooks![event][0].hooks).toHaveLength(1);
  return hooks![event][0].hooks[0];
}

describe('the shipped Codex guard chain', () => {
  it('runs the hook CLI for PreToolUse (1h, for the email-gate approval wait) and PostToolUse (30s)', () => {
    const pre = shippedHandler('PreToolUse');
    const post = shippedHandler('PostToolUse');
    expect([pre.type, pre.timeout]).toEqual(['command', 3600]);
    expect([post.type, post.timeout]).toEqual(['command', 30]);
    expect(pre.command).toEndWith(' /app/src/codex-hooks/cli.ts PreToolUse');
    expect(post.command).toEndWith(' /app/src/codex-hooks/cli.ts PostToolUse');
    expect(fs.existsSync(new URL('../codex-hooks/cli.ts', import.meta.url))).toBe(true);
    // One command line for both events, so a scrub added to one cannot be missing from the other.
    expect(pre.command.replace(/PreToolUse$/, '')).toBe(post.command.replace(/PostToolUse$/, ''));
  });

  it('is pinned on by the requirements layer', () => {
    expect(fs.readFileSync(path.join(CODEX_SYSTEM, 'requirements.toml'), 'utf8')).toMatch(
      /^\[features\]\nhooks = true$/m,
    );
  });

  it('reads as no chain when the file is absent or malformed', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-system-hooks-'));
    try {
      expect(readSystemCodexHooks(path.join(root, 'absent.json'))).toBeNull();
      fs.writeFileSync(path.join(root, 'bad.json'), '{"hooks": [');
      expect(readSystemCodexHooks(path.join(root, 'bad.json'))).toBeNull();
      fs.writeFileSync(path.join(root, 'list.json'), '{"hooks": []}');
      expect(readSystemCodexHooks(path.join(root, 'list.json'))).toBeNull();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

// The hook process starts under the env and cwd of whoever ran codex, which runs it as `/bin/bash -c <command>`.
// Each door is shown open on a bare `bun` first, so a closed result cannot come from a door that never opened.
(fs.existsSync(IMAGE_BUN) ? describe : describe.skip)('the guard hook command against a hostile caller', () => {
  allowSubprocess(['bash']);
  let root: string;
  let probe: string;
  let evil: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-doors-'));
    probe = path.join(root, 'probe.ts');
    evil = path.join(root, 'evil.ts');
    fs.writeFileSync(probe, 'console.log("hook ran under " + process.execPath);');
    fs.writeFileSync(evil, 'console.log("PRELOADED");');
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  /** The shipped command with only its two image-installed paths moved: the fixed bunfig and the hook CLI. */
  function shippedCommand(): string {
    return shippedHandler('PreToolUse')
      .command.replace(
        '--config=/etc/codex/hook-bunfig.toml',
        `--config=${path.join(CODEX_SYSTEM, 'hook-bunfig.toml')}`,
      )
      .replace('/app/src/codex-hooks/cli.ts PreToolUse', probe);
  }

  function run(command: string, env: Record<string, string>, cwd = root): string {
    const result = spawnSync('/bin/bash', ['-c', command], {
      cwd,
      env: { PATH: '/usr/bin:/bin', HOME: root, ...env },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    return result.stdout;
  }

  const clean = (): string => `hook ran under ${IMAGE_BUN}\n`;

  it('a bunfig.toml preload in the caller cwd', () => {
    const cwd = path.join(root, 'work');
    fs.mkdirSync(cwd);
    fs.writeFileSync(path.join(cwd, 'bunfig.toml'), `preload = [${JSON.stringify(evil)}]\n`);
    expect(run(`${IMAGE_BUN} ${probe}`, {}, cwd)).toContain('PRELOADED');
    expect(run(shippedCommand(), {}, cwd)).toBe(clean());
  });

  for (const [name, value] of [
    ['BUN_OPTIONS', () => `--preload ${evil}`],
    ['BUN_INSPECT_PRELOAD', () => evil],
  ] as const) {
    it(`${name} in the caller env`, () => {
      expect(run(`${IMAGE_BUN} ${probe}`, { [name]: value() })).toContain('PRELOADED');
      expect(run(shippedCommand(), { [name]: value() })).toBe(clean());
    });
  }

  it('a bun or env earlier on the caller PATH', () => {
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin);
    for (const tool of ['bun', 'env']) {
      fs.writeFileSync(path.join(bin, tool), '#!/bin/sh\necho FAKE\n', { mode: 0o755 });
    }
    const PATH = `${bin}:/usr/bin:/bin`;
    expect(run(`bun ${probe}`, { PATH })).toBe('FAKE\n');
    expect(run(shippedCommand(), { PATH })).toBe(clean());
  });
});
