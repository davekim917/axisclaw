/**
 * Tests for the container-local CODEX_HOME merger.
 *
 * Most coverage targets the pure merge helpers (no filesystem) so the tests
 * run identically on host and inside the container. A small filesystem-
 * integration block runs only inside the container, where /home/node is
 * writable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  buildRuntimeConfigForTest,
  codexRuntimeEnv,
  completeDeferredCodexRegistration,
  planCodexPluginRegistration,
  projectCodexPluginConfigForTest,
  readCodexConfigToml,
  renderMcpServerForTest,
  setupCodexFallbackRuntimes,
  setupCodexPrimaryRuntime,
  setupCodexRuntime,
  stripPluginsAndMarketplacesForTest,
  syncCodexHookTrust,
  verifyCodexHookTrust,
} from './codex-companion-setup.js';
import { type AppServer, parseTomlTableHeader } from './providers/codex-app-server.js';
import { FAILED_CODEX_HOME, PENDING_CODEX_HOME } from './codex-home-sentinel.js';
import { allowSubprocess } from './test-hermeticity.js';

describe('parseTomlTableHeader', () => {
  it('closes on the LAST bracket so a quoted segment may contain one', () => {
    expect(parseTomlTableHeader('[features]')).toBe('features');
    expect(parseTomlTableHeader('  [mcp_servers.nanoclaw.env]  ')).toBe('mcp_servers.nanoclaw.env');
    expect(parseTomlTableHeader('[plugins."github@openai-curated"]')).toBe('plugins."github@openai-curated"');
    expect(parseTomlTableHeader('[mcp_servers."a]b"]')).toBe('mcp_servers."a]b"');
    expect(parseTomlTableHeader('key = "value"')).toBeNull();
    expect(parseTomlTableHeader('')).toBeNull();
  });
});

describe('splitPluginsAndMarketplaces', () => {
  it('strips a plugin table whose quoted name contains a bracket', () => {
    // Containers must carry ZERO host CLI plugin state. A header the scanner
    // fails to recognize leaks the table AND, because the in-block flag goes
    // stale, silently swallows whatever base config follows it.
    const stripped = stripPluginsAndMarketplacesForTest(
      ['[plugins."we]ird@mkt"]', 'enabled = true', '', '[features]', 'hooks = true', ''].join('\n'),
    );
    expect(stripped).not.toContain('we]ird@mkt');
    expect(stripped).not.toContain('enabled = true');
    expect(stripped).toContain('[features]');
    expect(stripped).toContain('hooks = true');
  });
});

describe('renderMcpServer', () => {
  it('emits stdio servers with command + args + env', () => {
    const lines = renderMcpServerForTest('nanoclaw', {
      type: 'stdio',
      command: 'bun',
      args: ['run', '/app/mcp.ts'],
      env: { FOO: 'bar' },
    });
    expect(lines).toEqual([
      '[mcp_servers.nanoclaw]',
      'type = "stdio"',
      'command = "bun"',
      'args = ["run", "/app/mcp.ts"]',
      '[mcp_servers.nanoclaw.env]',
      'FOO = "bar"',
    ]);
  });

  it('omits args+env when empty', () => {
    const lines = renderMcpServerForTest('m', {
      type: 'stdio',
      command: 'x',
      args: [],
      env: {},
    });
    expect(lines).toEqual(['[mcp_servers.m]', 'type = "stdio"', 'command = "x"']);
  });

  it('quotes non-bare names/keys and emits cwd above the env header', () => {
    // Second Codex config.toml writer in the tree, same blast radius as
    // writeCodexMcpConfigToml: one malformed table drops every MCP server.
    const lines = renderMcpServerForTest('acme.tools', {
      type: 'stdio',
      command: 'bun',
      args: ['run', '/app/mcp.ts'],
      env: { 'x.y': 'bar' },
      cwd: '/workspace/plugin-data/acme',
    });
    expect(lines).toEqual([
      '[mcp_servers."acme.tools"]',
      'type = "stdio"',
      'command = "bun"',
      'cwd = "/workspace/plugin-data/acme"',
      'args = ["run", "/app/mcp.ts"]',
      '[mcp_servers."acme.tools".env]',
      '"x.y" = "bar"',
    ]);
  });

  it('emits native Codex HTTP servers with url + http_headers, no command/args', () => {
    const lines = renderMcpServerForTest('deepwiki', {
      type: 'http',
      url: 'https://example.com/mcp',
      headers: { Authorization: 'Bearer placeholder', 'X-Tenant': 'demo' },
    });
    expect(lines).toEqual([
      '[mcp_servers.deepwiki]',
      'url = "https://example.com/mcp"',
      'http_headers = { "Authorization" = "Bearer placeholder", "X-Tenant" = "demo" }',
    ]);
  });

  it('rejects deprecated SSE servers', () => {
    expect(() => renderMcpServerForTest('legacy', { type: 'sse', url: 'https://example.com/sse' })).toThrow(
      /deprecated SSE transport/,
    );
  });

  it('escapes quotes and backslashes in strings', () => {
    const lines = renderMcpServerForTest('q', {
      type: 'stdio',
      command: 'echo "hi"\\there',
      args: [],
      env: {},
    });
    expect(lines).toContain('command = "echo \\"hi\\"\\\\there"');
  });
});

describe('buildRuntimeConfig', () => {
  it('is generated base + runtime MCP servers — host config contributes nothing by construction', () => {
    const config = buildRuntimeConfigForTest({
      nanoclaw: { type: 'stdio', command: 'bun', args: ['run', '/app/mcp.ts'], env: {} },
      deepwiki: { type: 'http', url: 'https://mcp.deepwiki.com/mcp' },
    });

    // Generated container base, load-bearing settings present.
    expect(config).toContain('sandbox_mode = "workspace-write"');
    expect(config).toContain('approval_policy = "on-request"');
    expect(config).toContain('model_context_window = 800000');
    expect(config).toContain('model_auto_compact_token_limit = 720000');
    expect(config.indexOf('model_context_window = 800000')).toBeLessThan(config.indexOf('[features]'));
    expect(config.indexOf('model_auto_compact_token_limit = 720000')).toBeLessThan(config.indexOf('[features]'));
    expect(config).toContain('[features]');
    expect(config).toContain('hooks = true');
    expect(config).toContain('context_management = true');
    expect(config).toContain('fast_mode = false');
    expect(config).toContain('multi_agent = true');
    expect(config).toContain('[agents]');
    // Operator, 2026-09-17: no global subagent effort — Codex's native default
    // unless the spawn or the role names one (matches the host config).
    expect(config).not.toContain('default_subagent_reasoning_effort');
    expect(config).toContain('max_concurrent_threads_per_session = 5');
    expect(config).not.toContain('multi_agent_v2');
    expect(config).not.toContain('remote_control');
    expect(config).toContain('[projects."/workspace/agent"]');
    // Runtime MCP servers appended.
    expect(config).toContain('[mcp_servers.nanoclaw]');
    expect(config).toContain('command = "bun"');
    expect(config).toContain('[mcp_servers.deepwiki]');
    expect(config).toContain('url = "https://mcp.deepwiki.com/mcp"');
    // No model pin or personality can exist — the base is a constant.
    expect(config).not.toContain('model =');
    expect(config).not.toContain('personality');
  });

  it('drops a container-retired gitnexus entry even if wired', () => {
    const config = buildRuntimeConfigForTest({
      gitnexus: { type: 'stdio', command: '/pnpm/gitnexus', args: ['mcp'], env: {} },
      nanoclaw: { type: 'stdio', command: 'bun', args: ['run', '/app/mcp.ts'], env: {} },
    });
    expect(config).not.toMatch(/gitnexus/i);
    expect(config).toContain('[mcp_servers.nanoclaw]');
  });

  it('handles zero runtime servers', () => {
    const config = buildRuntimeConfigForTest({});
    expect(config).toContain('sandbox_mode = "workspace-write"');
    expect(config).not.toContain('[mcp_servers.');
  });

  it('test_codex_companion_never_reads_host_config_or_agents', () => {
    const source = fs.readFileSync(new URL('./codex-companion-setup.ts', import.meta.url), 'utf8');
    // Regression pins from past incidents, plus the decoupling contract:
    expect(source).not.toContain("path.join(HOST_CODEX_DIR, 'AGENTS.md')");
    expect(source).not.toContain("path.join(RUNTIME_CODEX_DIR, 'AGENTS.md')");
    expect(source).not.toContain("symlink the host's behavioral rules");
    // Peer runtime must not read the host's agents/ dir or merge host config.
    // (setupCodexPrimaryRuntime legitimately reads /home/node/.codex/config.toml
    // — in provider=codex mode that is the session-local GENERATED config.)
    expect(source).not.toContain("path.join(HOST_CODEX_DIR, 'agents')");
    expect(source).not.toContain('parseHostMcpServers');
    expect(source).not.toContain('buildMergedConfig');
  });

  it('exposes the peer-mode CODEX_HOME only once the image guard chain is confirmed installed', () => {
    const source = fs.readFileSync(new URL('./codex-companion-setup.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export function setupCodexRuntime');
    const body = source.slice(start, source.indexOf('\nfunction replaceWithDirectorySymlink', start));
    expect(body).toMatch(/systemGuardHookKeys\(\);\s*syncCodexHookTrust\(RUNTIME_CODEX_DIR\);/);
  });

  it('setupCodexRuntime fails closed on codex, not on the container', () => {
    // A `return null` on a hard failure is not a degrade: the caller only sets
    // CODEX_HOME on a non-null return, so peer `codex exec` would fall back to
    // the host-mounted /home/node/.codex — authenticated, without the runtime's
    // config or plugin hooks. Hard paths must hand back the nonexistent
    // sentinel instead, which codex refuses to start on. Throwing would also
    // close the guard but takes the whole container down over an optional peer
    // feature — under disk pressure that turns a degrade into a crash-loop.
    const source = fs.readFileSync(new URL('./codex-companion-setup.ts', import.meta.url), 'utf8');
    const start = source.indexOf('export function setupCodexRuntime');
    expect(start).toBeGreaterThan(-1);
    const body = source.slice(start, source.indexOf('\nfunction replaceWithDirectorySymlink', start));

    // The ONLY null return is the benign missing-auth case.
    expect(body.match(/return null/g) ?? []).toHaveLength(1);
    expect(body).toMatch(/Host codex auth not mounted[\s\S]*?return null/);
    // mkdir, auth symlink, config.toml write, and the guard-chain/trust check —
    // all four hand the sentinel back to the caller. Plugin registration and its
    // trust re-sync run at the first codex call
    // (completeDeferredCodexRegistration), which refuses that call instead.
    expect(body.match(/return failClosed\(/g) ?? []).toHaveLength(4);
    expect(body).not.toMatch(/\bthrow new\b/);

    // The sentinel must be a nonexistent path (codex hard-errors on it), and
    // failClosed must RETURN it rather than throw. Slice the helper's own body
    // only — trailing docs are prose and may legitimately say "throw".
    expect(FAILED_CODEX_HOME).toStartWith('/nonexistent/');
    expect(fs.existsSync(FAILED_CODEX_HOME)).toBe(false);
    const helperStart = source.indexOf('function failClosed(');
    const helper = source.slice(helperStart, source.indexOf('\n}\n', helperStart));
    expect(helper).toMatch(/^function failClosed\(what: string, err: unknown\): string \{/);
    expect(helper).toContain('return FAILED_CODEX_HOME;');
    expect(helper).not.toMatch(/\bthrow new\b/);
  });

  it("the runner exports setupCodexRuntime's home before the provider snapshots process.env", () => {
    const source = fs.readFileSync(new URL('./runner-main.ts', import.meta.url), 'utf8');
    const setup = source.indexOf('const codexHome = setupCodexRuntime(mcpServers');
    const construct = source.indexOf('createProvider(providerName, {');
    expect(setup).toBeGreaterThan(-1);
    expect(source.slice(setup, construct)).toMatch(
      /^const codexHome = setupCodexRuntime\([^;]+\);\s*if \(codexHome\) \{\s*Object\.assign\(process\.env, codexRuntimeEnv\(codexHome\)\);\s*\}\s*\}\s*const provider = $/,
    );
    expect(source.slice(construct, source.indexOf('});', construct))).toContain('env: { ...process.env },');
  });
});

describe('stripPluginsAndMarketplaces', () => {
  it('strips real Codex plugin/marketplace table shapes (verified against a live ~/.codex/config.toml)', () => {
    // Real Codex writes `[plugins."<entry>@<marketplace>"]` (quoted, dotted-@)
    // and `[marketplaces.<name>]` (bare) — verified against a live host
    // config.toml, not guessed.
    const toml = [
      'model = "gpt-5.5"',
      '',
      '[plugins."wix@skills"]',
      'enabled = true',
      '',
      '[plugins."humanizer@humanizer"]',
      'enabled = true',
      '',
      '[marketplaces.skills]',
      'source_type = "local"',
      'source = "/home/ubuntu/plugins/skills"',
      '',
      '[marketplaces.humanizer]',
      'source_type = "local"',
      'source = "/home/ubuntu/plugins/humanizer"',
      '',
      '[mcp_servers.exa]',
      'type = "http"',
      'url = "https://exa"',
      '',
      '[projects."/home/x"]',
      'trust_level = "trusted"',
    ].join('\n');

    const stripped = stripPluginsAndMarketplacesForTest(toml);
    expect(stripped).not.toContain('[plugins."wix@skills"]');
    expect(stripped).not.toContain('[plugins."humanizer@humanizer"]');
    expect(stripped).not.toContain('[marketplaces.skills]');
    expect(stripped).not.toContain('[marketplaces.humanizer]');
    expect(stripped).not.toContain('/home/ubuntu/plugins/skills');
    // Unrelated tables survive untouched.
    expect(stripped).toContain('model = "gpt-5.5"');
    expect(stripped).toContain('[mcp_servers.exa]');
    expect(stripped).toContain('url = "https://exa"');
    expect(stripped).toContain('[projects."/home/x"]');
    expect(stripped).toContain('trust_level = "trusted"');
  });

  it('strips a bare [plugins] / [marketplaces] table header with no dotted suffix', () => {
    // `model = "x"` must precede any table header — once a `[table]` header
    // is seen, subsequent key = value lines belong to THAT table in real
    // TOML, so a trailing top-level key would need its own header to close
    // the preceding block (exactly like stripExistingMcpServers/
    // stripGitNexusReentrySurfaces, which share this same block-scoping).
    const toml = ['model = "x"', '', '[plugins]', 'some_key = true', '', '[marketplaces]', 'other = false'].join('\n');
    const stripped = stripPluginsAndMarketplacesForTest(toml);
    expect(stripped).not.toContain('some_key');
    expect(stripped).not.toContain('other = false');
    expect(stripped).toContain('model = "x"');
  });

  it('passes through TOML with no plugins/marketplaces tables', () => {
    const toml = 'model = "x"\n[mcp_servers.foo]\ntype = "http"\nurl = "u"\n';
    expect(stripPluginsAndMarketplacesForTest(toml)).toBe(toml);
  });

  it('handles empty input', () => {
    expect(stripPluginsAndMarketplacesForTest('')).toBe('');
  });

  it('projects one container-owned registration into an OAuth fallback config', () => {
    const primary = [
      'model = "gpt-5.6-sol"',
      '',
      '[plugins."bootstrap-workflow-agents@davekim917-bootstrap"]',
      'enabled = true',
      '',
      '[marketplaces.davekim917-bootstrap]',
      'source_type = "local"',
      'source = "/workspace/plugins/bootstrap"',
      '',
      '[mcp_servers.nanoclaw]',
      'command = "bun"',
    ].join('\n');
    const fallback = [
      'model = "gpt-5.6-sol"',
      '',
      '[plugins."stale@host"]',
      'enabled = true',
      '',
      '[marketplaces.host]',
      'source = "/home/ubuntu/.codex/plugins"',
      '',
      '[features]',
      'codex_hooks = true',
    ].join('\n');

    const projected = projectCodexPluginConfigForTest(primary, fallback);
    expect(projected).toContain('[plugins."bootstrap-workflow-agents@davekim917-bootstrap"]');
    expect(projected).toContain('[marketplaces.davekim917-bootstrap]');
    expect(projected).not.toContain('[plugins."stale@host"]');
    expect(projected).not.toContain('/home/ubuntu/.codex/plugins');
    expect(projected).toContain('[features]');
    expect(projected).toContain('codex_hooks = true');
    expect(projected).not.toContain('[mcp_servers.nanoclaw]');
  });
});

describe('planCodexPluginRegistration', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-plugin-plan-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  function writeJson(p: string, obj: unknown) {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(obj));
  }

  it('returns an empty plan for a missing plugins root', () => {
    expect(planCodexPluginRegistration(path.join(root, 'does-not-exist'))).toEqual([]);
  });

  it('skips a non-directory entry', () => {
    fs.writeFileSync(path.join(root, 'stray-file'), 'not a plugin');
    const plans = planCodexPluginRegistration(root);
    expect(plans).toEqual([{ name: 'stray-file', action: 'skip', reason: 'not-a-directory' }]);
  });

  it('skips a plugin whose .nanoclaw-plugin.json denies codex', () => {
    const dir = path.join(root, 'some-plugin');
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, '.nanoclaw-plugin.json'), { denySiblings: ['codex'] });
    writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), { name: 'some-plugin' });
    writeJson(path.join(dir, '.agents', 'plugins', 'marketplace.json'), { name: 'some-plugin' });

    const plans = planCodexPluginRegistration(root);
    expect(plans).toEqual([{ name: 'some-plugin', action: 'skip', reason: 'denied-for-codex' }]);
  });

  it('skips a plugin with no .codex-plugin/plugin.json (not Codex-registerable)', () => {
    const dir = path.join(root, 'skill-only-plugin');
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, '.agents', 'plugins', 'marketplace.json'), { name: 'skill-only-plugin' });

    const plans = planCodexPluginRegistration(root);
    expect(plans).toEqual([{ name: 'skill-only-plugin', action: 'skip', reason: 'no-codex-plugin-manifest' }]);
  });

  it('skips a plugin with no .agents/plugins/marketplace.json', () => {
    const dir = path.join(root, 'no-marketplace-plugin');
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), { name: 'no-marketplace-plugin' });

    const plans = planCodexPluginRegistration(root);
    expect(plans).toEqual([{ name: 'no-marketplace-plugin', action: 'skip', reason: 'no-marketplace-manifest' }]);
  });

  it('resolves entry name from plugin.json and marketplace name from marketplace.json — NOT the folder name', () => {
    // Reproduces the real wix-in-~/plugins/skills shape: folder is "skills",
    // but .codex-plugin/plugin.json name is "wix" and
    // .agents/plugins/marketplace.json name is "skills". `codex plugin add`
    // must be called as `wix@skills`, never `skills@skills`.
    const dir = path.join(root, 'skills');
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, '.codex-plugin', 'plugin.json'), { name: 'wix', version: '1.15.0' });
    writeJson(path.join(dir, '.agents', 'plugins', 'marketplace.json'), {
      name: 'skills',
      plugins: [{ name: 'wix', source: { source: 'local', path: './' } }],
    });

    const plans = planCodexPluginRegistration(root);
    expect(plans).toEqual([
      {
        name: 'skills',
        action: 'register',
        entryName: 'wix',
        marketplaceName: 'skills',
        repoName: 'skills',
        pluginDir: dir,
      },
    ]);
  });

  it('handles a mix of register + every skip reason across multiple entries', () => {
    fs.writeFileSync(path.join(root, 'a-stray-file'), 'x');

    const denied = path.join(root, 'denied-plugin');
    fs.mkdirSync(denied, { recursive: true });
    writeJson(path.join(denied, '.nanoclaw-plugin.json'), { denySiblings: ['codex'] });

    const registerable = path.join(root, 'taste-skill');
    fs.mkdirSync(registerable, { recursive: true });
    writeJson(path.join(registerable, '.codex-plugin', 'plugin.json'), { name: 'taste-skill' });
    writeJson(path.join(registerable, '.agents', 'plugins', 'marketplace.json'), { name: 'taste-skill' });

    const plans = planCodexPluginRegistration(root);
    const byName = new Map(plans.map((p) => [p.name, p]));
    expect(byName.get('a-stray-file')).toEqual({ name: 'a-stray-file', action: 'skip', reason: 'not-a-directory' });
    expect(byName.get('denied-plugin')).toEqual({ name: 'denied-plugin', action: 'skip', reason: 'denied-for-codex' });
    expect(byName.get('taste-skill')).toEqual({
      name: 'taste-skill',
      action: 'register',
      entryName: 'taste-skill',
      marketplaceName: 'taste-skill',
      // `repoName` is the dir `codex plugin marketplace add` targets. For a
      // single-plugin repo it equals `name`; for a monorepo sub-plugin the label
      // is `<repo>/<entry>` while repoName stays the repo root.
      repoName: 'taste-skill',
      // Dir holding the `.codex-plugin` manifest — what hook-trust reads the
      // plugin's declared hooks file from.
      pluginDir: registerable,
    });
    expect(plans).toHaveLength(3);
  });

  it('registers marketplace-monorepo sub-plugins (no manifest at the repo root)', () => {
    // Regression guard. role-specific-plugins / claude-plugins-official / bootstrap keep
    // their .codex-plugin manifests one level down. Planning only top-level manifests
    // silently dropped those ENTIRE repos — data-analytics (14 skills) and
    // bootstrap-workflow-agents (17) vanished from codex containers with no error.
    const repo = path.join(root, 'monorepo');
    fs.mkdirSync(path.join(repo, '.agents', 'plugins'), { recursive: true });
    writeJson(path.join(repo, '.agents', 'plugins', 'marketplace.json'), { name: 'monorepo-mkt' });
    // Checked-out sub-plugin WITH a manifest → registers.
    const sub = path.join(repo, 'plugins', 'analytics');
    fs.mkdirSync(path.join(sub, '.codex-plugin'), { recursive: true });
    writeJson(path.join(sub, '.codex-plugin', 'plugin.json'), { name: 'data-analytics' });
    // Sub-dir advertised by the marketplace but NOT checked out / no manifest → ignored,
    // which is what makes a sparse checkout register only what is actually present.
    fs.mkdirSync(path.join(repo, 'plugins', 'not-checked-out'), { recursive: true });

    const byName = new Map(planCodexPluginRegistration(root).map((p) => [p.name, p]));
    expect(byName.get('monorepo/data-analytics')).toEqual({
      name: 'monorepo/data-analytics',
      action: 'register',
      entryName: 'data-analytics',
      marketplaceName: 'monorepo-mkt',
      repoName: 'monorepo',
      // The SUB-directory, not the repo root: that is where the manifest and
      // any declared hooks file live.
      pluginDir: sub,
    });
    expect(byName.has('monorepo/not-checked-out')).toBe(false);
  });

  it('never registers a sub-plugin directory that carries no Codex manifest', () => {
    // A manifest-less directory is skipped: `readCodexPluginEntryName` returns
    // null and `findCodexSubPlugins` drops it, in both layouts the walker
    // descends. NOTE this pins walker behaviour, NOT an exclusion — a
    // sub-plugin named in `excludePlugins` still reaches this walker intact,
    // because the host mask that used to blank it was removed (#826). The
    // follow-up that teaches this walker the exclusion list will build on
    // exactly this skip.
    const repo = path.join(root, 'bootstrap');
    writeJson(path.join(repo, '.agents', 'plugins', 'marketplace.json'), { name: 'bootstrap-mkt' });
    const kept = path.join(repo, 'plugins', 'wwbd');
    writeJson(path.join(kept, '.codex-plugin', 'plugin.json'), { name: 'wwbd' });
    fs.mkdirSync(path.join(repo, 'plugins', 'orchestrate'), { recursive: true });
    fs.mkdirSync(path.join(repo, 'rootlevel'), { recursive: true });

    const plans = planCodexPluginRegistration(root);
    expect(plans.map((p) => p.name)).toEqual(['bootstrap/wwbd']);
  });
});

// ── Hook trust wiring ──────────────────────────────────────────────────────
// Codex >=0.154 loads an untrusted hook and then never dispatches it, with no
// error anywhere. So the invariant worth guarding is not "we call the trust
// function" but the EFFECT: read back the two files a spawn actually leaves on
// disk and prove every hook in one is trusted by the other.

/** Minimal `[hooks.state."<key>"] trusted_hash = "<hash>"` reader. */
function parseTrustEntries(toml: string): Map<string, string> {
  const entries = new Map<string, string>();
  let current: string | null = null;
  for (const line of toml.split('\n')) {
    const header = parseTomlTableHeader(line);
    if (header !== null) {
      const match = header.match(/^hooks\.state\."(.*)"$/);
      current = match ? match[1] : null;
      continue;
    }
    const hash = current && line.match(/^\s*trusted_hash\s*=\s*"([^"]+)"\s*$/);
    if (hash) entries.set(current as string, hash[1]);
  }
  return entries;
}

describe('readCodexConfigToml', () => {
  // Every config.toml read in this module exists only to REWRITE the file from
  // what it read, so "could not look" collapsing into "nothing there" does not
  // lose a read, it loses the file — and the write then succeeds, which is why
  // no caller notices. Three answers, not two.
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-config-read-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns the contents when the file is readable', () => {
    const p = path.join(dir, 'config.toml');
    fs.writeFileSync(p, '[features]\nhooks = true\n');
    expect(readCodexConfigToml(p)).toBe('[features]\nhooks = true\n');
  });

  it('answers empty for an absent file — ENOENT is the only absence', () => {
    expect(readCodexConfigToml(path.join(dir, 'missing.toml'))).toBe('');
    // A missing PARENT is ENOENT too, and is genuinely absent.
    expect(readCodexConfigToml(path.join(dir, 'nodir', 'config.toml'))).toBe('');
  });

  it('throws for a file that exists but cannot be read', () => {
    const p = path.join(dir, 'config.toml');
    fs.writeFileSync(p, '[features]\nhooks = true\n');
    fs.chmodSync(p, 0o200);
    try {
      expect(() => readCodexConfigToml(p)).toThrow(/could not read Codex config/i);
    } finally {
      fs.chmodSync(p, 0o600);
    }
  });

  it('is the only way ANY config.toml writer reads one, across all three modules', () => {
    // The pattern audit, not a grep done once by hand: the defect was
    // `existsSync(p) ? readFileSync(p) : ''` at the site that feeds every
    // OAuth fallback home, which `existsSync` answering false on EACCES turns
    // into an empty projection over all of them — and, separately,
    // `catch { base = '' }` in the MCP writer, which turned an unreadable-but-
    // writable config.toml into a file TRUNCATED to MCP tables. Reintroducing
    // either shape in any of the three modules that touch a config.toml fails
    // here; auditing only this file is what let the MCP writer keep its copy.
    const owner = fs.readFileSync(new URL('./providers/codex-config-file.ts', import.meta.url), 'utf-8');
    const helperAt = owner.indexOf('export function readCodexConfigToml');
    expect(helperAt).toBeGreaterThan(-1);
    const helper = owner.slice(helperAt, owner.indexOf('\n}\n', helperAt));
    // …and the helper itself is still the three-answer one.
    expect(helper).toContain("code === 'ENOENT'");

    const audited: Array<[string, string]> = [
      ['codex-config-file.ts', owner.slice(0, helperAt) + owner.slice(helperAt + helper.length)],
      ['codex-companion-setup.ts', fs.readFileSync(new URL('./codex-companion-setup.ts', import.meta.url), 'utf-8')],
      [
        'providers/codex-app-server.ts',
        fs.readFileSync(new URL('./providers/codex-app-server.ts', import.meta.url), 'utf-8'),
      ],
    ];
    // Report the offending LINES, not the whole file — a 900-line diff in the
    // failure message is a test nobody reads.
    const offenders: string[] = [];
    for (const [name, source] of audited) {
      for (const line of source.split('\n')) {
        if (
          /existsSync\([^)]*[Cc]onfig[^)]*\)\s*\?/.test(line) ||
          /readFileSync\([^)]*[Cc]onfig(Path|TomlPath)/.test(line)
        ) {
          offenders.push(`${name}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every in-tree config.toml commit goes through the durable writer', () => {
    // The other half of the same class. A plain `writeFileSync(<configPath>, …)`
    // truncates in place, so an ENOSPC after the open leaves the file empty or
    // partial and the NEXT spawn reads the damage as its base. One writer
    // keeping a plain write buys nothing for the others sharing the file.
    for (const rel of ['./codex-companion-setup.ts', './providers/codex-app-server.ts']) {
      const source = fs.readFileSync(new URL(rel, import.meta.url), 'utf-8');
      const offenders = source
        .split('\n')
        .filter((line) =>
          /writeFileSync\(\s*(configTomlPath|configPath|runtimeConfigPath|fallbackConfigPath)/.test(line),
        )
        .map((line) => `${rel}: ${line.trim()}`);
      expect(offenders).toEqual([]);
    }
  });
});

/** A plugins root holding one Codex plugin that declares one PreToolUse hook running `command`. */
function hookedPluginsRoot(command = 'bun "${PLUGIN_ROOT}/hooks/codex-guard.ts" PreToolUse'): string {
  const pluginsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-trust-plugins-'));
  const repo = path.join(pluginsRoot, 'bootstrap');
  const sub = path.join(repo, 'plugins', 'workflow-agents');
  fs.mkdirSync(path.join(repo, '.agents', 'plugins'), { recursive: true });
  fs.writeFileSync(
    path.join(repo, '.agents', 'plugins', 'marketplace.json'),
    JSON.stringify({ name: 'davekim917-bootstrap' }),
  );
  fs.mkdirSync(path.join(sub, '.codex-plugin'), { recursive: true });
  fs.mkdirSync(path.join(sub, 'hooks'), { recursive: true });
  fs.writeFileSync(
    path.join(sub, '.codex-plugin', 'plugin.json'),
    JSON.stringify({ name: 'bootstrap-workflow-agents', hooks: './hooks/workflow-hooks.json' }),
  );
  fs.writeFileSync(
    path.join(sub, 'hooks', 'workflow-hooks.json'),
    JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command, timeout: 3600 }] }] } }),
  );
  return pluginsRoot;
}

const WORKFLOW_HOOK_KEY = 'bootstrap-workflow-agents@davekim917-bootstrap:hooks/workflow-hooks.json:pre_tool_use:0:0';

describe('syncCodexHookTrust', () => {
  let home: string;
  let pluginsRoot: string;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-trust-home-'));
    fs.writeFileSync(path.join(home, 'config.toml'), '[features]\nhooks = true\n');
    pluginsRoot = hookedPluginsRoot();
  });
  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(pluginsRoot, { recursive: true, force: true });
  });

  it('throws rather than returning when the TRUST write fails', () => {
    // Reporting success with the trust write failed leaves codex loading the
    // plugin handlers, reporting them untrusted and never dispatching them,
    // while the app-server starts anyway. Every caller continues straight into
    // a spawn, so the failure has to reach them.
    //
    // A read-only config.toml is NOT the lever: the durable writer commits by
    // rename, which the DIRECTORY's mode governs, so a 0400 config.toml is
    // replaced. The lever is a leftover read-only `config.toml.tmp` — the shape
    // a crashed write can leave behind — which makes the `open(…, 'w')` fail.
    const configPath = path.join(home, 'config.toml');
    const tmpPath = `${configPath}.tmp`;
    fs.writeFileSync(tmpPath, 'leftover');
    fs.chmodSync(tmpPath, 0o400);
    expect(() => syncCodexHookTrust(home, { pluginsRoot })).toThrow(/hook trust/i);
    // The last valid config is still standing, untouched.
    expect(fs.readFileSync(configPath, 'utf-8')).toBe('[features]\nhooks = true\n');
    // The failed commit cleaned up after itself: `unlink(2)` needs write on
    // the DIRECTORY, so even the read-only temp file goes, and the next spawn
    // is not blocked by the wreckage of this one.
    expect(fs.existsSync(tmpPath)).toBe(false);
  });

  it('REPLACES a read-only config.toml, because the commit is a rename the directory governs', () => {
    const configPath = path.join(home, 'config.toml');
    fs.chmodSync(configPath, 0o400);
    syncCodexHookTrust(home, { pluginsRoot });
    const committed = fs.readFileSync(configPath, 'utf-8');
    expect(committed).toContain('[features]');
    expect(committed).toContain('[hooks.state.');
    // No temp file left behind on the success path.
    expect(fs.existsSync(`${configPath}.tmp`)).toBe(false);
  });

  it('throws, and leaves config.toml untouched, when the config is unreadable but writable', () => {
    // Rewriting from an empty base would SUCCEED and drop `[features] hooks =
    // true`. Mode 0200 is the live shape (a mount that kept write and lost
    // read); only ENOENT means "absent".
    const configPath = path.join(home, 'config.toml');
    const original = '[features]\nhooks = true\n\n[marketplaces.mkt]\nsource_type = "local"\n';
    fs.writeFileSync(configPath, original);
    fs.chmodSync(configPath, 0o200);
    try {
      expect(() => syncCodexHookTrust(home, { pluginsRoot })).toThrow(/could not read Codex config/i);
      fs.chmodSync(configPath, 0o600);
      // The refusal happened BEFORE the rewrite, not after a partial one.
      expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
    } finally {
      fs.chmodSync(configPath, 0o600);
    }
  });

  it('writes exactly the plugin rows: none for the guard chain, and a stale per-home guard row is dropped', () => {
    // The guard chain is the image's system layer, dispatched as managed with no
    // row. A row naming a per-home hooks.json is dead weight that must not
    // survive the rewrite.
    fs.writeFileSync(
      path.join(home, 'config.toml'),
      `[features]\nhooks = true\n\n[hooks.state."${home}/hooks.json:pre_tool_use:0:0"]\ntrusted_hash = "sha256:stale"\n`,
    );
    syncCodexHookTrust(home, { pluginsRoot });
    const trusted = parseTrustEntries(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8'));
    expect([...trusted.keys()]).toEqual([WORKFLOW_HOOK_KEY]);
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8')).toContain('hooks = true');
  });

  it('is what the codex provider calls before every app-server spawn', () => {
    // Two call sites: the pre-spawn write and `restartAppServer`, which every
    // recovery and OAuth-rotation branch goes through. A rotated home without
    // the plugin rows runs without the plugins' hooks.
    const source = fs.readFileSync(new URL('./providers/codex.ts', import.meta.url), 'utf8');
    expect(source.match(/\bsyncCodexHookTrust\(resolveCodexConfigDir\(\)\)/g)).toHaveLength(2);
  });

  it('trusts the hooks a mounted plugin declares, keyed <plugin>@<marketplace>', () => {
    // The Claude provider already dispatches these same plugins' hooks through
    // the SDK; leaving them untrusted under Codex is a provider asymmetry, not
    // isolation — it is why the workflow-agents Codex guard was inert.
    syncCodexHookTrust(home, { pluginsRoot });
    const trusted = parseTrustEntries(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8'));
    // Hash pinned to what Codex itself wrote for this exact hook, so this
    // asserts interoperability, not just self-consistency.
    expect(trusted.get(WORKFLOW_HOOK_KEY)).toBe(
      'sha256:098408625edddbfeabfdc5593d17ade95699bf36fd463bd17ffd604cf314cb4a',
    );
  });

  it('writes the same plugin rows into a rotated home', () => {
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-hook-trust-home2-'));
    try {
      syncCodexHookTrust(home, { pluginsRoot });
      syncCodexHookTrust(other, { pluginsRoot });
      expect([...parseTrustEntries(fs.readFileSync(path.join(other, 'config.toml'), 'utf-8')).keys()]).toEqual([
        WORKFLOW_HOOK_KEY,
      ]);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  it('tracks a changed hook command instead of leaving the old hash trusted', () => {
    syncCodexHookTrust(home, { pluginsRoot });
    const before = parseTrustEntries(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8'));
    const changed = hookedPluginsRoot('bun "${PLUGIN_ROOT}/hooks/codex-guard.ts" PreToolUse --changed');
    try {
      syncCodexHookTrust(home, { pluginsRoot: changed });
      const after = parseTrustEntries(fs.readFileSync(path.join(home, 'config.toml'), 'utf-8'));
      expect(before.get(WORKFLOW_HOOK_KEY)).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(after.get(WORKFLOW_HOOK_KEY)).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(after.get(WORKFLOW_HOOK_KEY)).not.toBe(before.get(WORKFLOW_HOOK_KEY));
    } finally {
      fs.rmSync(changed, { recursive: true, force: true });
    }
  });
});

// ── Filesystem integration ─────────────────────────────────────────────────
// Only runs inside the container where /home/node is writable. Skipped on
// host so `bun test` passes pre-commit without root.

const HOST_CODEX_DIR = '/home/node/.codex';
const RUNTIME_CODEX_DIR = '/home/node/.codex-runtime';

const CAN_RUN_FS = (() => {
  try {
    fs.accessSync('/home/node', fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
})();

(CAN_RUN_FS ? describe : describe.skip)('setupCodexRuntime (filesystem)', () => {
  let savedHostExists = false;
  let savedHostAuth: string | null = null;
  let savedHostConfig: string | null = null;
  let savedRuntimeExists = false;

  beforeEach(() => {
    savedHostExists = fs.existsSync(HOST_CODEX_DIR);
    if (savedHostExists) {
      const authPath = path.join(HOST_CODEX_DIR, 'auth.json');
      const cfgPath = path.join(HOST_CODEX_DIR, 'config.toml');
      if (fs.existsSync(authPath)) savedHostAuth = fs.readFileSync(authPath, 'utf-8');
      if (fs.existsSync(cfgPath)) savedHostConfig = fs.readFileSync(cfgPath, 'utf-8');
    }
    savedRuntimeExists = fs.existsSync(RUNTIME_CODEX_DIR);
    fs.mkdirSync(HOST_CODEX_DIR, { recursive: true });
  });

  afterEach(() => {
    if (!savedRuntimeExists) {
      try {
        fs.rmSync(RUNTIME_CODEX_DIR, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    }
    if (!savedHostExists) {
      try {
        fs.rmSync(HOST_CODEX_DIR, { recursive: true, force: true });
      } catch {
        /* noop */
      }
    } else {
      if (savedHostAuth !== null) fs.writeFileSync(path.join(HOST_CODEX_DIR, 'auth.json'), savedHostAuth);
      if (savedHostConfig !== null) fs.writeFileSync(path.join(HOST_CODEX_DIR, 'config.toml'), savedHostConfig);
    }
  });

  it('returns null when host auth is missing', () => {
    const auth = path.join(HOST_CODEX_DIR, 'auth.json');
    if (fs.existsSync(auth)) fs.unlinkSync(auth);
    const result = setupCodexRuntime({});
    expect(result).toBe(null);
  });

  it('prepares the home without running codex: plugin registration waits for the first codex call', () => {
    fs.writeFileSync(path.join(HOST_CODEX_DIR, 'auth.json'), '{}');
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-boot-'));
    const savedPath = process.env.PATH;
    try {
      fs.mkdirSync(path.join(scratch, 'bin'));
      fs.writeFileSync(path.join(scratch, 'bin', 'codex'), FAKE_PLUGIN_CODEX, { mode: 0o755 });
      process.env.PATH = `${path.join(scratch, 'bin')}:${savedPath}`;
      process.env.FAKE_CODEX_LOG = path.join(scratch, 'calls.tsv');

      expect(setupCodexRuntime({})).toBe(RUNTIME_CODEX_DIR);

      expect(fs.existsSync(path.join(scratch, 'calls.tsv'))).toBe(false);
      expect(fs.existsSync(path.join(RUNTIME_CODEX_DIR, 'config.toml'))).toBe(true);
      expect(fs.existsSync(path.join(RUNTIME_CODEX_DIR, '.nanoclaw-plugins-registered'))).toBe(false);
    } finally {
      process.env.PATH = savedPath;
      delete process.env.FAKE_CODEX_LOG;
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('symlinks auth.json to host', () => {
    fs.writeFileSync(path.join(HOST_CODEX_DIR, 'auth.json'), '{}');
    const result = setupCodexRuntime({});
    expect(result).toBe(RUNTIME_CODEX_DIR);
    const runtimeAuth = path.join(RUNTIME_CODEX_DIR, 'auth.json');
    expect(fs.lstatSync(runtimeAuth).isSymbolicLink()).toBe(true);
    expect(fs.readlinkSync(runtimeAuth)).toBe(path.join(HOST_CODEX_DIR, 'auth.json'));
  });

  it('writes generated config.toml with container MCP servers; host config is ignored', () => {
    fs.writeFileSync(path.join(HOST_CODEX_DIR, 'auth.json'), '{}');
    fs.writeFileSync(
      path.join(HOST_CODEX_DIR, 'config.toml'),
      'model = "gpt-5.5"\npersonality = "pragmatic"\n[mcp_servers.exa]\ntype = "http"\nurl = "https://exa"\n',
    );
    setupCodexRuntime({
      nanoclaw: { type: 'stdio', command: 'bun', args: ['run', '/app/mcp.ts'], env: {} },
    });
    const written = fs.readFileSync(path.join(RUNTIME_CODEX_DIR, 'config.toml'), 'utf-8');
    expect(written).not.toContain('gpt-5.5');
    expect(written).not.toContain('personality');
    expect(written).not.toContain('[mcp_servers.exa]');
    expect(written).toContain('sandbox_mode = "workspace-write"');
    expect(written).toContain('[mcp_servers.nanoclaw]');
    // The guard chain is the image's /etc/codex layer, never a per-home file.
    expect(fs.existsSync(path.join(RUNTIME_CODEX_DIR, 'hooks.json'))).toBe(false);
  });

  it('gives each staged fallback the runtime config, and keeps its own credential', () => {
    const fallback = '/home/node/.codex-fallback-test';
    const bare = '/home/node/.codex-fallback-test-bare';
    try {
      fs.writeFileSync(path.join(HOST_CODEX_DIR, 'auth.json'), '{}');
      fs.mkdirSync(fallback, { recursive: true });
      fs.mkdirSync(bare, { recursive: true });
      fs.writeFileSync(path.join(fallback, 'auth.json'), '{"account":"fallback"}');
      fs.writeFileSync(path.join(fallback, 'config.toml'), 'model = "host-staged"\n');
      const servers = { nanoclaw: { type: 'stdio' as const, command: 'bun', args: ['run', '/app/mcp.ts'], env: {} } };
      expect(setupCodexRuntime(servers)).toBe(RUNTIME_CODEX_DIR);

      expect(setupCodexFallbackRuntimes(servers, [fallback, bare])).toEqual([fallback]);

      const config = fs.readFileSync(path.join(fallback, 'config.toml'), 'utf-8');
      expect(config).toContain('[mcp_servers.nanoclaw]');
      expect(config).not.toContain('host-staged');
      expect(fs.existsSync(path.join(fallback, 'hooks.json'))).toBe(false);
      expect(fs.readFileSync(path.join(fallback, 'auth.json'), 'utf-8')).toBe('{"account":"fallback"}');
      expect(fs.readdirSync(bare)).toEqual([]);
    } finally {
      fs.rmSync(fallback, { recursive: true, force: true });
      fs.rmSync(bare, { recursive: true, force: true });
    }
  }, 120_000);
});

// ── verifyCodexHookTrust ───────────────────────────────────────────────────

/**
 * Minimal app-server stub: `sendCodexRequest` writes a JSON-RPC line to
 * `process.stdin` and resolves whatever it finds in `pending`, so a stub only
 * has to answer on that path.
 */
function hookListServer(answer: { result?: unknown; error?: { code: number; message: string } } | null): AppServer {
  const pending = new Map<number, { resolve: (value: never) => void; reject: (error: Error) => void }>();
  return {
    process: {
      stdin: {
        write(line: string) {
          const request = JSON.parse(line) as { id: number };
          if (answer) {
            queueMicrotask(() => {
              const handler = pending.get(request.id);
              pending.delete(request.id);
              handler?.resolve({ id: request.id, ...answer } as never);
            });
          }
          return true;
        },
      },
      kill: () => true,
    },
    readline: { close() {} },
    pending,
    notificationHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;
}

/** The guard chain the image installs at /etc/codex/hooks.json, read from its source in the repo. */
const SYSTEM_HOOKS = new URL('../../codex-system/hooks.json', import.meta.url).pathname;
const SYSTEM_KEYS = [`${SYSTEM_HOOKS}:pre_tool_use:0:0`, `${SYSTEM_HOOKS}:post_tool_use:0:0`];

function listing(rows: Array<Record<string, unknown>>): { result: unknown } {
  return { result: { data: [{ cwd: '/workspace/agent', hooks: rows, warnings: [], errors: [] }] } };
}

/** As codex 0.163.0 lists a system-layer handler (measured). */
const managedRow = (key: string) => ({ key, source: 'system', isManaged: true, enabled: true, trustStatus: 'managed' });

describe('verifyCodexHookTrust', () => {
  const verify = (answer: Parameters<typeof hookListServer>[0], systemHooksPath = SYSTEM_HOOKS) =>
    verifyCodexHookTrust(hookListServer(answer), { systemHooksPath });

  it('passes when every system guard handler reads back managed and enabled', async () => {
    await verify(listing(SYSTEM_KEYS.map(managedRow)));
  });

  it('REFUSES the spawn when a guard handler reads back untrusted', async () => {
    // The failure this check exists for: the handler loads, codex reports it
    // undispatchable, and the session otherwise runs normally.
    const rows = SYSTEM_KEYS.map((key, i) =>
      i === 0 ? { ...managedRow(key), trustStatus: 'untrusted' } : managedRow(key),
    );
    await expect(verify(listing(rows))).rejects.toThrow(/hook trust verification failed/i);
  });

  it('REFUSES the spawn when the listing is empty', async () => {
    // Hooks feature off, or the system file unread: nothing bad to find in the
    // listing, and the whole guard chain is inert.
    await expect(verify(listing([]))).rejects.toThrow(/missing/);
  });

  it('REFUSES the spawn when a guard handler is managed but DISABLED', async () => {
    const rows = SYSTEM_KEYS.map((key, i) => ({ ...managedRow(key), enabled: i !== 0 }));
    await expect(verify(listing(rows))).rejects.toThrow(/enabled=false/);
  });

  it('REFUSES the spawn when hooks/list itself fails', async () => {
    // Fail closed on a version drift that removes or renames the method: the
    // alternative is the same silence the check exists to end.
    await expect(verify({ error: { code: -32601, message: 'method not found' } })).rejects.toThrow(
      /hooks\/list unavailable/,
    );
  });

  it('REFUSES the spawn when the image ships no guard chain', async () => {
    await expect(verify(listing(SYSTEM_KEYS.map(managedRow)), '/nonexistent/etc/codex/hooks.json')).rejects.toThrow(
      /no Codex guard chain is installed at \/nonexistent\/etc\/codex\/hooks\.json/,
    );
  });

  it('does not accept a per-home copy of the chain in place of the system one', async () => {
    // A home's own hooks.json is agent-writable, so it can never stand in for the root-owned layer.
    const rows = [
      '/home/node/.codex/hooks.json:pre_tool_use:0:0',
      '/home/node/.codex/hooks.json:post_tool_use:0:0',
    ].map((key) => ({ key, source: 'user', enabled: true, trustStatus: 'trusted' }));
    await expect(verify(listing(rows))).rejects.toThrow(/missing/);
  });

  it('does NOT fail on an undispatchable plugin handler', async () => {
    // Reported, not fatal: one oddly-shaped third-party plugin must not take
    // the container down, and the guard core depends on no plugin.
    const rows = [
      ...SYSTEM_KEYS.map(managedRow),
      {
        key: 'some-plugin@mkt:hooks/hooks.json:pre_tool_use:0:0',
        pluginId: 'some-plugin@mkt',
        enabled: true,
        trustStatus: 'untrusted',
      },
    ];
    await verify(listing(rows));
  });
});

// ── deferred plugin registration ───────────────────────────────────────────

// `codex plugin …` is faked at the process boundary: it logs each call and appends the plugin table real codex
// writes. Its rewrite drops the hook trust rows, so only the trust re-sync after registration restores them.
const FAKE_PLUGIN_CODEX = `#!/usr/bin/env bash
printf '%s\\t%s\\n' "$CODEX_HOME" "$*" >>"$FAKE_CODEX_LOG"
if [ "$2" = add ]; then
  [ "$3" = "\${FAKE_PLUGIN_ADD_FAILS:-}" ] && { echo "plugin add exploded" >&2; exit 1; }
  mkdir -p "$CODEX_HOME/plugins/cache/$3"
  awk '/^\\[/{ skip = ($0 ~ /^\\[hooks\\.state/) } !skip' "$CODEX_HOME/config.toml" >"$CODEX_HOME/config.toml.new"
  mv "$CODEX_HOME/config.toml.new" "$CODEX_HOME/config.toml"
  printf '\\n[plugins."%s"]\\nenabled = true\\n' "$3" >>"$CODEX_HOME/config.toml"
  if [ -n "\${FAKE_BLOCK_TRUST_WRITE:-}" ]; then echo leftover >"$CODEX_HOME/config.toml.tmp"; chmod 0400 "$CODEX_HOME/config.toml.tmp"; fi
fi
exit 0
`;

allowSubprocess(['codex']);

describe('deferred Codex plugin registration', () => {
  let root: string;
  let pluginsRoot: string;
  let home: string;
  let log: string;
  const savedPath = process.env.PATH;
  const savedFails = process.env.FAKE_PLUGIN_ADD_FAILS;
  const pluginHookKey = (entry: string, marketplace: string) =>
    `${entry}@${marketplace}:hooks/hooks.json:pre_tool_use:0:0`;
  /** Trust keys present in a home's config.toml. */
  const trustedKeys = (codexHome: string): string[] => [
    ...parseTrustEntries(fs.readFileSync(path.join(codexHome, 'config.toml'), 'utf-8')).keys(),
  ];

  /** A plugin declares one PreToolUse hook unless `hooks` is false. */
  function addPlugin(repo: string, entry: string, marketplace: string, sub?: string, hooks = true): void {
    const repoDir = path.join(pluginsRoot, repo);
    const pluginDir = sub ? path.join(repoDir, 'plugins', sub) : repoDir;
    fs.mkdirSync(path.join(repoDir, '.agents', 'plugins'), { recursive: true });
    fs.writeFileSync(
      path.join(repoDir, '.agents', 'plugins', 'marketplace.json'),
      JSON.stringify({ name: marketplace }),
    );
    fs.mkdirSync(path.join(pluginDir, '.codex-plugin'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, '.codex-plugin', 'plugin.json'),
      JSON.stringify(hooks ? { name: entry, hooks: './hooks/hooks.json' } : { name: entry }),
    );
    if (!hooks) return;
    fs.mkdirSync(path.join(pluginDir, 'hooks'), { recursive: true });
    fs.writeFileSync(
      path.join(pluginDir, 'hooks', 'hooks.json'),
      JSON.stringify({ hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'bun guard.ts PreToolUse' }] }] } }),
    );
  }

  const codexCalls = (): string[] =>
    fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-deferred-'));
    pluginsRoot = path.join(root, 'plugins');
    home = path.join(root, 'runtime-home');
    log = path.join(root, 'codex-calls.tsv');
    fs.mkdirSync(path.join(root, 'bin'));
    fs.writeFileSync(path.join(root, 'bin', 'codex'), FAKE_PLUGIN_CODEX, { mode: 0o755 });
    process.env.PATH = `${path.join(root, 'bin')}:${savedPath}`;
    process.env.FAKE_CODEX_LOG = log;
    delete process.env.FAKE_PLUGIN_ADD_FAILS;
    fs.mkdirSync(home, { recursive: true });
    // What the boot leaves: the runtime config and no plugins.
    fs.writeFileSync(path.join(home, 'config.toml'), '[features]\nhooks = true\n');
  });

  afterEach(() => {
    process.env.PATH = savedPath;
    delete process.env.FAKE_CODEX_LOG;
    if (savedFails === undefined) delete process.env.FAKE_PLUGIN_ADD_FAILS;
    else process.env.FAKE_PLUGIN_ADD_FAILS = savedFails;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('boot hands out no runnable home: CODEX_HOME is a nonexistent pending path until the first codex call', () => {
    const env = codexRuntimeEnv('/home/node/.codex-runtime');
    expect(env.CODEX_HOME).toBe(PENDING_CODEX_HOME);
    expect(fs.existsSync(PENDING_CODEX_HOME)).toBe(false);
    expect(path.basename(env.NANOCLAW_CODEX_REGISTER)).toBe('codex-plugin-registration.ts');
    expect(fs.existsSync(env.NANOCLAW_CODEX_REGISTER)).toBe(true);
    expect(codexRuntimeEnv(FAILED_CODEX_HOME)).toEqual({ CODEX_HOME: FAILED_CODEX_HOME });
  });

  it('registers on the first call only: the next call finds the home ready and runs no codex', () => {
    addPlugin('humanizer', 'humanizer', 'humanizer');

    expect(
      completeDeferredCodexRegistration({ home, pluginsRoot, fallbackHomes: [], systemHooksPath: SYSTEM_HOOKS }),
    ).toBe(home);
    expect(
      completeDeferredCodexRegistration({ home, pluginsRoot, fallbackHomes: [], systemHooksPath: SYSTEM_HOOKS }),
    ).toBe(home);

    expect(codexCalls().map((line) => line.split('\t')[1])).toEqual([
      `plugin marketplace add ${path.join(pluginsRoot, 'humanizer')}`,
      'plugin add humanizer@humanizer',
    ]);
    expect(fs.readFileSync(path.join(home, 'config.toml'), 'utf8')).toContain('[plugins."humanizer@humanizer"]');
    // `plugin add` dropped the trust rows; the re-sync restored the plugin hook's.
    expect(trustedKeys(home)).toEqual([pluginHookKey('humanizer', 'humanizer')]);
  });

  it("adds a monorepo's marketplace once for all of its sub-plugins", () => {
    addPlugin('bootstrap', 'wwbd', 'example-bootstrap', 'wwbd');
    addPlugin('bootstrap', 'wwed', 'example-bootstrap', 'wwed');

    completeDeferredCodexRegistration({ home, pluginsRoot, fallbackHomes: [], systemHooksPath: SYSTEM_HOOKS });

    expect(codexCalls().map((line) => line.split('\t')[1])).toEqual([
      `plugin marketplace add ${path.join(pluginsRoot, 'bootstrap')}`,
      'plugin add wwbd@example-bootstrap',
      'plugin add wwed@example-bootstrap',
    ]);
  });

  it('refuses when a plugin with hooks fails to add: throws, leaves the home unready, and the next call retries', () => {
    addPlugin('humanizer', 'humanizer', 'humanizer');
    process.env.FAKE_PLUGIN_ADD_FAILS = 'humanizer@humanizer';

    expect(() =>
      completeDeferredCodexRegistration({ home, pluginsRoot, fallbackHomes: [], systemHooksPath: SYSTEM_HOOKS }),
    ).toThrow(
      /plugin registration failed for humanizer, whose hooks would not run: humanizer: plugin add failed — plugin add exploded/,
    );
    expect(fs.existsSync(path.join(home, '.nanoclaw-plugins-registered'))).toBe(false);

    delete process.env.FAKE_PLUGIN_ADD_FAILS;
    expect(
      completeDeferredCodexRegistration({ home, pluginsRoot, fallbackHomes: [], systemHooksPath: SYSTEM_HOOKS }),
    ).toBe(home);
    expect(codexCalls().filter((line) => line.endsWith('plugin add humanizer@humanizer'))).toHaveLength(2);
  });

  it('completes when only a plugin without hooks fails to add: the home loses its skills, not a guard', () => {
    addPlugin('humanizer', 'humanizer', 'humanizer');
    addPlugin('skills-only', 'skills-only', 'skills-only', undefined, false);
    process.env.FAKE_PLUGIN_ADD_FAILS = 'skills-only@skills-only';

    expect(
      completeDeferredCodexRegistration({ home, pluginsRoot, fallbackHomes: [], systemHooksPath: SYSTEM_HOOKS }),
    ).toBe(home);
    expect(fs.existsSync(path.join(home, '.nanoclaw-plugins-registered'))).toBe(true);
    expect(trustedKeys(home)).toContain(pluginHookKey('humanizer', 'humanizer'));
  });

  it('refuses when the trust re-sync after registration fails, and marks nothing registered', () => {
    addPlugin('humanizer', 'humanizer', 'humanizer');
    process.env.FAKE_BLOCK_TRUST_WRITE = '1';
    try {
      expect(() =>
        completeDeferredCodexRegistration({ home, pluginsRoot, fallbackHomes: [], systemHooksPath: SYSTEM_HOOKS }),
      ).toThrow(/could not write Codex hook trust entries/);
      expect(fs.existsSync(path.join(home, '.nanoclaw-plugins-registered'))).toBe(false);
    } finally {
      delete process.env.FAKE_BLOCK_TRUST_WRITE;
    }
  });

  it('refuses a home the boot never prepared, before running any codex', () => {
    addPlugin('humanizer', 'humanizer', 'humanizer');
    const unprepared = path.join(root, 'never-prepared');
    fs.mkdirSync(unprepared);

    expect(() =>
      completeDeferredCodexRegistration({
        home: unprepared,
        pluginsRoot,
        fallbackHomes: [],
        systemHooksPath: SYSTEM_HOOKS,
      }),
    ).toThrow(/never prepared at boot \(no config\.toml\)/);
    expect(codexCalls()).toEqual([]);
  });

  it('refuses in an image with no guard chain, before running any codex', () => {
    addPlugin('humanizer', 'humanizer', 'humanizer');

    expect(() =>
      completeDeferredCodexRegistration({
        home,
        pluginsRoot,
        fallbackHomes: [],
        systemHooksPath: '/nonexistent/etc/codex/hooks.json',
      }),
    ).toThrow(/no Codex guard chain is installed/);
    expect(codexCalls()).toEqual([]);
    expect(fs.existsSync(path.join(home, '.nanoclaw-plugins-registered'))).toBe(false);
  });

  it('projects the registered plugin tables and their trust into each fallback that holds a credential', () => {
    addPlugin('humanizer', 'humanizer', 'humanizer');
    const fallback = path.join(root, 'fallback-1');
    const bare = path.join(root, 'fallback-bare');
    fs.mkdirSync(fallback);
    fs.mkdirSync(bare);
    fs.writeFileSync(path.join(fallback, 'auth.json'), '{"account":"fallback"}');
    fs.writeFileSync(path.join(fallback, 'config.toml'), 'model = "kept"\n');
    // As at boot, but before the plugin was mounted: the fallback trusts no plugin hook.
    syncCodexHookTrust(fallback, { pluginsRoot: path.join(root, 'no-plugins') });
    expect(trustedKeys(fallback)).not.toContain(pluginHookKey('humanizer', 'humanizer'));

    completeDeferredCodexRegistration({
      home,
      pluginsRoot,
      fallbackHomes: [fallback, bare],
      systemHooksPath: SYSTEM_HOOKS,
    });

    const config = fs.readFileSync(path.join(fallback, 'config.toml'), 'utf8');
    expect(config).toContain('[plugins."humanizer@humanizer"]');
    expect(config).toContain('model = "kept"');
    expect(trustedKeys(fallback)).toEqual([pluginHookKey('humanizer', 'humanizer')]);
    expect(fs.readlinkSync(path.join(fallback, 'plugins'))).toBe(path.join(home, 'plugins'));
    expect(fs.readdirSync(bare)).toEqual([]);
  });

  it('the primary runtime still registers at start', () => {
    addPlugin('humanizer', 'humanizer', 'humanizer');

    const result = setupCodexPrimaryRuntime([], { home, pluginsRoot });

    expect(result.registered).toEqual(['humanizer']);
    expect(result.errors).toEqual([]);
    expect(codexCalls().map((line) => line.split('\t')[1])).toEqual([
      `plugin marketplace add ${path.join(pluginsRoot, 'humanizer')}`,
      'plugin add humanizer@humanizer',
    ]);
  });
});
