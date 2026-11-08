import { describe, it, expect, beforeEach, afterEach, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  buildOpenCodeConfig,
  buildOpencodeServerEnv,
  commentRulePlugins,
  missingPluginReceipts,
  OPENCODE_PERMISSIONS,
  requiredOpenCodePluginReceipts,
  runtimeConfigKey,
} from './opencode.js';
import { ManagedGitWorktreeGuard } from '../managed-git-guard-opencode.js';
import { MCP_HEADER_ONLY_SECRET_VARS } from './secret-env.js';
import { splitExcludedPlugins } from '../plugin-exclusions.js';
import { CODEX_SHIM_DIR, withCodexShimPath } from '../codex-shim-path.js';

// The guard plugin path buildOpenCodeConfig probes via fs.existsSync. We never
// touch the real filesystem here — every test stubs fs.existsSync so "present"
// and "absent" are controlled, not dependent on the runner's /workspace layout.
const GUARD_PLUGIN = '/workspace/plugins/bootstrap/plugins/workflow/hooks/guards/opencode-guard.ts';
const MANAGED_GIT_GUARD_PLUGIN = '/app/src/managed-git-guard-opencode.ts';

// spyOn the live fs namespace (same object opencode.ts imports) and restore per
// test — mock.restore() does NOT undo mock.module(), so we deliberately avoid
// mock.module and lean on spyOn + mockRestore (B/E mock-hazard guidance).
const spies: Array<{ mockRestore: () => void }> = [];

function stubGuardPresent(present: boolean): void {
  const s = spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => {
    if (String(p) === GUARD_PLUGIN) return present;
    // Other existsSync calls — default to absent so the config build stays
    // hermetic; instructions are not under test here.
    return false;
  });
  spies.push(s);
}

const savedNoProxy = { NO_PROXY: process.env.NO_PROXY, no_proxy: process.env.no_proxy };

beforeEach(() => {
  delete process.env.NO_PROXY;
  delete process.env.no_proxy;
  delete process.env.OPENCODE_ALLOW_UNGUARDED;
  process.env.OPENCODE_MODEL = 'nvidia/test-model';
  delete process.env.OPENCODE_SMALL_MODEL;
  delete process.env.OPENCODE_PROVIDER;
  delete process.env.OPENCODE_EFFORT;
});

afterEach(() => {
  for (const s of spies.splice(0)) s.mockRestore();
  delete process.env.OPENCODE_ALLOW_UNGUARDED;
  for (const [key, value] of Object.entries(savedNoProxy)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('buildOpenCodeConfig — fail-closed guard (F1)', () => {
  it('test_oc_provider_throws_without_guard: throws when the guard plugin file is absent', () => {
    stubGuardPresent(false);
    expect(() => buildOpenCodeConfig({}, {})).toThrow(/guard plugin not found/i);
  });

  it('test_oc_provider_plugin_always_present: returned config always includes both guard plugins', () => {
    stubGuardPresent(true);
    const cfg = buildOpenCodeConfig({}, {}) as { plugin?: unknown; permission?: unknown };
    expect(cfg.plugin).toEqual([MANAGED_GIT_GUARD_PLUGIN, GUARD_PLUGIN]);
    // Sanity: the auto-approve setting the guard is protecting against is present,
    // so the guard's presence is load-bearing, not cosmetic. The permission map
    // replaced the old `'allow'` string shorthand; every executing category is
    // still `allow`, so the guard is exactly as load-bearing as it was.
    expect(cfg.permission).toEqual(OPENCODE_PERMISSIONS);
    for (const [category, action] of Object.entries(OPENCODE_PERMISSIONS)) {
      if (category === 'question') continue;
      expect(action).toBe('allow');
    }
  });

  it('test_oc_provider_denies_question_only: `question` is the ONLY denied category', () => {
    stubGuardPresent(true);
    const cfg = buildOpenCodeConfig({}, {}) as { permission?: Record<string, string> };
    const denied = Object.entries(cfg.permission ?? {})
      .filter(([, action]) => action !== 'allow')
      .map(([category]) => category);
    expect(denied).toEqual(['question']);
    expect(cfg.permission?.question).toBe('deny');
    // The tool-executing categories the destructive-action guard classifies are
    // still allowed at the OpenCode layer, so denials continue to route through
    // the guard plugin's `tool.execute.before` throw rather than through
    // OpenCode's own permission prompt.
    expect(cfg.permission?.bash).toBe('allow');
    expect(cfg.permission?.edit).toBe('allow');
    expect(cfg.permission?.task).toBe('allow');
    expect(cfg.permission?.external_directory).toBe('allow');
  });

  it('test_oc_provider_permission_keys_known_to_opencode: declares only 1.18.x permission categories', () => {
    // Ground truth is opencode 1.18.x's own built-in documentation:
    // "Known permission keys: read, edit, glob, grep, list, bash, task,
    //  external_directory, todowrite, question, webfetch, websearch, lsp,
    //  doom_loop, skill". Verified live against opencode 1.18.18: an UNKNOWN
    //  permission key is tolerated (a config carrying `codesearch` loads fine),
    //  so upstream's extra key is inert here rather than dangerous — but an
    //  invalid ACTION is rejected outright ("Expected PermissionActionConfig,
    //  got \"maybe\"") and takes the whole spawn down, guard included. So the
    //  list is kept to keys with documented meaning in this version: declaring
    //  one OpenCode does not know buys nothing and pre-commits us to whatever
    //  semantics a later version gives it.
    const known = [
      'read',
      'edit',
      'glob',
      'grep',
      'list',
      'bash',
      'task',
      'external_directory',
      'todowrite',
      'question',
      'webfetch',
      'websearch',
      'lsp',
      'doom_loop',
      'skill',
    ];
    expect(Object.keys(OPENCODE_PERMISSIONS).sort()).toEqual([...known].sort());
  });

  it('test_oc_provider_allow_unguarded_optout: OPENCODE_ALLOW_UNGUARDED=1 permits an unguarded spawn (explicit opt-out)', () => {
    stubGuardPresent(false);
    process.env.OPENCODE_ALLOW_UNGUARDED = '1';
    // Does NOT throw — the explicit opt-out bypasses the fail-closed gate.
    expect(() => buildOpenCodeConfig({}, {})).not.toThrow();
  });

  it('negative: no returned config auto-approves tool calls WITHOUT the guard plugin', () => {
    // Sweep both reachable build paths (guard present, and opt-out + absent) and
    // assert the invariant: any config that allows the executing categories must
    // carry the guard plugin. The only way to get auto-approve with no plugin
    // would be a regression that re-introduced a conditional mount.
    stubGuardPresent(true);
    const guarded = buildOpenCodeConfig({}, {}) as { plugin?: unknown; permission?: Record<string, string> };
    expect(guarded.permission?.bash).toBe('allow');
    expect(guarded.plugin).toEqual([MANAGED_GIT_GUARD_PLUGIN, GUARD_PLUGIN]);

    // Reset and exercise the opt-out path.
    for (const s of spies.splice(0)) s.mockRestore();
    stubGuardPresent(false);
    process.env.OPENCODE_ALLOW_UNGUARDED = '1';
    const optout = buildOpenCodeConfig({}, {}) as { plugin?: unknown; permission?: Record<string, string> };
    // Even on the opt-out path the plugin key is unconditionally present (opencode
    // harmlessly ignores a missing plugin path — verified on opencode@1.15.7), so
    // there is no auto-approve-without-plugin config anywhere.
    expect(optout.permission?.bash).toBe('allow');
    expect(optout.plugin).toEqual([MANAGED_GIT_GUARD_PLUGIN, GUARD_PLUGIN]);
  });

  it('gives an anthropic/* model the gateway placeholder key, with effort on the registered model', () => {
    stubGuardPresent(true);
    process.env.OPENCODE_MODEL = 'anthropic/claude-sonnet-4-8';
    process.env.OPENCODE_EFFORT = 'high';

    const cfg = buildOpenCodeConfig({}, {}) as {
      enabled_providers?: string[];
      provider?: Record<string, { options?: Record<string, unknown>; models?: Record<string, { options?: unknown }> }>;
    };

    expect(cfg.provider?.anthropic?.models?.['claude-sonnet-4-8']?.options).toEqual({ reasoningEffort: 'high' });
    expect(cfg.provider?.anthropic?.options).toEqual({ apiKey: 'placeholder' });
    expect(cfg.enabled_providers).toEqual(['anthropic']);
  });

  it('moves a per-turn Anthropic effort override onto the per-turn model, keeping the placeholder', () => {
    stubGuardPresent(true);
    process.env.OPENCODE_MODEL = 'anthropic/claude-sonnet-4-8';
    process.env.OPENCODE_EFFORT = 'low';

    const cfg = buildOpenCodeConfig({}, { model: 'anthropic/claude-opus-4-8', effort: 'max' }) as {
      provider?: Record<string, { options?: Record<string, unknown>; models?: Record<string, { options?: unknown }> }>;
    };

    expect(cfg.provider?.anthropic?.models?.['claude-opus-4-8']?.options).toEqual({ reasoningEffort: 'max' });
    expect(cfg.provider?.anthropic?.models?.['claude-sonnet-4-8']).toBeUndefined();
    expect(cfg.provider?.anthropic?.options).toEqual({ apiKey: 'placeholder' });
  });

  it.each(['NO_PROXY', 'no_proxy'])(
    'refuses an anthropic/* model when %s takes api.anthropic.com off the gateway path',
    (variable) => {
      stubGuardPresent(true);
      process.env[variable] = 'localhost,api.anthropic.com';
      expect(() => buildOpenCodeConfig({}, { model: 'anthropic/claude-opus-4-8' })).toThrow(
        /api\.anthropic\.com is in NO_PROXY/,
      );
      expect(() => buildOpenCodeConfig({}, { model: 'opencode-go/glm-5.3-flash' })).not.toThrow();
    },
  );

  it.each(['opencode-go/glm-5.3-flash', 'opencode/big-pickle', 'nvidia/nemotron'])(
    'routes %s through the gateway: placeholder key, the one enabled provider',
    (model) => {
      stubGuardPresent(true);
      const provider = model.split('/')[0];
      const cfg = buildOpenCodeConfig({}, { model }) as {
        enabled_providers?: string[];
        provider?: Record<string, { options?: Record<string, unknown> }>;
      };
      expect(cfg.provider?.[provider]?.options).toEqual({ apiKey: 'placeholder' });
      expect(cfg.enabled_providers).toEqual([provider]);
    },
  );
});

describe('OpenCode gateway routing', () => {
  it('never takes opencode.ai off the proxy path', () => {
    for (const model of ['opencode-go/glm-5.3-flash', 'opencode/big-pickle']) {
      const env = buildOpencodeServerEnv({ NO_PROXY: 'localhost', no_proxy: '127.0.0.1' }, { model });
      expect(env.NO_PROXY).toBe('localhost');
      expect(env.no_proxy).toBe('127.0.0.1');
    }
  });

  it('respawns when a per-turn model crosses providers, and not within one', () => {
    const goA = runtimeConfigKey({}, undefined, { model: 'opencode-go/glm-5.3-flash' });
    const goB = runtimeConfigKey({}, undefined, { model: 'opencode-go/kimi-k2.7-code' });
    const nvidia = runtimeConfigKey({}, undefined, { model: 'nvidia/nemotron' });

    expect(goB).toBe(goA);
    expect(nvidia).not.toBe(goA);
  });
});

describe('buildOpencodeServerEnv — peer codex rotation shim', () => {
  // The shim lives on the container's skills mount, so this runs only where that mount exists.
  (fs.existsSync(path.join(CODEX_SHIM_DIR, 'codex')) ? it : it.skip)(
    "the agent's shells resolve codex through the rotation shim, and the runner's own env keeps the real one",
    () => {
      const childEnv = buildOpencodeServerEnv({ PATH: '/pnpm:/usr/bin' }, {});
      expect(childEnv.PATH).toBe(`${CODEX_SHIM_DIR}:/pnpm:/usr/bin`);
      expect(process.env.PATH?.split(':')).not.toContain(CODEX_SHIM_DIR);
    },
  );
});

describe('buildOpencodeServerEnv — child env hygiene (F2)', () => {
  // Snapshot/restore the secret keys we set so we never leak into sibling test
  // files (process.env is process-global under `bun test`).
  const SECRET_KEYS = ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_2', 'CLAUDE_CODE_OAUTH_TOKEN', 'GMAIL_OAUTH_PATH'];
  let saved: Record<string, string | undefined>;
  beforeEach(() => {
    saved = {};
    for (const k of SECRET_KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of SECRET_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  // Replaces test_oc_child_env_strips_secrets (codex #126 F2/F3). The provider
  // credentials are DELIBERATELY no longer stripped: an OpenCode agent's bash
  // tool and MCP children inherit the credential the container runs on, so
  // `claude -p` works there the way `opencode run` and `codex exec` already did.
  //
  // MUTATION CHECK: re-adding any ANTHROPIC_API_KEY* / CLAUDE_CODE_OAUTH_TOKEN*
  // name to the strip set in buildOpencodeServerEnv fails this test.
  it('test_oc_child_env_keeps_provider_credentials: the container credential reaches opencode children', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-primary';
    process.env.ANTHROPIC_API_KEY_2 = 'sk-ant-fallback';
    process.env.CLAUDE_CODE_OAUTH_TOKEN = 'oauth-tok';
    process.env.GMAIL_OAUTH_PATH = '/secret/gmail-oauth.json';

    const childEnv = buildOpencodeServerEnv(process.env, { permission: 'allow' });
    expect(childEnv.ANTHROPIC_API_KEY).toBe('sk-ant-primary');
    expect(childEnv.ANTHROPIC_API_KEY_2).toBe('sk-ant-fallback');
    expect(childEnv.CLAUDE_CODE_OAUTH_TOKEN).toBe('oauth-tok');
    expect(childEnv.GMAIL_OAUTH_PATH).toBe('/secret/gmail-oauth.json');
  });

  it('test_oc_child_env_preserves_nonsecret: non-secret env (PATH, HOME, NANOCLAW_*, OPENCODE_*) preserved + config injected', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin:/bin',
      HOME: '/home/agent',
      NANOCLAW_IS_MAIN: '1',
      OPENCODE_MODEL: 'anthropic/claude-opus-4-8',
      ANTHROPIC_API_KEY: 'sk-ant-keep-me',
    };
    const config = { permission: 'allow', model: 'anthropic/claude-opus-4-8' };
    const childEnv = buildOpencodeServerEnv(base, config);

    // Kept, behind the peer codex rotation shim where the skills mount provides it.
    expect(childEnv.PATH).toBe(withCodexShimPath('/usr/bin:/bin'));
    expect(childEnv.PATH?.endsWith('/usr/bin:/bin')).toBe(true);
    expect(childEnv.HOME).toBe('/home/agent');
    expect(childEnv.NANOCLAW_IS_MAIN).toBe('1');
    expect(childEnv.OPENCODE_MODEL).toBe('anthropic/claude-opus-4-8');
    // The serialized config is always injected for the child to read.
    expect(childEnv.OPENCODE_CONFIG_CONTENT).toBe(JSON.stringify(config));
    // buildOpencodeServerEnv reads only `base`, never process.env, and no longer
    // removes the provider credential from it.
    expect(childEnv.ANTHROPIC_API_KEY).toBe('sk-ant-keep-me');
  });

  it('test_oc_child_env_strips_mcp_header_secrets (codex #126): EXA/BRAINTRUST/GRANOLA stripped; data-tool secrets + proxy/CA/XDG kept', () => {
    const base: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/agent',
      // MCP / header-only secrets — must be stripped (parity with Claude filterSdkEnv).
      EXA_API_KEY: 'exa-secret',
      BRAINTRUST_API_KEY: 'bt-secret',
      GRANOLA_ACCESS_TOKEN: 'granola-secret',
      // Data-tool secrets bash legitimately consumes — must be KEPT (matches Claude).
      SNOWFLAKE_PASSWORD: 'snow-pw',
      OPENAI_API_KEY: 'oai-key',
      // Proxy / CA / XDG that `opencode serve` + its children need — must be KEPT.
      HTTPS_PROXY: 'http://127.0.0.1:10254',
      NO_PROXY: 'example.com',
      NODE_EXTRA_CA_CERTS: '/etc/ca.pem',
      XDG_DATA_HOME: '/opencode-xdg',
    };
    // Premise guard: the names we're asserting are actually in the shared list.
    expect(MCP_HEADER_ONLY_SECRET_VARS).toContain('EXA_API_KEY');
    expect(MCP_HEADER_ONLY_SECRET_VARS).toContain('BRAINTRUST_API_KEY');
    expect(MCP_HEADER_ONLY_SECRET_VARS).toContain('GRANOLA_ACCESS_TOKEN');

    const childEnv = buildOpencodeServerEnv(base, { permission: 'allow' });
    for (const v of MCP_HEADER_ONLY_SECRET_VARS) {
      expect(childEnv[v]).toBeUndefined();
    }
    // No over-strip: data-tool secrets + infra vars survive.
    expect(childEnv.SNOWFLAKE_PASSWORD).toBe('snow-pw');
    expect(childEnv.OPENAI_API_KEY).toBe('oai-key');
    expect(childEnv.HTTPS_PROXY).toBe('http://127.0.0.1:10254');
    expect(childEnv.NO_PROXY).toBe('example.com');
    expect(childEnv.NODE_EXTRA_CA_CERTS).toBe('/etc/ca.pem');
    expect(childEnv.XDG_DATA_HOME).toBe('/opencode-xdg');
  });

  it('imports the shared MCP_HEADER_ONLY_SECRET_VARS (no duplication of the list)', () => {
    // Single-source assertion: the strip set IS the shared constant, so the two
    // agree element-for-element. A forked local copy in opencode.ts would drift
    // from this the moment either side changed.
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    for (const v of MCP_HEADER_ONLY_SECRET_VARS) base[v] = `value-of-${v}`;
    const childEnv = buildOpencodeServerEnv(base, { permission: 'allow' });
    const removed = Object.keys(base).filter((k) => childEnv[k] === undefined);
    expect(removed.sort()).toEqual([...MCP_HEADER_ONLY_SECRET_VARS].sort());
  });
});

describe('buildOpenCodeConfig + buildOpencodeServerEnv — combined spawn (F3)', () => {
  beforeEach(() => {
    delete process.env.OPENCODE_ALLOW_UNGUARDED;
    delete process.env.OPENCODE_MODEL;
  });
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    delete process.env.OPENCODE_ALLOW_UNGUARDED;
    delete process.env.OPENCODE_MODEL;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it('F3: combined config for a realistic spawn input — throws on absent, then builds with guard + strips secrets', () => {
    // Realistic spawn shape: a model + an MCP server, the way ensureSharedRuntime
    // calls buildOpenCodeConfig(options, turn) before spawnOpencodeServer.
    const options = {
      mcpServers: {
        nanoclaw: { type: 'stdio' as const, command: 'node', args: ['server.js'] },
      },
    };
    process.env.OPENCODE_MODEL = 'anthropic/claude-opus-4-8';

    // 1) Absent guard → refuse to build.
    stubGuardPresent(false);
    expect(() => buildOpenCodeConfig(options, {})).toThrow(/refusing to spawn an unguarded agent/i);

    // 2) Present guard → full config with the plugin mounted and the MCP wired.
    for (const s of spies.splice(0)) s.mockRestore();
    stubGuardPresent(true);
    const cfg = buildOpenCodeConfig(options, {}) as {
      plugin?: unknown;
      permission?: unknown;
      mcp?: Record<string, unknown>;
      model?: unknown;
    };
    expect(cfg.plugin).toEqual([MANAGED_GIT_GUARD_PLUGIN, GUARD_PLUGIN]);
    expect(cfg.permission).toEqual(OPENCODE_PERMISSIONS);
    expect(cfg.model).toBe('anthropic/claude-opus-4-8');
    expect(cfg.mcp?.nanoclaw).toBeDefined();

    // 3) That same config, when handed to the env builder, yields a child env
    //    free of the MCP header-only secrets but carrying the container's own
    //    provider credential (the end-to-end fail-closed + env-hygiene pair).
    const savedKey = process.env.ANTHROPIC_API_KEY;
    const savedExa = process.env.EXA_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'sk-secret-combined';
    process.env.EXA_API_KEY = 'exa-secret-combined';
    const childEnv = buildOpencodeServerEnv(process.env, cfg);
    expect(childEnv.ANTHROPIC_API_KEY).toBe('sk-secret-combined');
    expect(childEnv.EXA_API_KEY).toBeUndefined();
    if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = savedKey;
    if (savedExa === undefined) delete process.env.EXA_API_KEY;
    else process.env.EXA_API_KEY = savedExa;
  });
});

describe('comment-rule feedback plugin', () => {
  const COMMENT_RULE_PLUGIN = '/workspace/plugins/bootstrap/plugins/comment-rule/hooks/opencode-comment-rule.mjs';

  function stubPresent(paths: string[]): void {
    spies.push(spyOn(fs, 'existsSync').mockImplementation((p: fs.PathLike) => paths.includes(String(p))));
  }

  it('is added after the guards when the plugin is mounted', () => {
    stubPresent([GUARD_PLUGIN, COMMENT_RULE_PLUGIN]);
    const cfg = buildOpenCodeConfig({}, {}) as { plugin?: unknown };
    expect(cfg.plugin).toEqual([MANAGED_GIT_GUARD_PLUGIN, GUARD_PLUGIN, COMMENT_RULE_PLUGIN]);
  });

  it('is left out when it is not mounted or the group excludes it', () => {
    stubPresent([GUARD_PLUGIN]);
    expect(commentRulePlugins(splitExcludedPlugins(undefined))).toEqual([]);
    for (const s of spies.splice(0)) s.mockRestore();
    stubPresent([COMMENT_RULE_PLUGIN]);
    expect(commentRulePlugins(splitExcludedPlugins(['bootstrap/plugins/comment-rule']))).toEqual([]);
    expect(commentRulePlugins(splitExcludedPlugins(['bootstrap']))).toEqual([]);
    expect(commentRulePlugins(splitExcludedPlugins(['bootstrap/plugins/wwbd']))).toEqual([COMMENT_RULE_PLUGIN]);
  });
});

describe('a required OpenCode plugin must leave its load receipt', () => {
  it('requires both guards, and the opt-out drops only the destructive-action guard', () => {
    expect(requiredOpenCodePluginReceipts()).toEqual(['managed-git-guard', 'nanoclaw-guard']);
    process.env.OPENCODE_ALLOW_UNGUARDED = '1';
    expect(requiredOpenCodePluginReceipts()).toEqual(['managed-git-guard']);
  });

  it('names each receipt that is missing', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-receipts-'));
    try {
      expect(missingPluginReceipts(dir, ['managed-git-guard', 'nanoclaw-guard'])).toEqual([
        'managed-git-guard',
        'nanoclaw-guard',
      ]);
      fs.writeFileSync(path.join(dir, 'nanoclaw-guard'), 'x');
      expect(missingPluginReceipts(dir, ['managed-git-guard', 'nanoclaw-guard'])).toEqual(['managed-git-guard']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the managed-Git plugin writes its receipt when it builds its hooks', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'oc-receipts-'));
    const saved = process.env.NANOCLAW_OPENCODE_PLUGIN_RECEIPTS;
    process.env.NANOCLAW_OPENCODE_PLUGIN_RECEIPTS = dir;
    try {
      await ManagedGitWorktreeGuard();
      expect(missingPluginReceipts(dir, ['managed-git-guard'])).toEqual([]);
    } finally {
      if (saved === undefined) delete process.env.NANOCLAW_OPENCODE_PLUGIN_RECEIPTS;
      else process.env.NANOCLAW_OPENCODE_PLUGIN_RECEIPTS = saved;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
