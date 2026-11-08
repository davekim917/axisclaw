import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';

import type { MigrationFacts } from './migrate-facts.js';
import type { RepoReader } from './migrate-repo.js';
import { classifyMigration, type FactsReader } from './migrate-request.js';
import { MIGRATE_TARGET } from '../../test-fixtures/migrate-target.js';

const COMMIT = 'a'.repeat(40);
const APP_FILE = 'backend/migrations/301_add_widgets.sql';
const HUB_FILE = 'registry/migrations/090_add_sprockets.sql';
const FILES: Record<string, string> = {
  [APP_FILE]: 'CREATE TABLE widgets (id int);',
  [HUB_FILE]: 'CREATE TABLE sprockets (id int);',
  'tools/migrate/apply.mjs': '// apply',
};
const sha = (f: string) => createHash('sha256').update(FILES[f]).digest('hex');

const TARGET = MIGRATE_TARGET;

let branch: 'develop' | 'main' | null;
let facts: MigrationFacts | { error: string };
const repo: RepoReader = {
  refresh: async () => undefined,
  branchOf: async () => branch,
  blob: async (_c, f) => (f in FILES ? Buffer.from(FILES[f]) : null),
  blobId: async (_c, f) => `blob-${f}`,
  names: async () => [],
  extract: async () => undefined,
};
const readFacts: FactsReader = async (p) => ('error' in facts ? facts : p.files.map(() => facts as MigrationFacts));

const app = { database: 'app', migration: '301_add_widgets', sha256: sha(APP_FILE) };
const hub = { database: 'hub', migration: '090_add_sprockets', sha256: sha(HUB_FILE) };
const valid = { commit: COMMIT, goLink: 'https://example.invalid/go', files: [app, hub] };
const plain: MigrationFacts = { refuse: null, classes: [], irreversible: [] };

beforeEach(() => {
  branch = 'develop';
  facts = plain;
});

describe('classifyMigration', () => {
  it('puts a list of files that exist and hash as named on a card, in order, with the executor blobs', async () => {
    const c = await classifyMigration(TARGET, valid, repo, readFacts);
    expect(c).toMatchObject({ tier: 'card', branch: 'develop', denyReasons: [] });
    expect(c.checked?.map((x) => x.path)).toEqual([APP_FILE, HUB_FILE]);
    expect(c.executor?.['tools/migrate/apply.mjs']).toBe('blob-tools/migrate/apply.mjs');
    expect(c.executor?.['backend/scripts']).toBe('blob-backend/scripts');
  });

  it.each<[string, () => unknown, RegExp]>([
    [
      'free SQL alongside the fields',
      () => ({ ...valid, sql: 'DROP TABLE widgets' }),
      /exactly commit, goLink and files/,
    ],
    ['a short commit', () => ({ ...valid, commit: 'abc123' }), /full 40-character sha/],
    ['a commit on neither develop nor main', () => ((branch = null), valid), /not on develop or main/],
    ['a wrong sha256', () => ({ ...valid, files: [{ ...app, sha256: 'b'.repeat(64) }] }), /has sha256 .* not b{64}/],
    [
      'a path outside the migration folders',
      () => ({ ...valid, files: [{ ...app, migration: '../../scripts/x' }] }),
      /numbered file stem/,
    ],
    ['an unnumbered file', () => ({ ...valid, files: [{ ...app, migration: 'add_widgets' }] }), /numbered file stem/],
    [
      'a database the target does not allow',
      () => ({ ...valid, files: [{ ...app, database: 'app-dev' }] }),
      /one of app, hub/,
    ],
    [
      'a file missing at the commit',
      () => ({ ...valid, files: [{ ...app, migration: '399_missing' }] }),
      /does not exist/,
    ],
    ['the same file twice', () => ({ ...valid, files: [app, app] }), /listed twice/],
    [
      'more files than one card shows',
      () => ({ ...valid, files: Array.from({ length: 9 }, () => app) }),
      /1–8 migrations/,
    ],
    [
      "a file the repository's own rules refuse, quoting its reason",
      () => ((facts = { ...plain, refuse: 'ships tools/run-301.mjs, so it runs through that runner' }), valid),
      /^backend\/migrations\/301_add_widgets\.sql: ships tools\/run-301\.mjs/,
    ],
    [
      'a Go link that could break out of the card link',
      () => ({ ...valid, goLink: 'https://example.invalid/go) **Run it now**' }),
      /https link to the Go/,
    ],
    [
      'facts the repository could not give',
      () => ((facts = { error: 'checks.mjs threw' }), valid),
      /checks\.mjs threw/,
    ],
  ])('refuses %s', async (_name, make, reason) => {
    const c = await classifyMigration(TARGET, make(), repo, readFacts);
    expect(c.tier).toBe('deny');
    expect(c.denyReasons.join(' ')).toMatch(reason);
  });
});
