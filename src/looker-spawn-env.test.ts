import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, TEST_GROUPS_DIR } = vi.hoisted(() => ({
  TEST_DATA_DIR: uniqueTmpRoot('looker-spawn-env'),
  TEST_GROUPS_DIR: uniqueTmpRoot('looker-spawn-env-groups'),
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

const FOLDER = 'example-looker';
const SCOPE = 'EXAMPLE_LOOKER';
const FAKE_CLIENT_ID = 'looker-client-id-fixture-01';
const FAKE_CLIENT_SECRET = 'looker-client-secret-fixture-02';

describe('Looker credentials at spawn', () => {
  beforeEach(async () => {
    await initMigratedTestDb();
    fs.mkdirSync(path.join(TEST_GROUPS_DIR, FOLDER), { recursive: true });
    vi.stubEnv('GITHUB_TOKEN', 'dummy');
    vi.stubEnv(`LOOKER_BASE_URL_${SCOPE}`, 'https://example.cloud.looker.test');
    vi.stubEnv(`LOOKER_CLIENT_ID_${SCOPE}`, FAKE_CLIENT_ID);
    vi.stubEnv(`LOOKER_CLIENT_SECRET_${SCOPE}`, FAKE_CLIENT_SECRET);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeDb();
  });

  it('gives the container no Looker credential, only the instance URL for the gateway-routed MCP', async () => {
    const agentGroup = { id: 'ag-example-looker', name: FOLDER, folder: FOLDER, agent_provider: null, created_at: '' };
    const config = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
      tools: ['looker'],
    };

    const args = await buildContainerArgs([], 'c', 's', agentGroup, config, 'claude', {}, agentGroup.id);

    expect(args.filter((arg) => arg.includes(FAKE_CLIENT_ID) || arg.includes(FAKE_CLIENT_SECRET))).toEqual([]);
    expect(args.filter((arg) => arg.startsWith('LOOKER_CLIENT_'))).toEqual([]);
    const mcpEnv = args.find((arg) => arg.startsWith('NANOCLAW_MCP_SERVERS='));
    expect(JSON.parse(mcpEnv!.slice('NANOCLAW_MCP_SERVERS='.length)).looker).toEqual({
      type: 'stdio',
      command: 'bun',
      args: ['/app/src/looker-mcp.ts'],
      env: { LOOKER_BASE_URL: 'https://example.cloud.looker.test' },
      timeout: 610_000,
    });
  });
});
