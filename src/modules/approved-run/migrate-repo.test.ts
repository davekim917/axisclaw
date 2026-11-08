import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../../test-hermeticity.js';
import { repoReader, type RepoReader } from './migrate-repo.js';

enforceHermeticity();
allowSubprocess(['git', 'tar']);

const ROOT = uniqueTmpRoot('test-migrate-repo');
const REMOTE = path.join(ROOT, 'remote');
const HOME_BEFORE = process.env.HOME;
let onDevelop: string;
let onMain: string;
let onFeature: string;
let withAttributes: string;
let reader: RepoReader;

function git(...args: string[]): string {
  return execFileSync('git', ['-C', REMOTE, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args], {
    env: { PATH: process.env.PATH, HOME: ROOT, GIT_CONFIG_NOSYSTEM: '1' },
    encoding: 'utf8',
  }).trim();
}

function commit(file: string, body: string): string {
  fs.mkdirSync(path.dirname(path.join(REMOTE, file)), { recursive: true });
  fs.writeFileSync(path.join(REMOTE, file), body);
  git('add', file);
  git('commit', '-q', '-m', file);
  return git('rev-parse', 'HEAD');
}

beforeAll(async () => {
  process.env.HOME = ROOT;
  fs.mkdirSync(REMOTE, { recursive: true });
  git('init', '-q', '-b', 'main');
  onMain = commit('tools/migrate/apply.mjs', '// apply');
  git('checkout', '-q', '-b', 'develop');
  onDevelop = commit('backend/migrations/301_add_widgets.sql', 'CREATE TABLE widgets (id int);');
  git('checkout', '-q', '-b', 'feature');
  onFeature = commit('backend/migrations/302_unmerged.sql', 'DROP TABLE widgets;');
  git('checkout', '-q', 'develop');
  commit('.gitattributes', '*.sql export-subst\n');
  withAttributes = commit('backend/migrations/303_substituted.sql', 'SELECT 1; -- $Format:%s$\n');
  reader = repoReader('acme/widgets', `file://${REMOTE}`, path.join(ROOT, 'mirror'));
  await reader.refresh();
});

afterAll(() => {
  process.env.HOME = HOME_BEFORE;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('repoReader', () => {
  it('names the first of develop and main a commit is on, and nothing for a commit on neither', async () => {
    expect(await reader.branchOf(onDevelop)).toBe('develop');
    expect(await reader.branchOf(onMain)).toBe('develop');
    expect(await reader.branchOf(onFeature)).toBeNull();
    expect(await reader.branchOf('f'.repeat(40))).toBeNull();
  });

  it('reads a file at a commit, and answers null for one the commit does not have', async () => {
    expect(String(await reader.blob(onDevelop, 'backend/migrations/301_add_widgets.sql'))).toBe(
      'CREATE TABLE widgets (id int);',
    );
    expect(await reader.blob(onMain, 'backend/migrations/301_add_widgets.sql')).toBeNull();
    expect(await reader.blobId(onMain, 'tools/migrate/apply.mjs')).toMatch(/^[0-9a-f]{40}$/);
    expect(await reader.blobId(onMain, 'missing.sql')).toBeNull();
    expect(await reader.names(onDevelop, 'backend/migrations')).toEqual(['301_add_widgets.sql']);
  });

  it("extracts a file byte for byte as its blob, whatever the commit's .gitattributes ask for", async () => {
    const file = 'backend/migrations/303_substituted.sql';
    const into = path.join(ROOT, 'attr', 'tree');
    await reader.extract(withAttributes, [file], into);
    expect(fs.readFileSync(path.join(into, file))).toEqual(await reader.blob(withAttributes, file));
  });

  it('runs the next fetch after a failed one instead of waiting on it forever', async () => {
    const broken = repoReader('acme/missing', `file://${path.join(ROOT, 'no-such-remote')}`, path.join(ROOT, 'mirror'));
    const first = broken.refresh();
    const second = broken.refresh();
    await expect(first).rejects.toThrow(/git fetch failed/);
    await expect(second).rejects.toThrow(/git fetch failed/);
  });

  it('extracts only the named paths, as they are at that commit', async () => {
    const into = path.join(ROOT, 'run', 'tree');
    await reader.extract(onDevelop, ['tools/migrate', 'backend/migrations/301_add_widgets.sql'], into);
    expect(fs.readFileSync(path.join(into, 'tools/migrate/apply.mjs'), 'utf8')).toBe('// apply');
    expect(fs.readdirSync(path.join(into, 'backend/migrations'))).toEqual(['301_add_widgets.sql']);
    expect(fs.existsSync(path.join(ROOT, 'run', 'tree.tar'))).toBe(false);
  });
});
