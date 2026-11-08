import fs from 'fs';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DATA_DIR, TEST_GROUPS_DIR } = vi.hoisted(() => ({
  TEST_DATA_DIR: uniqueTmpRoot('folder-db-env'),
  TEST_GROUPS_DIR: uniqueTmpRoot('folder-db-env-groups'),
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

import { buildContainerArgs } from './container-runner.js';
import { closeDb, initMigratedTestDb } from './db/index.js';

async function forwardedDbEnv(folder: string, credentialFolder?: string): Promise<string[]> {
  const agentGroup = { id: `ag-${folder}`, name: folder, folder, agent_provider: null, created_at: '' };
  const config = {
    mcpServers: {},
    packages: { apt: [], npm: [] },
    additionalMounts: [],
    skills: 'all' as const,
    credentialFolder,
  };
  const args = await buildContainerArgs([], 'c', 's', agentGroup, config, 'claude', {});
  return args.filter((arg) => /RENDER_(PG|REDIS)/.test(arg)).sort();
}

describe('folder database env at spawn', () => {
  beforeEach(async () => {
    await initMigratedTestDb();
    for (const folder of ['example', 'example-labs', 'other-org']) {
      fs.mkdirSync(path.join(TEST_GROUPS_DIR, folder), { recursive: true });
    }
    vi.stubEnv('GITHUB_TOKEN', 'dummy');
    vi.stubEnv('RENDER_PG_URL_EXAMPLE_MAIN', 'postgres://example');
    vi.stubEnv('RENDER_PG_URL_EXAMPLE_LABS_MAIN', 'postgres://example-labs');
    vi.stubEnv('RENDER_REDIS_URL_EXAMPLE_LABS_CACHE', 'redis://example-labs');
    vi.stubEnv('RENDER_PG_URL_OTHER_ORG_MAIN', 'postgres://other-org');
    vi.stubEnv('RENDER_PG_URL_OTHER_EXAMPLE_LABS_MAIN', 'postgres://other-example-labs');
    vi.stubEnv('RENDER_PG_URL_EXAMPLE_LABS_EMPTY', '');
    vi.stubEnv('HOST_ONLY_RENDER_PG_URL_EXAMPLE_LABS_OWNER', 'postgres://owner');
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await closeDb();
  });

  it('delivers a folder its own connection strings and nothing of another folder', async () => {
    expect(await forwardedDbEnv('example-labs')).toEqual([
      'RENDER_PG_URL_EXAMPLE_LABS_MAIN=postgres://example-labs',
      'RENDER_REDIS_URL_EXAMPLE_LABS_CACHE=redis://example-labs',
    ]);
    expect(await forwardedDbEnv('other-org')).toEqual(['RENDER_PG_URL_OTHER_ORG_MAIN=postgres://other-org']);
  });

  it('gives a shorter folder nothing of a longer folder that starts with the same name', async () => {
    expect(await forwardedDbEnv('example')).toEqual(['RENDER_PG_URL_EXAMPLE_MAIN=postgres://example']);
  });

  it('keys on the credential folder, so a sibling receives what its source group receives', async () => {
    expect(await forwardedDbEnv('example-labs-reviewer', 'example-labs')).toEqual(await forwardedDbEnv('example-labs'));
  });

  it('gives nothing to a folder whose name only appears inside another folder token', async () => {
    expect(await forwardedDbEnv('labs')).toEqual([]);
  });
});
