import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, TEST_GROUPS_DIR, applySecrets } = vi.hoisted(() => ({
  TEST_DATA_DIR: uniqueTmpRoot('typesafe-spawn-env'),
  TEST_GROUPS_DIR: uniqueTmpRoot('typesafe-spawn-env-groups'),
  applySecrets: vi.fn(async () => undefined),
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
  applyOnecliSecrets: applySecrets,
}));

import { buildContainerArgs } from './container-runner.js';
import { closeDb, initMigratedTestDb } from './db/index.js';
import { __resetCachesForTest, __setSecretsCacheForTest } from './onecli-secrets.js';

describe('TypeSafe grant at spawn', () => {
  beforeEach(async () => {
    await initMigratedTestDb();
    fs.mkdirSync(path.join(TEST_GROUPS_DIR, 'example'), { recursive: true });
    vi.stubEnv('GITHUB_TOKEN', 'dummy');
    __setSecretsCacheForTest([
      {
        id: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
        name: 'TypeSafe',
        type: 'generic',
        hostPattern: 'api.typesafe.ai',
        pathPattern: null,
      },
    ] as never);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    applySecrets.mockClear();
    __resetCachesForTest();
    await closeDb();
  });

  it('puts no TYPESAFE_API_KEY in a Claude container that holds the grant', async () => {
    const agentGroup = { id: 'ag-example', name: 'example', folder: 'example', agent_provider: null, created_at: '' };
    const config = {
      mcpServers: {},
      packages: { apt: [], npm: [] },
      additionalMounts: [],
      skills: 'all' as const,
      onecliSecrets: ['TypeSafe'],
    };

    const args = await buildContainerArgs([], 'c', 's', agentGroup, config, 'claude', {}, agentGroup.id);

    expect(applySecrets).toHaveBeenCalledWith(agentGroup.id, ['TypeSafe']);
    expect(args.filter((arg) => arg.startsWith('TYPESAFE_API_KEY'))).toEqual([]);
  });
});
