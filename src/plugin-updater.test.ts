import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('./codex-sync.js', () => ({
  syncCodexSubagents: vi.fn(() => ({ targets: [], discovered: 0, writes: 0, removedFiles: 0, skipped: [] })),
  syncCodexLocalMarketplacePluginCache: vi.fn(() => ({
    target: '',
    marketplaces: 0,
    installed: [],
    updated: [],
    removed: [],
    skipped: [],
    errors: [],
  })),
}));
vi.mock('./opencode-sync.js', () => ({
  syncOpenCodeSubagents: vi.fn(() => ({ targets: [], discovered: 0, writes: 0, removedFiles: 0, skipped: [] })),
}));
vi.mock('./codex-skill-materialize.js', () => ({ refreshMaterializedCodexSkills: vi.fn(() => ({ refreshed: [] })) }));
vi.mock('./design-artifact-loop-vendor.js', () => ({ vendorDesignArtifactLoop: vi.fn(() => []) }));
vi.mock('./delivery.js', () => ({ getDeliveryAdapter: vi.fn() }));
vi.mock('./host-lifecycle.js', () => ({ onHostStart: vi.fn(), onHostShutdown: vi.fn() }));

import { log } from './log.js';
import { runPluginUpdates, startPluginUpdater, stopPluginUpdater } from './plugin-updater.js';

const FAKE_NPM = `#!/bin/sh
echo "$PWD $*" >> "$FAKE_NPM_LOG"
[ -e "$PWD/.npm-fails" ] && { echo "npm ERR! boom" >&2; exit 1; }
exit 0
`;

const FAKE_CODEX = `#!/bin/sh
echo "All configured Git marketplaces are already up to date."
`;

const FAKE_GIT = `#!/bin/sh
state="$PWD/.git/fake"
case "$1" in
  rev-parse) if [ -e "$state/pulled" ]; then echo new; else echo old; fi ;;
  pull)
    fails=; [ -e "$state/pull-fails" ] && fails=$(cat "$state/pull-fails"; echo .)
    echo "pull $(env | grep -oE '^(HTTPS_PROXY|https_proxy|HTTP_PROXY|http_proxy)=' | tr -d '=' | tr '\\n' ' ')" >> "$state/pulls"
    [ "$fails" = "." ] && { echo "fatal: pull boom" >&2; exit 1; }
    [ -n "$fails" ] && { printf '%s' "\${fails%.}" >&2; exit 1; }
    [ -e "$state/upstream-moved" ] && : > "$state/pulled"
    echo "Updating" ;;
  ls-tree) if [ -e "$state/ls-tree-fails" ]; then echo "fatal: ls-tree boom" >&2; exit 128; fi ;;
  diff)
    [ -e "$state/diff-fails" ] && { echo "fatal: diff boom" >&2; exit 128; }
    [ -e "$state/diff-out" ] && tr '\\n' '\\0' < "$state/diff-out" ;;
  *) exit 2 ;;
esac
`;

const FAKE_CLAUDE = `#!/bin/sh
state="$FAKE_CLAUDE_STATE"
echo "$*" >> "$state/calls"
case "$1 $2" in
  "plugin list")
    [ -e "$state/list-fails" ] && { cat "$state/list-fails" >&2; exit 1; }
    cat "$state/list.json" ;;
  "plugin update")
    [ -e "$state/update-refused" ] && { cat "$state/update-refused"; exit 1; }
    [ -e "$state/update-unknown" ] && { cat "$state/update-unknown"; exit 0; }
    echo '{"command":"update","outcome":"ok","updateOutcome":"updated","message":"Restart to apply changes."}' ;;
  *) exit 2 ;;
esac
`;

const REGISTRY_LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'p' },
    'node_modules/a': { version: '1.0.0', resolved: 'https://registry.npmjs.org/a/-/a-1.0.0.tgz' },
  },
});

const GIT_DEP_LOCK = JSON.stringify({
  lockfileVersion: 3,
  packages: {
    '': { name: 'p' },
    'node_modules/evil': { version: '1.0.0', resolved: 'git+ssh://git@example.com/evil.git#abc' },
  },
});

let tmp: string;
let home: string;
let npmLog: string;
const saved = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  FAKE_NPM_LOG: process.env.FAKE_NPM_LOG,
  HTTPS_PROXY: process.env.HTTPS_PROXY,
  https_proxy: process.env.https_proxy,
  HTTP_PROXY: process.env.HTTP_PROXY,
  http_proxy: process.env.http_proxy,
  PLUGIN_UPDATE_NOTIFY_JID: process.env.PLUGIN_UPDATE_NOTIFY_JID,
};

function writeExecutable(file: string, body: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
}

function npmCalls(): string[] {
  if (!fs.existsSync(npmLog)) return [];
  return fs
    .readFileSync(npmLog, 'utf-8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => line.replaceAll(`${home}/plugins/`, ''));
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function useBin(bin: string): void {
  process.env.PATH = `${bin}:/usr/bin:/bin`;
}

beforeEach(() => {
  vi.clearAllMocks();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-updater-'));
  home = path.join(tmp, 'home');
  npmLog = path.join(tmp, 'npm.log');
  fs.mkdirSync(path.join(home, 'plugins'), { recursive: true });
  process.env.HOME = home;
  process.env.FAKE_NPM_LOG = npmLog;
  const bin = path.join(tmp, 'bin');
  writeExecutable(path.join(bin, 'npm'), FAKE_NPM);
  writeExecutable(path.join(bin, 'codex'), FAKE_CODEX);
  useBin(bin);
});

afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('with real git: installs only where the pulled range changed a lockfile', () => {
  const gitEnv = () => ({
    ...process.env,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't',
    GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't',
    GIT_COMMITTER_EMAIL: 't@example.com',
  });
  const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, env: gitEnv(), encoding: 'utf-8', stdio: 'pipe' });

  let upstream: string;

  beforeEach(() => {
    process.env.GIT_CONFIG_NOSYSTEM = '1';
    upstream = path.join(tmp, 'upstream');
    fs.mkdirSync(upstream);
    git(upstream, 'init', '-q', '-b', 'main');
    write(path.join(upstream, 'package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'plugins/changed/package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'plugins/unchanged/package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'plugins/deleted/package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'plugins/gitdep/package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'plugins/never-installed/package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'plugins/tracked/package-lock.json'), REGISTRY_LOCK);
    write(path.join(upstream, 'README.md'), 'v1\n');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', 'v1');
    git(tmp, 'clone', '-q', upstream, path.join(home, 'plugins', 'bootstrap'));
    for (const dir of ['.', 'plugins/changed', 'plugins/unchanged', 'plugins/deleted', 'plugins/gitdep']) {
      fs.mkdirSync(path.join(home, 'plugins', 'bootstrap', dir, 'node_modules'), { recursive: true });
    }
  });

  afterEach(() => {
    delete process.env.GIT_CONFIG_NOSYSTEM;
  });

  it('runs npm ci --ignore-scripts in each changed lockfile dir and nowhere else', async () => {
    write(path.join(upstream, 'package-lock.json'), REGISTRY_LOCK + '\n');
    write(path.join(upstream, 'plugins/changed/package-lock.json'), REGISTRY_LOCK + '\n');
    fs.rmSync(path.join(upstream, 'plugins/deleted/package-lock.json'));
    write(path.join(upstream, 'plugins/gitdep/package-lock.json'), GIT_DEP_LOCK);
    write(path.join(upstream, 'plugins/never-installed/package-lock.json'), REGISTRY_LOCK + '\n');
    write(path.join(upstream, 'plugins/tracked/package-lock.json'), REGISTRY_LOCK + '\n');
    write(path.join(upstream, 'plugins/tracked/node_modules/planted.js'), '');
    write(path.join(upstream, 'plugins/unchanged/package.json'), '{}');
    write(path.join(upstream, 'plugins/new/package-lock.json.bak'), REGISTRY_LOCK);
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', 'v2');
    write(path.join(upstream, 'README.md'), 'v3\n');
    git(upstream, 'add', '-A');
    git(upstream, 'commit', '-q', '-m', 'v3');

    const results = await runPluginUpdates();

    expect(results).toEqual([{ plugin: 'bootstrap', changed: true }]);
    expect(npmCalls().sort()).toEqual([
      'bootstrap ci --ignore-scripts --prefix bootstrap',
      'bootstrap/plugins/changed ci --ignore-scripts --prefix bootstrap/plugins/changed',
    ]);
    expect(log.info).toHaveBeenCalledWith('Plugin dependencies installed', {
      plugin: 'bootstrap',
      dir: 'plugins/changed',
      command: `npm ci --ignore-scripts --prefix ${home}/plugins/bootstrap/plugins/changed`,
    });
    expect(log.info).toHaveBeenCalledWith('Plugin dependencies installed', {
      plugin: 'bootstrap',
      dir: '.',
      command: `npm ci --ignore-scripts --prefix ${home}/plugins/bootstrap`,
    });
    expect(log.info).toHaveBeenCalledWith('Plugin lockfile changed; no existing install to refresh', {
      plugin: 'bootstrap',
      dir: 'plugins/never-installed',
    });
    expect(log.info).toHaveBeenCalledWith('Plugin lockfile changed; no existing install to refresh', {
      plugin: 'bootstrap',
      dir: 'plugins/tracked',
    });
    expect(vi.mocked(log.warn).mock.calls).toEqual([
      [
        'Plugin dependency install refused',
        expect.objectContaining({
          plugin: 'bootstrap',
          dir: 'plugins/gitdep',
          reason: expect.stringContaining('node_modules/evil'),
        }),
      ],
    ]);
  });

  it('runs nothing when the pull brings no commits', async () => {
    const results = await runPluginUpdates();

    expect(results).toEqual([{ plugin: 'bootstrap', changed: false }]);
    expect(npmCalls()).toEqual([]);
  });

  it('runs nothing when the pulled range touches no lockfile', async () => {
    write(path.join(upstream, 'README.md'), 'v2\n');
    git(upstream, 'commit', '-q', '-am', 'v2');

    const results = await runPluginUpdates();

    expect(results).toEqual([{ plugin: 'bootstrap', changed: true }]);
    expect(npmCalls()).toEqual([]);
  });
});

describe('with fake git: failures stay inside their plugin', () => {
  function fakePlugin(name: string, state: Record<string, string>, lockfiles: Record<string, string> = {}): string {
    const dir = path.join(home, 'plugins', name);
    for (const [file, content] of Object.entries(state)) write(path.join(dir, '.git/fake', file), content);
    for (const [file, content] of Object.entries(lockfiles)) {
      write(path.join(dir, file), content);
      fs.mkdirSync(path.join(dir, path.dirname(file), 'node_modules'), { recursive: true });
    }
    return dir;
  }

  beforeEach(() => {
    writeExecutable(path.join(tmp, 'bin', 'git'), FAKE_GIT);
  });

  describe('host installs', () => {
    let claudeState: string;
    const listInstalled = (rows: unknown[]) => write(path.join(claudeState, 'list.json'), JSON.stringify(rows));
    const behindCheckout = (id: string) => ({
      id,
      scope: 'user',
      version: '3.3.1',
      readFromFolder: path.join(home, 'plugins/bootstrap/plugins', id),
      folderVersion: '3.5.0',
    });
    const claudeCalls = () => fs.readFileSync(path.join(claudeState, 'calls'), 'utf-8').trim().split('\n');

    beforeEach(() => {
      claudeState = path.join(tmp, 'claude-state');
      fs.mkdirSync(claudeState);
      process.env.FAKE_CLAUDE_STATE = claudeState;
      writeExecutable(path.join(tmp, 'bin', 'claude'), FAKE_CLAUDE);
      fakePlugin('bootstrap', { unchanged: '' });
    });

    afterEach(() => {
      delete process.env.FAKE_CLAUDE_STATE;
    });

    it('updates an install behind its checkout even when no pull moved, and nothing it does not own', async () => {
      listInstalled([
        behindCheckout('orchestrate'),
        { ...behindCheckout('current'), folderVersion: '3.3.1' },
        { id: 'third-party', scope: 'user', version: '1.0.0' },
        { ...behindCheckout('project-install'), scope: 'project' },
        { ...behindCheckout('elsewhere'), readFromFolder: path.join(tmp, 'elsewhere') },
      ]);

      const results = await runPluginUpdates();

      expect(claudeCalls()).toEqual(['plugin list --json', 'plugin update orchestrate --scope user --json']);
      expect(results).toEqual([
        { plugin: 'bootstrap', changed: false },
        { plugin: 'orchestrate', changed: true },
        { plugin: 'current', changed: false },
      ]);
    });

    it.each([
      ['the CLI fails', () => write(path.join(claudeState, 'list-fails'), 'boom\n')],
      ['the output is not JSON', () => write(path.join(claudeState, 'list.json'), 'Plugins:\n')],
      ['the output is not a list', () => write(path.join(claudeState, 'list.json'), '{"plugins":[]}')],
    ])('reports an unreadable plugin list when %s, not an empty one', async (_name, breakList) => {
      breakList();

      expect(await runPluginUpdates()).toEqual([
        { plugin: 'bootstrap', changed: false },
        { plugin: 'claude plugin list', changed: false, error: expect.any(String) },
      ]);
    });

    it('reports an update that exits 0 without saying it updated', async () => {
      listInstalled([behindCheckout('orchestrate')]);
      write(path.join(claudeState, 'update-unknown'), '{"updateOutcome":"pending","message":"Confirm the command"}');

      expect(await runPluginUpdates()).toContainEqual({
        plugin: 'orchestrate',
        changed: false,
        error: 'Confirm the command',
      });
    });

    it('reports a refused update by the reason on stdout, once, and its recovery when the install catches up', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      process.env.PLUGIN_UPDATE_NOTIFY_JID = 'slack:C123';
      listInstalled([behindCheckout('orchestrate')]);
      write(
        path.join(claudeState, 'update-refused'),
        '{"command":"update","outcome":"failed","message":"Plugin \\"orchestrate\\" not found","failureCode":"not_found"}',
      );
      const runs = () =>
        vi.mocked(log.info).mock.calls.filter(([msg]) => msg === 'Plugin updater: run complete').length;
      const nextRun = async (after: number) => {
        const before = runs();
        await vi.advanceTimersByTimeAsync(after);
        await vi.waitFor(() => expect(runs()).toBe(before + 1));
      };
      const notify = vi.fn(async () => {});

      try {
        startPluginUpdater({ notify });
        await nextRun(5 * 60 * 1000);
        await nextRun(60 * 60 * 1000);
        listInstalled([{ ...behindCheckout('orchestrate'), version: '3.5.0' }]);
        await nextRun(60 * 60 * 1000);
      } finally {
        stopPluginUpdater();
        vi.useRealTimers();
      }

      expect(notify.mock.calls).toEqual([
        [
          'slack:C123',
          'Plugin update failing (it will not auto-update until fixed):\n- orchestrate: Plugin "orchestrate" not found',
        ],
        ['slack:C123', 'Plugin update recovered: orchestrate'],
      ]);
    });
  });

  it('a failing npm ci warns and does not stop other plugins or their installs', async () => {
    const broken = fakePlugin(
      'broken',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' },
      { 'package-lock.json': REGISTRY_LOCK },
    );
    write(path.join(broken, '.npm-fails'), '');
    fakePlugin(
      'healthy',
      { 'upstream-moved': '', 'diff-out': 'sub/package-lock.json\n' },
      { 'sub/package-lock.json': REGISTRY_LOCK },
    );

    const results = await runPluginUpdates();

    expect(results.sort((a, b) => a.plugin.localeCompare(b.plugin))).toEqual([
      { plugin: 'broken', changed: true },
      { plugin: 'healthy', changed: true },
    ]);
    expect(npmCalls().sort()).toEqual([
      'broken ci --ignore-scripts --prefix broken',
      'healthy/sub ci --ignore-scripts --prefix healthy/sub',
    ]);
    expect(log.warn).toHaveBeenCalledWith(
      'Plugin dependency install failed',
      expect.objectContaining({
        plugin: 'broken',
        dir: '.',
        command: `npm ci --ignore-scripts --prefix ${home}/plugins/broken`,
      }),
    );
  });

  it('a failing lockfile diff warns and installs nothing for that plugin', async () => {
    fakePlugin('p', { 'upstream-moved': '', 'diff-fails': '' }, { 'package-lock.json': REGISTRY_LOCK });

    const results = await runPluginUpdates();

    expect(results).toEqual([{ plugin: 'p', changed: true }]);
    expect(npmCalls()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Plugin lockfile diff failed; skipping dependency install',
      expect.objectContaining({ plugin: 'p' }),
    );
  });

  it('a failing install-provenance check warns and installs nothing for that lockfile', async () => {
    fakePlugin(
      'p',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n', 'ls-tree-fails': '' },
      { 'package-lock.json': REGISTRY_LOCK },
    );

    const results = await runPluginUpdates();

    expect(results).toEqual([{ plugin: 'p', changed: true }]);
    expect(npmCalls()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Plugin dependency install failed',
      expect.objectContaining({ plugin: 'p', err: expect.stringContaining('ls-tree boom') }),
    );
  });

  it('pulls without the gateway proxy the daemon runs behind', async () => {
    for (const key of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']) {
      process.env[key] = 'http://x:token@127.0.0.1:10255';
    }
    const dir = fakePlugin('p', { pulls: '' });

    await runPluginUpdates();

    expect(fs.readFileSync(path.join(dir, '.git/fake/pulls'), 'utf-8')).toBe('pull \n');
  });

  describe('failure notices', () => {
    const FAILING = 'Plugin update failing (it will not auto-update until fixed):';
    const completedRuns = () =>
      vi.mocked(log.info).mock.calls.filter(([msg]) => msg === 'Plugin updater: run complete').length;
    const nextRun = async (after: number) => {
      const before = completedRuns();
      await vi.advanceTimersByTimeAsync(after);
      await vi.waitFor(() => expect(completedRuns()).toBe(before + 1));
    };

    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
      process.env.PLUGIN_UPDATE_NOTIFY_JID = 'slack:C123';
    });

    afterEach(() => {
      stopPluginUpdater();
      vi.useRealTimers();
    });

    it('reports a failing plugin once, again when its reason changes, and when it recovers', async () => {
      const dir = fakePlugin('down', {
        'pull-fails':
          'Command failed: git pull --ff-only\nFrom https://example.com/down\n * branch main -> FETCH_HEAD\nfatal: Authentication failed for repo\n',
      });
      const notify = vi.fn(async () => {});
      startPluginUpdater({ notify });

      await nextRun(5 * 60 * 1000);
      await nextRun(60 * 60 * 1000);
      write(path.join(dir, '.git/fake/pull-fails'), 'You are not currently on a branch.\n');
      await nextRun(60 * 60 * 1000);
      fs.rmSync(path.join(dir, '.git/fake/pull-fails'));
      await nextRun(60 * 60 * 1000);

      expect(notify.mock.calls).toEqual([
        ['slack:C123', `${FAILING}\n- down: fatal: Authentication failed for repo`],
        ['slack:C123', `${FAILING}\n- down: You are not currently on a branch.`],
        ['slack:C123', 'Plugin update recovered: down'],
      ]);
    });

    it('re-sends a notice that failed to deliver, and a plugin the scan cannot read keeps its report', async () => {
      const dir = fakePlugin('down', { 'pull-fails': 'fatal: Authentication failed for repo\n' });
      fakePlugin('up', { pulls: '' });
      const notify = vi.fn(async () => {});
      notify.mockRejectedValueOnce(new Error('channel down'));
      startPluginUpdater({ notify });

      await nextRun(5 * 60 * 1000);
      await nextRun(60 * 60 * 1000);
      fs.chmodSync(dir, 0o000);
      try {
        await nextRun(60 * 60 * 1000);
      } finally {
        fs.chmodSync(dir, 0o755);
      }
      await nextRun(60 * 60 * 1000);

      const failing = ['slack:C123', `${FAILING}\n- down: fatal: Authentication failed for repo`];
      expect(notify.mock.calls).toEqual([failing, failing]);
      expect(log.warn).toHaveBeenCalledWith('Plugin update notify failed', expect.anything());
    });

    it('skips a tick that lands while the previous run is still delivering its notice', async () => {
      fakePlugin('down', { 'pull-fails': 'fatal: Authentication failed for repo\n' });
      let deliver!: () => void;
      const notify = vi.fn(() => new Promise<void>((resolve) => (deliver = resolve)));
      startPluginUpdater({ notify, notifyTimeoutMs: 2 * 60 * 60 * 1000 });

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(log.info).toHaveBeenCalledWith('Plugin updater: previous run still in progress, skipping');
      deliver();
      await vi.waitFor(() => expect(completedRuns()).toBe(1));
      await nextRun(60 * 60 * 1000);

      expect(notify).toHaveBeenCalledTimes(1);
    });

    it('gives up on a notice that never settles, so the next run is not skipped and re-sends it', async () => {
      fakePlugin('down', { 'pull-fails': 'fatal: Authentication failed for repo\n' });
      const notify = vi.fn(async () => {});
      notify.mockImplementationOnce(() => new Promise<void>(() => {}));
      startPluginUpdater({ notify });

      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await vi.waitFor(() => expect(notify).toHaveBeenCalledTimes(1));
      await nextRun(60 * 1000);
      await nextRun(60 * 60 * 1000);

      expect(notify).toHaveBeenCalledTimes(2);
      expect(notify).toHaveBeenLastCalledWith(
        'slack:C123',
        expect.stringContaining('- down: fatal: Authentication failed'),
      );
      expect(log.warn).toHaveBeenCalledWith('Plugin update notify failed', {
        err: expect.objectContaining({ message: 'notify timed out after 60000ms' }),
      });
    });
  });

  it('a failing pull installs nothing and does not stop other plugins', async () => {
    fakePlugin('down', { 'pull-fails': '', 'diff-out': 'package-lock.json\n' }, { 'package-lock.json': REGISTRY_LOCK });
    fakePlugin(
      'up',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' },
      { 'package-lock.json': REGISTRY_LOCK },
    );

    const results = await runPluginUpdates();

    expect(results.find((r) => r.plugin === 'down')).toMatchObject({ changed: false, error: expect.any(String) });
    expect(results.find((r) => r.plugin === 'up')).toEqual({ plugin: 'up', changed: true });
    expect(npmCalls()).toEqual(['up ci --ignore-scripts --prefix up']);
  });

  const lockWith = (entry: Record<string, unknown>) =>
    JSON.stringify({ lockfileVersion: 3, packages: { '': { name: 'p' }, 'node_modules/dep': entry } });

  it.each([
    ['a git URL over https', { version: '1.0.0', resolved: 'https://github.com/o/r.git#abc' }],
    ['a git+ssh URL', { version: '1.0.0', resolved: 'git+ssh://git@example.com/o/r.git#abc' }],
    ['another registry host', { version: '1.0.0', resolved: 'https://registry.example.com/dep/-/dep-1.0.0.tgz' }],
    ['a plain http registry URL', { version: '1.0.0', resolved: 'http://registry.npmjs.org/dep/-/dep-1.0.0.tgz' }],
    ['a relative file path', { version: '1.0.0', resolved: 'file:../dep' }],
    ['no resolved and a non-semver version', { version: 'github:o/r' }],
    ['no resolved and no version', {}],
    ['a link to a local directory', { resolved: '../dep', link: true }],
  ])('refuses a lockfile whose dependency has %s', async (_label, entry) => {
    fakePlugin(
      'p',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' },
      { 'package-lock.json': lockWith(entry) },
    );

    await runPluginUpdates();

    expect(npmCalls()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Plugin dependency install refused',
      expect.objectContaining({ plugin: 'p', reason: expect.stringContaining('node_modules/dep') }),
    );
  });

  it('refuses a lockfile with a workspace package', async () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: { '': { name: 'p' }, 'packages/w': { version: '1.0.0' } },
    });
    fakePlugin('p', { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' }, { 'package-lock.json': lock });

    await runPluginUpdates();

    expect(npmCalls()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Plugin dependency install refused',
      expect.objectContaining({ plugin: 'p', reason: expect.stringContaining('packages/w') }),
    );
  });

  it('skips a directory whose node_modules is a symlink, not an install', async () => {
    const dir = fakePlugin(
      'p',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' },
      { 'package-lock.json': REGISTRY_LOCK },
    );
    fs.rmSync(path.join(dir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'elsewhere'));
    fs.symlinkSync(path.join(tmp, 'elsewhere'), path.join(dir, 'node_modules'));

    await runPluginUpdates();

    expect(npmCalls()).toEqual([]);
    expect(log.info).toHaveBeenCalledWith('Plugin lockfile changed; no existing install to refresh', {
      plugin: 'p',
      dir: '.',
    });
  });

  it('installs a lockfile whose dependency has no resolved but a semver version', async () => {
    fakePlugin(
      'p',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' },
      { 'package-lock.json': lockWith({ version: '1.2.3-beta.1' }) },
    );

    await runPluginUpdates();

    expect(npmCalls()).toEqual(['p ci --ignore-scripts --prefix p']);
  });

  it('refuses a directory whose npm-shrinkwrap.json would take precedence', async () => {
    fakePlugin(
      'p',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' },
      { 'package-lock.json': REGISTRY_LOCK, 'npm-shrinkwrap.json': GIT_DEP_LOCK },
    );

    await runPluginUpdates();

    expect(npmCalls()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Plugin dependency install refused',
      expect.objectContaining({ plugin: 'p', reason: expect.stringContaining('npm-shrinkwrap.json') }),
    );
  });

  it('refuses a lockfile that predates lockfileVersion 2', async () => {
    fakePlugin(
      'old',
      { 'upstream-moved': '', 'diff-out': 'package-lock.json\n' },
      { 'package-lock.json': JSON.stringify({ lockfileVersion: 1, dependencies: {} }) },
    );

    await runPluginUpdates();

    expect(npmCalls()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(
      'Plugin dependency install refused',
      expect.objectContaining({ plugin: 'old', reason: 'lockfile predates lockfileVersion 2' }),
    );
  });
});
