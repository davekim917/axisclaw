/**
 * `buildAgentGroupImage` must record the tag where the spawn reads it: the
 * spawn picks its image from container.json's `imageTag`, never from the
 * `container_configs` projection.
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: globalThis.uniqueTmpRoot('image-build') }));

vi.mock('./config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./config.js')>()),
  DATA_DIR: TEST_DIR,
  GROUPS_DIR: `${TEST_DIR}/groups`,
}));

const built = vi.hoisted(() => ({
  commands: [] as string[],
  dockerfiles: [] as string[],
  hold: false,
  pending: [] as (() => void)[],
}));
vi.mock('child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('child_process')>();
  const { readFileSync } = await import('fs');
  return {
    ...actual,
    exec: (command: string, _options: unknown, callback: (err: Error | null, stdout: string) => void) => {
      built.commands.push(command);
      const dockerfile = / -f (\S+) /.exec(command)?.[1];
      built.dockerfiles.push(dockerfile ? readFileSync(dockerfile, 'utf8') : '');
      if (built.hold) built.pending.push(() => callback(null, ''));
      else callback(null, '');
    },
  };
});

const baseImage = vi.hoisted(() => ({
  id: null as import('./agent-runner-image-check.js').LabelLookup | null,
}));
vi.mock('./agent-runner-image-check.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./agent-runner-image-check.js')>()),
  readBaseImageId: async () => baseImage.id,
}));

import { CONTAINER_IMAGE_BASE } from './config.js';
import { readContainerConfig, writeContainerConfig } from './container-config.js';
import { buildAgentGroupImage } from './container-runner.js';
import { createAgentGroup } from './db/agent-groups.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from './db/container-configs.js';
import { closeDb, initMigratedTestDb } from './db/index.js';

beforeEach(async () => {
  built.commands = [];
  built.dockerfiles = [];
  built.hold = false;
  built.pending = [];
  baseImage.id = { kind: 'found', value: 'sha256:base-fixture' };
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(`${TEST_DIR}/groups/agent`, { recursive: true });
  await initMigratedTestDb();
  await createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig('ag-1');
  await updateContainerConfigJson('ag-1', 'packages_apt', ['jq']);
  writeContainerConfig('agent', {
    mcpServers: {},
    packages: { apt: ['jq'], npm: [] },
    additionalMounts: [],
    skills: 'all',
    onecliSecrets: ['Keep-Me'],
  });
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('buildAgentGroupImage', () => {
  it('records the built tag in container.json AND the DB projection', async () => {
    await buildAgentGroupImage('ag-1');

    const tag = `${CONTAINER_IMAGE_BASE}:ag-1`;
    expect(built.commands).toEqual([expect.stringContaining(`build -t ${tag} `)]);
    const file = readContainerConfig('agent');
    expect(file.imageTag).toBe(tag);
    expect(file.onecliSecrets).toEqual(['Keep-Me']);
    expect((await getContainerConfig('ag-1'))!.image_tag).toBe(tag);
  });

  it('runs overlapping builds for one group one at a time, the later one from the newer package lists', async () => {
    built.hold = true;
    const first = buildAgentGroupImage('ag-1');
    await vi.waitFor(() => expect(built.commands).toHaveLength(1));

    await updateContainerConfigJson('ag-1', 'packages_apt', ['jq', 'curl']);
    const second = buildAgentGroupImage('ag-1');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(built.commands).toHaveLength(1);

    built.hold = false;
    built.pending.shift()!();
    await Promise.all([first, second]);

    expect(built.dockerfiles.at(-1)).toContain('apt-get install -y jq curl');
    expect(built.dockerfiles).toHaveLength(2);
    expect(fs.existsSync(`${TEST_DIR}/Dockerfile.ag-1`)).toBe(false);
  });

  it('builds the packages being added on top of the stored lists without storing them', async () => {
    await updateContainerConfigJson('ag-1', 'packages_apt', ['curl']);

    await buildAgentGroupImage('ag-1', { apt: ['jq', 'curl'], npm: [] });

    expect(built.dockerfiles.at(-1)).toContain('apt-get install -y curl jq');
    expect(JSON.parse((await getContainerConfig('ag-1'))!.packages_apt)).toEqual(['curl']);
  });

  it('records the base it builds on, and builds nothing when that base cannot be read', async () => {
    await buildAgentGroupImage('ag-1');
    expect(built.dockerfiles.at(-1)).toContain('LABEL nanoclaw.baseImageId="sha256:base-fixture"');

    baseImage.id = { kind: 'inspect-error', reason: 'context deadline exceeded' };
    await expect(buildAgentGroupImage('ag-1')).rejects.toThrow('context deadline exceeded');
    expect(built.commands).toHaveLength(1);
  });

  it('lets the next queued build run after one fails', async () => {
    await updateContainerConfigJson('ag-1', 'packages_apt', []);
    await expect(buildAgentGroupImage('ag-1')).rejects.toThrow('No packages to install');

    await updateContainerConfigJson('ag-1', 'packages_apt', ['jq']);
    await buildAgentGroupImage('ag-1');
    expect(built.commands).toHaveLength(1);
  });
});
