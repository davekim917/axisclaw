import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, TEST_GROUPS_DIR } = vi.hoisted(() => ({
  TEST_DATA_DIR: uniqueTmpRoot('dbt-cloud-spawn-env'),
  TEST_GROUPS_DIR: uniqueTmpRoot('dbt-cloud-spawn-env-groups'),
}));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_DATA_DIR,
  GROUPS_DIR: TEST_GROUPS_DIR,
}));

vi.mock('./onecli-apply.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./onecli-apply.js')>()),
  applyOnecliContainerConfig: async () => ({ applied: true, attempts: 1, durationsMs: [0], attemptDiagnoses: [] }),
}));

vi.mock('./onecli-secrets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./onecli-secrets.js')>()),
  ensureOnecliAgent: async () => ({ created: false }),
  applyOnecliSecrets: async () => undefined,
}));

import { buildContainerArgs } from './container-runner.js';
import { closeDb, initMigratedTestDb } from './db/index.js';

const FOLDER = 'example-dbt';
const SCOPE = 'EXAMPLE_DBT';
const FAKE_TOKEN = 'dbtu_fixture0000000000000000000000000000';

describe('dbt Cloud token at spawn', () => {
  beforeEach(async () => {
    await initMigratedTestDb();
    fs.mkdirSync(path.join(TEST_GROUPS_DIR, FOLDER), { recursive: true });
    vi.stubEnv('GITHUB_TOKEN', 'dummy');
    vi.stubEnv(`DBT_CLOUD_API_TOKEN_${SCOPE}`, FAKE_TOKEN);
    vi.stubEnv(`DBT_CLOUD_API_URL_${SCOPE}`, 'https://ab123.us1.dbt.example');
    vi.stubEnv(`DBT_CLOUD_ACCOUNT_ID_${SCOPE}`, '101');
    vi.stubEnv(`DBT_HOST_${SCOPE}`, 'us1.dbt.example');
    vi.stubEnv(`DBT_PROD_ENV_ID_${SCOPE}`, '202');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeDb();
  });

  it('gives the container and dbt-mcp only the gateway placeholder, never the host token', async () => {
    const agentGroup = { id: 'ag-example-dbt', name: FOLDER, folder: FOLDER, agent_provider: null, created_at: '' };
    const config = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
      tools: ['dbt-mcp'],
    };

    const args = await buildContainerArgs([], 'c', 's', agentGroup, config, 'claude', {}, agentGroup.id);

    expect(args.filter((arg) => arg.includes(FAKE_TOKEN))).toEqual([]);
    expect(args).toContain('DBT_CLOUD_API_TOKEN=onecli-managed');
    const mcpEnv = args.find((arg) => arg.startsWith('NANOCLAW_MCP_SERVERS='));
    const dbtMcp = JSON.parse(mcpEnv!.slice('NANOCLAW_MCP_SERVERS='.length))['dbt-mcp'];
    expect(dbtMcp.env).toMatchObject({
      DBT_HOST: 'us1.dbt.example',
      DBT_TOKEN: 'onecli-managed',
      DBT_PROD_ENV_ID: '202',
      DBT_ACCOUNT_ID: '101',
      DISABLE_DBT_CLI: 'true',
      DISABLE_LSP: 'true',
      DISABLE_SQL: 'true',
      DISABLE_TOOLS: 'trigger_job_run,cancel_job_run,retry_job_run,search,get_related_models',
    });
    expect(Object.keys(dbtMcp.env).filter((key) => key.startsWith('DBT_MCP_ENABLE_'))).toEqual([]);
    expect(dbtMcp.env).not.toHaveProperty('DISABLE_ADMIN_API');
  });

  it('turns the Admin API toolset off when the group has no account id, and forwards no user or dev env id', async () => {
    vi.stubEnv(`DBT_CLOUD_ACCOUNT_ID_${SCOPE}`, '');
    vi.stubEnv(`DBT_USER_ID_${SCOPE}`, '303');
    vi.stubEnv(`DBT_DEV_ENV_ID_${SCOPE}`, '404');
    const agentGroup = { id: 'ag-example-dbt', name: FOLDER, folder: FOLDER, agent_provider: null, created_at: '' };
    const config = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
      tools: ['dbt-mcp'],
    };

    const args = await buildContainerArgs([], 'c', 's', agentGroup, config, 'claude', {}, agentGroup.id);

    const mcpEnv = args.find((arg) => arg.startsWith('NANOCLAW_MCP_SERVERS='));
    const dbtMcp = JSON.parse(mcpEnv!.slice('NANOCLAW_MCP_SERVERS='.length))['dbt-mcp'];
    expect(dbtMcp.env).toMatchObject({ DISABLE_ADMIN_API: 'true' });
    expect(dbtMcp.env).not.toHaveProperty('DBT_ACCOUNT_ID');
    expect(dbtMcp.env).not.toHaveProperty('DBT_USER_ID');
    expect(dbtMcp.env).not.toHaveProperty('DBT_DEV_ENV_ID');
    expect(args.filter((arg) => /^DBT_(USER_ID|DEV_ENV_ID)=/.test(arg))).toEqual([]);
  });
});
