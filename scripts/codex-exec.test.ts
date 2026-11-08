import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../src/test-hermeticity.js';

allowSubprocess(['bash']);
enforceHermeticity();

/**
 * The fake prints a failed turn the way codex-cli 0.163.0 does (`ERROR: <message>`
 * on stderr, exit 1), or under --json as a `turn.failed` event on stdout, and
 * writes the rollout a non-ephemeral run leaves.
 */

const SCRIPT = path.resolve('container/skills/pr-review-loop/scripts/codex-exec.sh');
const SHIM_DIR = path.resolve('container/skills/pr-review-loop/scripts/codex-bin');
const LIMIT =
  "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 8th, 2026 12:42 AM.";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const FAKE_CODEX = `#!/usr/bin/env bash
if [ "$1" = app-server ]; then
  case " $* " in
    *" --listen "*) ;;
    *) printf '%s\\t%s\\n' "\${CODEX_HOME-<unset>}" "$*" >>"$FAKE_APP_LOG"; exit 0 ;;
  esac
  [ -e "$CODEX_HOME/hooks-list-unavailable" ] && exit 1
  while IFS= read -r line; do
    id=$(printf '%s' "$line" | sed -E 's/.*"id":([0-9]+).*/\\1/')
    case "$line" in
      *'"method":"initialize"'*) echo '{"jsonrpc":"2.0","id":1,"result":{}}' ;;
      *'"method":"hooks/list"'*)
        list="$CODEX_HOME/hooks-list.json"
        on=0
        for arg in "$@"; do case "$arg" in *features.hooks=true) on=1 ;; *features.hooks=false) on=0 ;; esac; done
        [ "$on" = 1 ] && [ -e "$CODEX_HOME/hooks-list.enabled.json" ] && list="$CODEX_HOME/hooks-list.enabled.json"
        printf '{"jsonrpc":"2.0","id":%s,"result":{"data":[{"hooks":%s}]}}\n' "$id" "$(cat "$list" 2>/dev/null || echo '[]')" ;;
      *'"method":"config/batchWrite"'*)
        printf '%s\n' "$line" >>"$CODEX_HOME/batch-writes.log"
        node -e 'const fs = require("fs"); const [file, req] = process.argv.slice(1); const trust = JSON.parse(req).params.edits[0].value; const rows = JSON.parse(fs.readFileSync(file, "utf8")); for (const row of rows) if (trust[row.key] && trust[row.key].trusted_hash === row.currentHash) row.trustStatus = "trusted"; fs.writeFileSync(file, JSON.stringify(rows));' "$CODEX_HOME/hooks-list.json" "$line"
        printf '{"jsonrpc":"2.0","id":%s,"result":{"status":"ok"}}\n' "$id" ;;
    esac
  done
  exit 0
fi
stdin=$(cat)
if [ -n "\${FAKE_HANG:-}" ]; then echo $$ >"$FAKE_HANG"; exec sleep 30; fi
printf '%s\\t%s\\t%s\\n' "$CODEX_HOME" "$*" "$stdin" >>"$FAKE_LOG"
echo "user" >&2
echo "\${FAKE_ECHO:-review this}" >&2
json=0
case " $* " in *" --json "*) json=1 ;; esac
acted=0
case ":$FAKE_ACTED:" in *":$CODEX_HOME:"*) acted=1 ;; esac
id=$(printf '0000aaaa-0000-0000-0000-%012d' "$$$RANDOM")
case " $* " in
  *" --json "*) printf '{"type":"thread.started","thread_id":"%s"}\\n' "$id" ;;
  *" --color "*) printf '\\033[1msession id:\\033[0m %s\\n' "$id" >&2 ;;
  *) echo "session id: $id" >&2 ;;
esac
case " $* " in
  *" --ephemeral "*) ;;
  *)
    mkdir -p "$CODEX_HOME/sessions/2026/11/04"
    rollout="$CODEX_HOME/sessions/2026/11/04/rollout-2026-11-04T00-00-00-$id.jsonl"
    if [ -n "\${FAKE_STRAY:-}" ]; then
      echo '{"timestamp":"t","type":"response_item","payload":{"type":"message"}}' >"$CODEX_HOME/sessions/2026/11/04/rollout-2026-11-04T00-00-09-stray.jsonl"
      rollout=/dev/null
    fi
    {
      printf '{"timestamp":"t","type":"session_meta","payload":{"id":"%s","session_id":"%s"}}\\n' "$id" "$id"
      echo '{"timestamp":"t","type":"response_item","payload":{"type":"message","role":"developer","content":[]}}'
      echo '{"timestamp":"t","type":"response_item","payload":{"type":"message","role":"user","content":[]}}'
      echo '{"timestamp":"t","type":"event_msg","payload":{"type":"task_started"}}'
      echo '{"timestamp":"t","type":"turn_context","payload":{"cwd":"/w"}}'
    } >"$rollout"
    acted_line="\${FAKE_ROLLOUT_RAW:-}"
    [ -n "$acted_line" ] || acted_line='{"timestamp":"t","type":"response_item","payload":{"type":"'"\${FAKE_ROLLOUT_TYPE:-function_call}"'"}}'
    if [ "$acted" = 1 ] && [ -n "\${FAKE_CHILD:-}" ]; then
      child="$CODEX_HOME/sessions/2026/11/04/rollout-2026-11-04T00-00-01-0000cccc-0000-0000-0000-000000000002.jsonl"
      printf '{"timestamp":"t","type":"session_meta","payload":{"id":"0000cccc-0000-0000-0000-000000000002","session_id":"%s"}}\\n' "$id" >"$child"
      echo "$acted_line" >>"$child"
    elif [ "$acted" = 1 ]; then
      echo "$acted_line" >>"$rollout"
    fi
    if [ -n "\${FAKE_NEIGHBOUR:-}" ]; then
      neighbour="$CODEX_HOME/sessions/2026/11/04/rollout-2026-11-04T00-00-00-0000bbbb-0000-0000-0000-000000000001.jsonl"
      echo '{"timestamp":"t","type":"session_meta","payload":{"id":"0000bbbb-0000-0000-0000-000000000001","session_id":"0000bbbb-0000-0000-0000-000000000001"}}' >"$neighbour"
      echo "$acted_line" >>"$neighbour"
    fi ;;
esac
if [ "$json" = 1 ] && [ "$acted" = 1 ] && [ -z "\${FAKE_SILENT_JSON:-}" ]; then
  for event in started completed; do
    printf '{"type":"item.%s","item":{"id":"item_1","type":"command_execution"}}\\n' "$event"
  done
fi
case ":$FAKE_LIMITED:" in
  *":$CODEX_HOME:"*)
    case " $* " in
      *" --json "*)
        echo '{"type":"item.completed","item":{"id":"item_0","type":"error","message":"Model metadata not found"}}'
        printf '{"type":"turn.failed","error":{"message":"%s"}}\\n' "$FAKE_LIMIT_MESSAGE" ;;
      *" --color "*) printf '\\033[31mERROR:\\033[0m %s\\n' "$FAKE_LIMIT_MESSAGE" >&2 ;;
      *) echo "ERROR: $FAKE_LIMIT_MESSAGE" >&2 ;;
    esac
    exit 1 ;;
esac
case ":$FAKE_BROKEN:" in
  *":$CODEX_HOME:"*)
    if [ "$json" = 1 ]; then
      printf '{"type":"item.completed","item":{"type":"agent_message","text":"%s"}}\\n' "\${FAKE_ECHO:-}"
      echo '{"type":"turn.failed","error":{"message":"The model is not supported"}}'
    else
      echo "ERROR: The model is not supported" >&2
    fi
    exit 1 ;;
esac
echo "verdict from $CODEX_HOME"
`;

function otherShim(ctx: { root: string }) {
  const dir = path.join(ctx.root, 'other-checkout', 'codex-bin');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(path.join(SHIM_DIR, 'codex'), path.join(dir, 'codex'));
  fs.chmodSync(path.join(dir, 'codex'), 0o755);
  return dir;
}

function setup(homes: string[]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-exec-'));
  roots.push(root);
  const bin = path.join(root, 'bin');
  const home = path.join(root, 'home');
  fs.mkdirSync(bin);
  fs.mkdirSync(home);
  fs.writeFileSync(path.join(bin, 'codex'), FAKE_CODEX, { mode: 0o755 });
  for (const name of homes) {
    fs.mkdirSync(path.join(home, name));
    fs.writeFileSync(path.join(home, name, 'auth.json'), '{}');
  }
  return { root, bin, home, log: path.join(root, 'calls.tsv'), appLog: path.join(root, 'app-server.tsv') };
}

function run(
  ctx: ReturnType<typeof setup>,
  args: string[],
  env: {
    limited?: string[];
    broken?: string[];
    acted?: string[];
    neighbour?: boolean;
    child?: boolean;
    rolloutRaw?: string;
    silentJson?: boolean;
    stray?: boolean;
    limitMessage?: string;
    rolloutType?: string;
    codexHome?: string;
    echo?: string;
    locale?: string;
    viaShim?: boolean;
    shimOnPath?: boolean;
    closeStdin?: boolean;
    pathPrefix?: string[];
    realBin?: string;
    stdin?: string;
    extraEnv?: Record<string, string>;
  } = {},
) {
  const at = (name: string) => path.join(ctx.home, name);
  const pathDirs = [ctx.bin, path.dirname(process.execPath), '/usr/bin', '/bin'];
  const shimCall = env.closeStdin ? 'codex "$@" <&-' : 'codex "$@"';
  const argv = env.viaShim ? ['-c', shimCall, 'codex', ...args] : [SCRIPT, ...args];
  const result = spawnSync('bash', argv, {
    cwd: ctx.root,
    encoding: 'utf8',
    timeout: 30_000,
    input: env.stdin,
    env: {
      PATH: (env.viaShim || env.shimOnPath ? [SHIM_DIR, ...(env.pathPrefix ?? []), ...pathDirs] : pathDirs).join(':'),
      ...(env.realBin ? { CODEX_REAL_BIN: env.realBin } : {}),
      HOME: ctx.home,
      FAKE_LOG: ctx.log,
      FAKE_APP_LOG: ctx.appLog,
      FAKE_LIMIT_MESSAGE: env.limitMessage ?? LIMIT,
      FAKE_LIMITED: (env.limited ?? []).map(at).join(':'),
      FAKE_BROKEN: (env.broken ?? []).map(at).join(':'),
      FAKE_ACTED: (env.acted ?? []).map(at).join(':'),
      ...(env.neighbour ? { FAKE_NEIGHBOUR: '1' } : {}),
      ...(env.child ? { FAKE_CHILD: '1' } : {}),
      ...(env.rolloutRaw ? { FAKE_ROLLOUT_RAW: env.rolloutRaw } : {}),
      ...(env.silentJson ? { FAKE_SILENT_JSON: '1' } : {}),
      ...(env.stray ? { FAKE_STRAY: '1' } : {}),
      ...(env.rolloutType ? { FAKE_ROLLOUT_TYPE: env.rolloutType } : {}),
      ...(env.codexHome ? { CODEX_HOME: at(env.codexHome) } : {}),
      ...(env.echo ? { FAKE_ECHO: env.echo } : {}),
      ...(env.locale ? { LC_ALL: env.locale } : {}),
      ...env.extraEnv,
    },
  });
  const calls = fs.existsSync(ctx.log)
    ? fs
        .readFileSync(ctx.log, 'utf8')
        .replace(/\n$/, '')
        .split('\n')
        .map((line) => {
          const [home, argv, stdin] = line.split('\t');
          return { home: path.basename(home), argv, stdin };
        })
    : [];
  const appServers = fs.existsSync(ctx.appLog)
    ? fs
        .readFileSync(ctx.appLog, 'utf8')
        .replace(/\n$/, '')
        .split('\n')
        .map((line) => {
          const [home, argv] = line.split('\t');
          return { home: home === '<unset>' ? home : path.basename(home), argv };
        })
    : [];
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls, appServers };
}

describe('codex-exec.sh', () => {
  it('runs once on the current account when it is not limited', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['-m', 'some-model', 'review this']);
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([{ home: '.codex', argv: 'exec -m some-model review this', stdin: '' }]);
    expect(r.stdout).toBe(`verdict from ${path.join(ctx.home, '.codex')}\n`);
    expect(r.stderr).toContain(`codex-exec: account=${path.join(ctx.home, '.codex')} exit=0`);
  });

  it('reruns exactly once on ~/.codex-secondary after a usage limit, and prints only that verdict', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['-m', 'some-model', 'review this'], { limited: ['.codex'] });
    expect(r.status).toBe(0);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
    expect(r.calls[1].argv).toBe('exec -m some-model review this');
    expect(r.stdout).toBe(`verdict from ${path.join(ctx.home, '.codex-secondary')}\n`);
    expect(r.stderr).toContain(`rerunning once with CODEX_HOME=${path.join(ctx.home, '.codex-secondary')}`);
    expect(r.stderr).toContain(`codex-exec: account=${path.join(ctx.home, '.codex-secondary')} exit=0`);
  });

  it('exits 13 after the second account is limited too, without a third attempt', () => {
    const ctx = setup(['.codex', '.codex-fallback-1', '.codex-secondary']);
    const r = run(ctx, ['review this'], { limited: ['.codex', '.codex-fallback-1', '.codex-secondary'] });
    expect(r.status).toBe(13);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-fallback-1']);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('are both at their Codex usage limit');
  });

  it("takes a container's staged fallbacks in order before ~/.codex-secondary, and skips the current home", () => {
    const ctx = setup(['.codex-fallback-1', '.codex-fallback-2', '.codex-secondary']);
    const r = run(ctx, ['review this'], { codexHome: '.codex-fallback-1', limited: ['.codex-fallback-1'] });
    expect(r.status).toBe(0);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex-fallback-1', '.codex-fallback-2']);
  });

  it('skips a fallback home with no auth.json', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    fs.mkdirSync(path.join(ctx.home, '.codex-fallback-1'));
    const r = run(ctx, ['review this'], { limited: ['.codex'] });
    expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
  });

  it('exits 13 and says so when no fallback account exists', () => {
    const ctx = setup(['.codex']);
    const r = run(ctx, ['review this'], { limited: ['.codex'] });
    expect(r.status).toBe(13);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
    expect(r.stderr).toContain('no fallback account has an auth.json');
  });

  describe('from a home whose hooks codex dispatches', () => {
    type Hook = { source: string; key: string; enabled: boolean; trustStatus: string; currentHash: string };
    function hooks(ctx: ReturnType<typeof setup>, name: string, change: (rows: Hook[]) => Hook[] = (rows) => rows) {
      const own = path.join(fs.realpathSync(path.join(ctx.home, name)), 'hooks.json');
      const rows: Hook[] = [
        {
          source: 'user',
          key: `${own}:pre_tool_use:0:0`,
          enabled: true,
          trustStatus: 'trusted',
          currentHash: 'sha256:g',
        },
        {
          source: 'plugin',
          key: 'guard@mkt:hooks/h.json:pre_tool_use:0:0',
          enabled: true,
          trustStatus: 'trusted',
          currentHash: 'sha256:p',
        },
      ];
      fs.writeFileSync(path.join(ctx.home, name, 'hooks-list.json'), JSON.stringify(change(rows)));
    }

    it('trusts under the fallback the very handler the current home trusts, says so, and reruns there', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      hooks(ctx, '.codex');
      hooks(ctx, '.codex-secondary', (rows) =>
        rows.map((h) => (h.source === 'user' ? { ...h, trustStatus: 'untrusted' } : h)),
      );
      const r = run(ctx, ['review this'], { limited: ['.codex'] });
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
      expect(r.stderr).toContain(
        `HOOK TRUST SYNCED: trusted these hooks under ${path.join(ctx.home, '.codex-secondary')}`,
      );
      expect(r.stderr).toMatch(/codex-exec: {3}user\thooks\.json:pre_tool_use:0:0\n/);
      const written = fs.readFileSync(path.join(ctx.home, '.codex-secondary', 'batch-writes.log'), 'utf8');
      expect(Object.keys(JSON.parse(written).params.edits[0].value)).toEqual([
        `${fs.realpathSync(path.join(ctx.home, '.codex-secondary'))}/hooks.json:pre_tool_use:0:0`,
      ]);
    });

    it.each([
      ['a different handler', (h: Hook) => ({ ...h, trustStatus: 'untrusted', currentHash: 'sha256:other' })],
      ['a disabled hook', (h: Hook) => ({ ...h, trustStatus: 'untrusted', enabled: false })],
    ])('never trusts %s under the fallback, and refuses it', (_label, change) => {
      const ctx = setup(['.codex', '.codex-secondary']);
      hooks(ctx, '.codex');
      hooks(ctx, '.codex-secondary', (rows) => rows.map((h) => (h.source === 'user' ? change(h) : h)));
      const r = run(ctx, ['review this'], { limited: ['.codex'] });
      expect(r.status).toBe(13);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
      expect(r.stderr).toContain('HOOK TRUST DRIFT');
      expect(fs.existsSync(path.join(ctx.home, '.codex-secondary', 'batch-writes.log'))).toBe(false);
    });

    it('never trusts under the fallback a hook the current home does not trust', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      hooks(ctx, '.codex', (rows) => rows.map((h) => (h.source === 'plugin' ? { ...h, trustStatus: 'untrusted' } : h)));
      hooks(ctx, '.codex-secondary', (rows) => rows.map((h) => ({ ...h, trustStatus: 'untrusted' })));
      const r = run(ctx, ['review this'], { limited: ['.codex'] });
      expect(r.status).toBe(0);
      const written = fs.readFileSync(path.join(ctx.home, '.codex-secondary', 'batch-writes.log'), 'utf8');
      const keys = Object.keys(JSON.parse(written).params.edits[0].value);
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(/hooks\.json:pre_tool_use:0:0$/);
    });

    it('reruns on a fallback under which codex dispatches the same hooks', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      hooks(ctx, '.codex');
      hooks(ctx, '.codex-secondary');
      const r = run(ctx, ['review this'], { limited: ['.codex'] });
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
    });

    it('matches hooks codex reports under the real path of a symlinked current home', () => {
      const ctx = setup(['.codex-real', '.codex-secondary']);
      fs.symlinkSync(path.join(ctx.home, '.codex-real'), path.join(ctx.home, '.codex'));
      hooks(ctx, '.codex-real');
      hooks(ctx, '.codex-secondary');
      const r = run(ctx, ['review this'], { limited: ['.codex'] });
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
    });

    it('refuses a fallback missing the last of more hooks than one pipe buffer holds', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const many = (name: string, count: number) =>
        hooks(ctx, name, (rows) => [
          ...rows,
          ...Array.from({ length: count }, (_, i) => ({
            ...rows[0],
            key: `${rows[0].key}-${String(i).padStart(5, '0')}`,
          })),
        ]);
      many('.codex', 2000);
      many('.codex-secondary', 1999);
      const r = run(ctx, ['review this'], { limited: ['.codex'] });
      expect(r.status).toBe(13);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
    });

    it('compares hook sets the same way under any locale', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const plugin = (rows: Hook[], id: string) => ({ ...rows[1], key: `${id}@mkt:hooks/h.json:pre_tool_use:0:0` });
      hooks(ctx, '.codex', (rows) => [rows[0], plugin(rows, 'aa-plugin')]);
      hooks(ctx, '.codex-secondary', (rows) => [rows[0], plugin(rows, 'aa-plugin'), plugin(rows, 'a-plugin')]);
      const r = run(ctx, ['review this'], { limited: ['.codex'], locale: 'en_US.utf8' });
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
    });

    it.each([
      ['holds only a credential', () => {}],
      [
        'has hooks disabled',
        (ctx: ReturnType<typeof setup>) =>
          hooks(ctx, '.codex-fallback-1', (rows) => rows.map((h) => ({ ...h, enabled: false }))),
      ],
      [
        'runs a different version of the guard',
        (ctx: ReturnType<typeof setup>) =>
          hooks(ctx, '.codex-fallback-1', (rows) =>
            rows.map((h) => (h.source === 'user' ? { ...h, currentHash: 'sha256:other' } : h)),
          ),
      ],
    ])('refuses a fallback that %s, without running there', (_label, prepare) => {
      const ctx = setup(['.codex-runtime', '.codex-fallback-1']);
      hooks(ctx, '.codex-runtime');
      prepare(ctx);
      const r = run(ctx, ['review this'], { codexHome: '.codex-runtime', limited: ['.codex-runtime'] });
      expect(r.status).toBe(13);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex-runtime']);
      expect(r.stderr).toContain('no fallback account here is confirmed to dispatch every hook');
      expect(r.stderr).toContain(`HOOK TRUST DRIFT: ${path.join(ctx.home, '.codex-fallback-1')} would not run`);
      expect(r.stderr).toMatch(/codex-exec: {3}user\thooks\.json:pre_tool_use:0:0\n/);
    });

    it('--check-fallback names the account a usage limit would move to, without running codex exec', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      hooks(ctx, '.codex');
      hooks(ctx, '.codex-secondary');
      const r = run(ctx, ['--check-fallback']);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe(`${path.join(ctx.home, '.codex-secondary')}\n`);
      expect(r.calls).toEqual([]);
    });

    it('--check-fallback exits 3 and names the drifted hooks when no fallback runs them', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      hooks(ctx, '.codex');
      hooks(ctx, '.codex-secondary', (rows) => rows.filter((h) => h.source !== 'plugin'));
      const r = run(ctx, ['--check-fallback']);
      expect(r.status).toBe(3);
      expect(r.stdout).toBe('');
      expect(r.stderr).toMatch(/codex-exec: {3}plugin\tguard@mkt:hooks\/h\.json:pre_tool_use:0:0\n/);
      expect(r.calls).toEqual([]);
    });
  });

  it.each([
    [['-c', 'features.hooks=true', 'review this']],
    [['-c', 'features.hooks=true', '--', '--config=features.hooks=false']],
  ])("judges the fallback under the invocation's own -c overrides, never prompt text (%j)", (args) => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const guard = [
      {
        source: 'user',
        key: `${path.join(ctx.home, '.codex', 'hooks.json')}:pre_tool_use:0:0`,
        enabled: true,
        trustStatus: 'trusted',
        currentHash: 'sha256:g',
      },
    ];
    fs.writeFileSync(path.join(ctx.home, '.codex', 'hooks-list.enabled.json'), JSON.stringify(guard));
    const r = run(ctx, args, { limited: ['.codex'] });
    expect(r.status).toBe(13);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
  });

  it.each([['-p', 'work'], ['--cd', '/tmp'], ['--dangerously-bypass-hook-trust'], ['-cfeatures.hooks=true']])(
    'does not rotate an invocation whose hooks the check cannot reproduce (%s)',
    (...flags) => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const r = run(ctx, [...flags, 'review this'], { limited: ['.codex'] });
      expect(r.status).toBe(13);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
    },
  );

  it('recognises the current home through a trailing slash and moves to the next fallback', () => {
    const ctx = setup(['.codex-fallback-1', '.codex-fallback-2']);
    const r = run(ctx, ['review this'], { codexHome: '.codex-fallback-1/', limited: ['.codex-fallback-1/'] });
    expect(r.status).toBe(0);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex-fallback-1', '.codex-fallback-2']);
  });

  it.each(['.codex', '.codex-secondary'])(
    'refuses to rerun when codex cannot report the hooks of %s, even with no hooks on either side',
    (unavailable) => {
      const ctx = setup(['.codex', '.codex-secondary']);
      fs.writeFileSync(path.join(ctx.home, unavailable, 'hooks-list-unavailable'), '');
      const r = run(ctx, ['review this'], { limited: ['.codex'] });
      expect(r.status).toBe(13);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
    },
  );

  it('recognises a usage limit printed in color', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['--color', 'always', 'review this'], { limited: ['.codex'] });
    expect(r.status).toBe(0);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
  });

  it("reruns a --json run whose turn.failed event is a usage limit, and prints only the rerun's events", () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['--json', 'review this'], { limited: ['.codex'] });
    expect(r.status).toBe(0);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
    expect(r.stdout).toMatch(
      new RegExp(
        `^\\{"type":"thread\\.started","thread_id":"[0-9a-f-]+"\\}\\nverdict from ${path.join(ctx.home, '.codex-secondary')}\\n$`,
      ),
    );
  });

  it('does not rerun a --json run when the limit sentence is only in an agent message', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['--json', 'review this'], { broken: ['.codex'], echo: LIMIT });
    expect(r.status).toBe(1);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
  });

  it.each([
    ['a --json run', ['--json', 'review this'], {}],
    ['a --json run whose events omit the command', ['--json', 'review this'], { silentJson: true }],
    ['a plain run', ['review this'], {}],
  ])('does not rerun %s that acted before the limit, as its rollout records', (_label, args, extra) => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, args, { limited: ['.codex'], acted: ['.codex'], ...extra });
    expect(r.status).toBe(13);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
    expect(r.stderr).toContain(`${path.join(ctx.home, '.codex')} hit its Codex usage limit mid-run after 1 action(s)`);
  });

  it.each([[['review this']], [['--color', 'always', 'review this']]])(
    'reruns %j when only another run on the same account acted meanwhile',
    (args) => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const r = run(ctx, args, { limited: ['.codex'], neighbour: true });
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
    },
  );

  it.each([
    [['--yolo', 'review this']],
    [['--dangerously-bypass-approvals-and-sandbox', 'review this']],
    [['--ignore-user-config', 'review this']],
  ])('reruns %j, which never adds a hook the check would miss', (args) => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, args, { limited: ['.codex'] });
    expect(r.status).toBe(0);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
  });

  it.each([
    [['review', '--uncommitted']],
    [['review', '--base', 'main', '--title', 'the change']],
    [['review', '--commit=abc123']],
  ])('reruns %j, whose target flags pick a diff and change no hooks', (args) => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, args, { limited: ['.codex'] });
    expect(r.status).toBe(0);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
  });

  it('does not rerun when a child thread of the attempt, such as a review, acted', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['review', 'look at the change'], { limited: ['.codex'], acted: ['.codex'], child: true });
    expect(r.status).toBe(13);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
  });

  it.each([
    ['counts the actions in', { acted: ['.codex'] }, 13, ['.codex']],
    ['reruns a refused attempt from', {}, 0, ['.codex', '.codex-secondary']],
  ])('%s a rollout under a symlinked sessions directory', (_label, extra, status, homes) => {
    const ctx = setup(['.codex', '.codex-secondary']);
    fs.mkdirSync(path.join(ctx.root, 'real-sessions'));
    fs.symlinkSync(path.join(ctx.root, 'real-sessions'), path.join(ctx.home, '.codex', 'sessions'));
    const r = run(ctx, ['review this'], { limited: ['.codex'], ...extra });
    expect(r.status).toBe(status);
    expect(r.calls.map((c) => c.home)).toEqual(homes);
    if (status === 13) expect(r.stderr).toContain('mid-run after 1 action(s)');
  });

  it('does not take a rollout without a session_meta for the attempt whose own rollout is missing', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['review this'], { limited: ['.codex'], stray: true });
    expect(r.status).toBe(13);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
    expect(r.stderr).toContain('mid-run after an unknown number of actions');
  });

  it.each([[['--ephemeral', 'review this']], [['--ephemeral', '--json', 'review this']]])(
    'does not rerun %j, which leaves no rollout to show what it did',
    (args) => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const r = run(ctx, args, { limited: ['.codex'] });
      expect(r.status).toBe(13);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
      expect(r.stderr).toContain('mid-run after an unknown number of actions');
    },
  );

  it('does not rerun when no rollout names the session codex reported', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    fs.mkdirSync(path.join(ctx.home, '.codex', 'sessions'));
    fs.chmodSync(path.join(ctx.home, '.codex', 'sessions'), 0o500);
    try {
      const r = run(ctx, ['review this'], { limited: ['.codex'] });
      expect(r.status).toBe(13);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
      expect(r.stderr).toMatch(/mid-run after an unknown number of actions \([^\n]*\); nothing was rerun/);
    } finally {
      fs.chmodSync(path.join(ctx.home, '.codex', 'sessions'), 0o700);
    }
  });

  it.each([
    ['an MCP call under -s read-only', ['-s', 'read-only', 'review this'], {}],
    ['an entry type codex adds later', ['review this'], { rolloutType: 'some_new_call' }],
    ['an entry type spelled outside snake case', ['review this'], { rolloutType: 'ToolCallV2' }],
    [
      'a call whose arguments look like an inert entry',
      ['--json', 'review this'],
      {
        rolloutRaw:
          '{"timestamp":"t","type":"response_item","payload":{"type":"function_call","arguments":{"type":"message"},"payload":{"type":"reasoning"}}}',
      },
    ],
    ['a line that does not parse', ['review this'], { rolloutRaw: '{"type":"response_item","payload":' }],
  ])('does not rerun after %s', (_label, args, extra) => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, args, { limited: ['.codex'], acted: ['.codex'], ...extra });
    expect(r.status).toBe(13);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
    expect(r.stderr).toContain('mid-run after 1 action(s)');
  });

  it.each([
    ['an agent message', ['--json', 'review this'], { rolloutType: 'agent_message' }],
    ['reasoning', ['review this'], { rolloutType: 'reasoning' }],
    ['a call output', ['review this'], { rolloutType: 'function_call_output' }],
  ])('reruns an attempt whose only record before the limit is %s', (_label, args, extra) => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, args, { limited: ['.codex'], acted: ['.codex'], ...extra });
    expect(r.status).toBe(0);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
  });

  it('stops the codex it runs when it is itself sent SIGTERM', async () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const pidFile = path.join(ctx.root, 'codex.pid');
    const wrapper = spawn('bash', [SCRIPT, 'review this'], {
      cwd: ctx.root,
      stdio: 'ignore',
      env: { PATH: `${ctx.bin}:${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: ctx.home, FAKE_HANG: pidFile },
    });
    const exited = new Promise<number | null>((resolve) => wrapper.on('exit', (code) => resolve(code)));
    const deadline = Date.now() + 10_000;
    while (!fs.existsSync(pidFile) || !fs.readFileSync(pidFile, 'utf8').trim()) {
      if (Date.now() > deadline) throw new Error('fake codex never started');
      await new Promise((r) => setTimeout(r, 25));
    }
    const codexPid = Number(fs.readFileSync(pidFile, 'utf8'));
    wrapper.kill('SIGTERM');
    expect(await exited).toBe(143);
    const alive = () => {
      try {
        process.kill(codexPid, 0);
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') return false;
        throw err;
      }
    };
    const gone = Date.now() + 5000;
    while (alive() && Date.now() < gone) await new Promise((r) => setTimeout(r, 25));
    expect(alive()).toBe(false);
  });

  it('passes any other failure through without a rerun', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['review this'], { broken: ['.codex'] });
    expect(r.status).toBe(1);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
  });

  it('does not rerun when the limit sentence only appears in the echoed prompt', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const r = run(ctx, ['review this'], { broken: ['.codex'], echo: `+ fixture: ${LIMIT}` });
    expect(r.status).toBe(1);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex']);
  });

  it('feeds --prompt-file to every attempt as stdin', () => {
    const ctx = setup(['.codex', '.codex-secondary']);
    const prompt = path.join(ctx.root, 'prompt.md');
    fs.writeFileSync(prompt, 'the whole diff');
    const r = run(ctx, ['--prompt-file', prompt, '--', '-m', 'some-model'], { limited: ['.codex'] });
    expect(r.status).toBe(0);
    expect(r.calls).toEqual([
      { home: '.codex', argv: 'exec -m some-model', stdin: 'the whole diff' },
      { home: '.codex-secondary', argv: 'exec -m some-model', stdin: 'the whole diff' },
    ]);
  });

  describe('through the codex shim on PATH', () => {
    it('sends `codex exec` through the rerun, calling the real binary rather than itself', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const r = run(ctx, ['exec', '-m', 'some-model', 'review this'], { viaShim: true, limited: ['.codex'] });
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => [c.home, c.argv])).toEqual([
        ['.codex', 'exec -m some-model review this'],
        ['.codex-secondary', 'exec -m some-model review this'],
      ]);
      expect(r.stdout).toBe(`verdict from ${path.join(ctx.home, '.codex-secondary')}\n`);
    });

    it('still reruns when a subcommand word is only a flag value', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const r = run(ctx, ['exec', '-m', 'resume', 'review this'], { viaShim: true, limited: ['.codex'] });
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
    });

    it('runs the real binary, not the shim, when the wrapper itself is called with the shim on PATH', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const r = run(ctx, ['review this'], { shimOnPath: true, limited: ['.codex'], broken: ['.codex-secondary'] });
      expect(r.status).toBe(1);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
      expect(r.stderr).toContain(`codex-exec: account=${path.join(ctx.home, '.codex-secondary')} exit=1`);
    });

    // codex 0.163's own two formats: the date appears only when the reset is on a later local day.
    const limitAt = (minutes: number) => {
      const at = new Date(Date.now() + minutes * 60_000);
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const time = `${at.getHours() % 12 || 12}:${String(at.getMinutes()).padStart(2, '0')} ${at.getHours() < 12 ? 'AM' : 'PM'}`;
      const sameDay = at.toDateString() === new Date().toDateString();
      const when = sameDay ? time : `${months[at.getMonth()]} ${at.getDate()}th, ${at.getFullYear()} ${time}`;
      return `You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ${when}.`;
    };
    const markedForMinutes = (ctx: ReturnType<typeof setup>, before: number) => {
      const marks = path.join(ctx.home, '.local', 'state', 'codex-exec', 'exhausted');
      const [mark] = fs.readdirSync(marks);
      return (Number(fs.readFileSync(path.join(marks, mark), 'utf8')) - before) / 60;
    };

    it.each([
      ['a reset two days out', 2 * 24 * 60, 2 * 24 * 60],
      ['a reset past a week', 30 * 24 * 60, 7 * 24 * 60],
      ['a reset already past', -60, 60],
    ])('marks the account until the usage limit message says, for %s', (_label, resetInMinutes, expectMinutes) => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const before = Math.floor(Date.now() / 1000);
      run(ctx, ['exec', 'review this'], { viaShim: true, limited: ['.codex'], limitMessage: limitAt(resetInMinutes) });
      expect(Math.abs(markedForMinutes(ctx, before) - expectMinutes)).toBeLessThan(2);
    });

    const minutesLeftToday = () => {
      const midnight = new Date();
      midnight.setHours(24, 0, 0, 0);
      return Math.floor((midnight.getTime() - Date.now()) / 60_000);
    };

    it.skipIf(minutesLeftToday() < 10)(
      'marks the account until a same-day reset, which codex prints as a time alone',
      () => {
        const ctx = setup(['.codex', '.codex-secondary']);
        const resetIn = Math.min(3 * 60, minutesLeftToday() - 5);
        const message = limitAt(resetIn);
        expect(message).toMatch(/try again at \d{1,2}:\d{2} [AP]M\.$/);
        const before = Math.floor(Date.now() / 1000);
        run(ctx, ['exec', 'review this'], { viaShim: true, limited: ['.codex'], limitMessage: message });
        expect(Math.abs(markedForMinutes(ctx, before) - resetIn)).toBeLessThan(2);
      },
    );

    it.each([[['review this']], [['--json', 'review this']]])(
      'takes the reset from the failure itself, not from an older limit message the prompt quotes (%j)',
      (args) => {
        const ctx = setup(['.codex', '.codex-secondary']);
        const before = Math.floor(Date.now() / 1000);
        run(ctx, ['exec', ...args], {
          viaShim: true,
          limited: ['.codex'],
          limitMessage: limitAt(2 * 60),
          echo: `ERROR: ${limitAt(5 * 24 * 60)}`,
        });
        expect(Math.abs(markedForMinutes(ctx, before) - 2 * 60)).toBeLessThan(2);
      },
    );

    it('starts an app-server on the current account again once its mark has expired', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      run(ctx, ['exec', 'review this'], { viaShim: true, limited: ['.codex'] });
      const marks = path.join(ctx.home, '.local', 'state', 'codex-exec', 'exhausted');
      const [mark] = fs.readdirSync(marks);
      fs.writeFileSync(path.join(marks, mark), `${Math.floor(Date.now() / 1000) - 1}\n`);
      const r = run(ctx, ['app-server'], { viaShim: true });
      expect(r.appServers.at(-1)).toEqual({ home: '<unset>', argv: 'app-server' });
    });

    it('starts an app-server past an exhausted fallback on the next healthy one', () => {
      const ctx = setup(['.codex', '.codex-fallback-1', '.codex-secondary']);
      run(ctx, ['exec', 'review this'], { viaShim: true, limited: ['.codex', '.codex-fallback-1'] });
      const r = run(ctx, ['app-server'], { viaShim: true });
      expect(r.appServers.at(-1)).toEqual({ home: '.codex-secondary', argv: 'app-server' });
    });

    it('runs a passthrough subcommand on the --prompt-file it was given', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const prompt = path.join(ctx.root, 'prompt.md');
      fs.writeFileSync(prompt, 'the whole diff');
      const r = run(ctx, ['--prompt-file', prompt, '--', 'resume', '--last'], { limited: ['.codex'] });
      expect(r.calls).toEqual([{ home: '', argv: 'exec resume --last', stdin: 'the whole diff' }]);
    });

    it('reruns a shimmed exec whose stdin is closed', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const r = run(ctx, ['exec', 'review this'], { viaShim: true, closeStdin: true, limited: ['.codex'] });
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
    });

    it.each([
      [
        'a second checkout of the shim is also on PATH',
        (ctx: ReturnType<typeof setup>) => ({ pathPrefix: [otherShim(ctx)] }),
      ],
      ['CODEX_REAL_BIN names the shim', () => ({ realBin: path.join(SHIM_DIR, 'codex') })],
    ])('finds the real binary when %s', (_label, extra) => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const r = run(ctx, ['exec', 'review this'], { viaShim: true, limited: ['.codex'], ...extra(ctx) });
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => c.home)).toEqual(['.codex', '.codex-secondary']);
    });

    it.each([[['app-server', 'daemon', 'status']], [['app-server', '-c', 'k=v', 'daemon', 'start']]])(
      'leaves %j on the account it was given',
      (args) => {
        const ctx = setup(['.codex', '.codex-secondary']);
        run(ctx, ['exec', 'review this'], { viaShim: true, limited: ['.codex'] });
        const r = run(ctx, args, { viaShim: true });
        expect(r.appServers.at(-1)).toEqual({ home: '<unset>', argv: args.join(' ') });
      },
    );

    it('feeds piped stdin to both attempts', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const r = run(ctx, ['exec', '-'], { viaShim: true, limited: ['.codex'], stdin: 'the whole diff' });
      expect(r.status).toBe(0);
      expect(r.calls.map((c) => [c.home, c.stdin])).toEqual([
        ['.codex', 'the whole diff'],
        ['.codex-secondary', 'the whole diff'],
      ]);
    });

    it.each([
      [['exec', 'resume', '--last']],
      [['exec', 'fork', 'some-thread']],
      [['exec', '-m', 'some-model', 'help']],
      [['exec', '-m', 'some-model', '--help']],
      [['login', 'status']],
    ])('runs %j once, directly, on the account it was given', (args) => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const r = run(ctx, args, { viaShim: true, limited: ['.codex'] });
      expect(r.status).toBe(1);
      expect(r.calls).toEqual([{ home: '', argv: args.join(' '), stdin: '' }]);
    });

    it('starts an app-server on the fallback for an hour after an exec run found the current account limited', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      expect(run(ctx, ['app-server'], { viaShim: true }).appServers).toEqual([{ home: '<unset>', argv: 'app-server' }]);
      run(ctx, ['exec', 'review this'], { viaShim: true, limited: ['.codex'] });
      const r = run(ctx, ['app-server'], { viaShim: true });
      expect(r.appServers.at(-1)).toEqual({ home: '.codex-secondary', argv: 'app-server' });
    });

    it("leaves an app-server on a limited account when the fallback does not dispatch that account's hooks", () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      const guard = [
        {
          source: 'user',
          key: `${path.join(ctx.home, '.codex', 'hooks.json')}:pre_tool_use:0:0`,
          enabled: true,
          trustStatus: 'trusted',
          currentHash: 'sha256:g',
        },
      ];
      fs.writeFileSync(path.join(ctx.home, '.codex', 'hooks-list.json'), JSON.stringify(guard));
      run(ctx, ['exec', 'review this'], { viaShim: true, limited: ['.codex'] });
      const r = run(ctx, ['app-server'], { viaShim: true });
      expect(r.appServers.at(-1)).toEqual({ home: '<unset>', argv: 'app-server' });
    });

    it('keeps an explicit CODEX_HOME for an app-server', () => {
      const ctx = setup(['.codex', '.codex-secondary']);
      run(ctx, ['exec', 'review this'], { viaShim: true, limited: ['.codex'] });
      const r = run(ctx, ['app-server'], { viaShim: true, codexHome: '.codex' });
      expect(r.appServers.at(-1)).toEqual({ home: '.codex', argv: 'app-server' });
    });
  });
});

// The registration command a container defers to the first codex call, faked at its boundary: it records when it
// ran and prints the home it prepared, or fails.
const FAKE_REGISTER = `#!/usr/bin/env bash
echo "start $(date +%s%N)" >>"$FAKE_REGISTER_LOG"
sleep "\${FAKE_REGISTER_SLEEP:-0}"
if [ -n "\${FAKE_REGISTER_FAILS:-}" ]; then echo "codex: refused — plugin add exploded" >&2; exit 1; fi
mkdir -p "$FAKE_REGISTERED_HOME"
echo "end $(date +%s%N)" >>"$FAKE_REGISTER_LOG"
echo "$FAKE_REGISTERED_HOME"
`;

describe('codex plugin registration deferred to the first codex call', () => {
  function lazySetup() {
    const ctx = setup(['.codex-runtime']);
    fs.rmSync(path.join(ctx.home, '.codex-runtime'), { recursive: true });
    fs.writeFileSync(path.join(ctx.bin, 'bun'), '#!/usr/bin/env bash\nexec bash "$@"\n', { mode: 0o755 });
    fs.writeFileSync(path.join(ctx.root, 'register.sh'), FAKE_REGISTER, { mode: 0o755 });
    const registerLog = path.join(ctx.root, 'register.log');
    const extraEnv = {
      NANOCLAW_CODEX_REGISTER: path.join(ctx.root, 'register.sh'),
      CODEX_HOME: '/nonexistent/codex-plugins-register-on-first-codex-call',
      FAKE_REGISTER_LOG: registerLog,
      FAKE_REGISTERED_HOME: path.join(ctx.home, '.codex-runtime'),
    };
    const registrations = () =>
      fs.existsSync(registerLog) ? fs.readFileSync(registerLog, 'utf8').trim().split('\n').filter(Boolean) : [];
    return { ctx, extraEnv, registrations };
  }

  it.each([
    ['codex exec through the shim', ['exec', 'review this'], true],
    ['codex-exec.sh run by path', ['review this'], false],
  ])('%s registers first, then runs codex in the home the registration printed', (_label, args, viaShim) => {
    const { ctx, extraEnv, registrations } = lazySetup();

    const r = run(ctx, args, { viaShim, extraEnv });

    expect(r.status).toBe(0);
    expect(registrations().map((line) => line.split(' ')[0])).toEqual(['start', 'end']);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex-runtime']);
  });

  it.each([
    ['an app-server', ['app-server'], 'appServers'],
    ['any other codex command', ['--version'], 'calls'],
  ] as const)('%s through the shim runs in the registered home', (_label, args, log) => {
    const { ctx, extraEnv, registrations } = lazySetup();

    const r = run(ctx, [...args], { viaShim: true, extraEnv });

    expect(r.status).toBe(0);
    expect(registrations().map((line) => line.split(' ')[0])).toEqual(['start', 'end']);
    expect(r[log].map((c) => c.home)).toEqual(['.codex-runtime']);
  });

  it('runs two concurrent first calls one registration at a time, and both reach codex in the registered home', async () => {
    const { ctx, extraEnv, registrations } = lazySetup();
    const env = {
      PATH: [SHIM_DIR, ctx.bin, path.dirname(process.execPath), '/usr/bin', '/bin'].join(':'),
      HOME: ctx.home,
      FAKE_LOG: ctx.log,
      FAKE_APP_LOG: ctx.appLog,
      FAKE_REGISTER_SLEEP: '0.4',
      ...extraEnv,
    };
    const call = () =>
      new Promise<number | null>((resolve) => {
        const child = spawn('bash', ['-c', 'codex exec "review this" </dev/null'], { cwd: ctx.root, env });
        child.on('close', resolve);
      });

    expect(await Promise.all([call(), call()])).toEqual([0, 0]);

    const events = registrations().map((line) => line.split(' ')[0]);
    expect(events).toEqual(['start', 'end', 'start', 'end']);
    const homes = fs
      .readFileSync(ctx.log, 'utf8')
      .trim()
      .split('\n')
      .map((line) => path.basename(line.split('\t')[0]));
    expect(homes).toEqual(['.codex-runtime', '.codex-runtime']);
  }, 20_000);

  it.each([
    ['codex exec through the shim', ['exec', 'review this'], true],
    ['an app-server through the shim', ['app-server'], true],
    ['any other codex command through the shim', ['--version'], true],
    ['codex-exec.sh run by path', ['review this'], false],
  ])('a failed registration refuses %s: exit 1 and codex never runs', (_label, args, viaShim) => {
    const { ctx, extraEnv } = lazySetup();

    const r = run(ctx, args, { viaShim, extraEnv: { ...extraEnv, FAKE_REGISTER_FAILS: '1' } });

    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.appServers).toEqual([]);
    expect(r.stderr).toContain('plugin add exploded');
    expect(r.stderr).toContain('the deferred Codex plugin registration did not complete');
  });

  it('keeps a CODEX_HOME the caller chose, but runs codex there only after the registration completed', () => {
    const { ctx, extraEnv, registrations } = lazySetup();
    fs.mkdirSync(path.join(ctx.home, '.codex-fallback-1'));

    const r = run(ctx, ['exec', 'review this'], {
      viaShim: true,
      extraEnv: { ...extraEnv, CODEX_HOME: path.join(ctx.home, '.codex-fallback-1') },
    });

    expect(r.status).toBe(0);
    expect(registrations().map((line) => line.split(' ')[0])).toEqual(['start', 'end']);
    expect(r.calls.map((c) => c.home)).toEqual(['.codex-fallback-1']);
  });

  it('refuses a CODEX_HOME the caller chose when the registration fails', () => {
    const { ctx, extraEnv } = lazySetup();
    fs.mkdirSync(path.join(ctx.home, '.codex-fallback-1'));

    const r = run(ctx, ['exec', 'review this'], {
      viaShim: true,
      extraEnv: { ...extraEnv, CODEX_HOME: path.join(ctx.home, '.codex-fallback-1'), FAKE_REGISTER_FAILS: '1' },
    });

    expect(r.status).toBe(1);
    expect(r.calls).toEqual([]);
  });
});
