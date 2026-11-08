import * as fs from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';

import { migrationFacts } from './migrate-facts.js';
import type { RepoReader } from './migrate-repo.js';
import type { MigrationProposal } from './migrate-request.js';
import type { Docker, Spawned } from './migrate-sandbox.js';
import { MIGRATE_TARGET } from '../../test-fixtures/migrate-target.js';

const ROOT = uniqueTmpRoot('test-migrate-facts');
const PROPOSAL: MigrationProposal = {
  commit: 'a'.repeat(40),
  goLink: 'https://example.invalid/go',
  files: [
    { database: 'app', migration: '301_add_widgets', sha256: 'b'.repeat(64) },
    { database: 'hub', migration: '090_add_sprockets', sha256: 'c'.repeat(64) },
  ],
};
const FACT = { refuse: null, classes: [{ name: 'operator', why: 'needs a window' }], irreversible: [] };

let extracted: string[];
let seen: { args: string[]; network: string } | null;
const repo: RepoReader = {
  refresh: async () => undefined,
  branchOf: async () => 'develop',
  blob: async () => null,
  blobId: async () => null,
  names: async () => ['300_old.sql', '301_add_widgets.sql', 'safety.json'],
  extract: async (_c, paths, into) => {
    extracted = paths;
    fs.mkdirSync(into, { recursive: true });
  },
};

function sandbox(result: Partial<Spawned>): Docker {
  return async (args) => {
    seen = { args, network: args[args.indexOf('--network') + 1] };
    return { code: 0, timedOut: false, overflowed: false, stdout: '', stderr: '', ...result };
  };
}

afterEach(() => {
  seen = null;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('migrationFacts', () => {
  it("reads each file's facts in a no-network sandbox from that commit's own files, and leaves nothing behind", async () => {
    const facts = await migrationFacts(
      MIGRATE_TARGET,
      repo,
      PROPOSAL,
      sandbox({ stdout: JSON.stringify([FACT, FACT]) }),
      ROOT,
    );
    expect(facts).toEqual([FACT, FACT]);
    expect(seen?.network).toBe('none');
    expect(JSON.parse(seen!.args.at(-1)!)).toEqual({
      module: '/work/tools/migrate/facts.mjs',
      root: '/work',
      folders: { 'backend/migrations': ['300_old', '301_add_widgets'] },
      files: [
        { migration: '301_add_widgets', path: 'backend/migrations/301_add_widgets.sql', checked: true },
        { migration: '090_add_sprockets', path: 'registry/migrations/090_add_sprockets.sql', checked: false },
      ],
    });
    expect(extracted).toContain('tools/migrate/facts.mjs');
    expect(fs.readdirSync(ROOT)).toEqual([]);
  });

  it.each<[string, Partial<Spawned>, RegExp]>([
    ['a failing script', { code: 1, stderr: 'loading\nSyntaxError: bad token\n' }, /SyntaxError: bad token$/],
    ['a timeout', { code: null, timedOut: true }, /it timed out$/],
    ['output past the cap', { code: 130, overflowed: true }, /printed too much output$/],
    ['one fact too few', { stdout: JSON.stringify([FACT]) }, /could not be read/],
    ['a fact of the wrong shape', { stdout: JSON.stringify([FACT, { ...FACT, refuse: 7 }]) }, /could not be read/],
    ['output that is not JSON', { stdout: 'warning: deprecated' }, /could not be read/],
  ])('reports %s as an error, never as facts', async (_name, result, reason) => {
    const facts = await migrationFacts(MIGRATE_TARGET, repo, PROPOSAL, sandbox(result), ROOT);
    expect('error' in facts && facts.error).toMatch(reason);
  });
});
