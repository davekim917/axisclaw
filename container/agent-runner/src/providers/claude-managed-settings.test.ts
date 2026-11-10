import { describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import path from 'node:path';

/** The image copies this file to /etc/claude-code/, Claude Code's policy tier on Linux. */
const SHIPPED = new URL('../../../claude-system/managed-settings.json', import.meta.url).pathname;
const SEC_PLUGIN = 'cc-plugin-sec-default@builtin';
const MODS_LOCK = 'allowManagedModsOnly';

function bundledCli(): string {
  const pkg = path.dirname(Bun.resolveSync('@anthropic-ai/claude-agent-sdk-linux-x64/package.json', import.meta.dir));
  return path.join(pkg, 'claude');
}

describe('the container policy keeps agent-written mods from loading', () => {
  it('ships allowManagedModsOnly for the built-in security plugin', () => {
    const policy = JSON.parse(fs.readFileSync(SHIPPED, 'utf8'));
    expect(policy.pluginConfigs?.[SEC_PLUGIN]?.options?.[MODS_LOCK]).toBe(true);
  });

  it('names keys the bundled Claude Code CLI still reads', () => {
    const cli = fs.readFileSync(bundledCli());
    expect(cli.includes(Buffer.from(SEC_PLUGIN))).toBe(true);
    expect(cli.includes(Buffer.from(`policyModOptions:Object.freeze(["${MODS_LOCK}"])`))).toBe(true);
  });
});
