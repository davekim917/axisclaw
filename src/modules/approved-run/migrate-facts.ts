/**
 * What the repository itself says about each proposed migration, answered at the proposal's commit by the
 * repository's own facts module: whether its rules refuse the file as raw SQL, its safety classes, and its
 * irreversible statements. The code runs in a sandbox with no network and no credentials.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import type { RepoReader } from './migrate-repo.js';
import { migrationPath, type MigrationProposal } from './migrate-request.js';
import { SANDBOX_IMAGE, docker, sandboxArgs, type Docker } from './migrate-sandbox.js';
import { APPROVED_RUN_DIR, type MigrateTarget } from './targets.js';

const FACTS_TIMEOUT_MS = 60_000;

export interface MigrationFacts {
  /** Why the repository's own rules say this file must not be applied as raw SQL; null when they don't. */
  refuse: string | null;
  classes: Array<{ name: string; why: string }>;
  irreversible: string[];
}

const SCRIPT = `
const { module, root, files, folders } = JSON.parse(process.argv[process.argv.length - 1]);
const { approvedRunFacts } = await import(module);
process.stdout.write(JSON.stringify(await approvedRunFacts({ root, files, folders })));
`;

function oneFact(raw: unknown): MigrationFacts | null {
  const f = raw as Partial<MigrationFacts> | null;
  if (
    !f ||
    (f.refuse !== null && typeof f.refuse !== 'string') ||
    !Array.isArray(f.classes) ||
    !f.classes.every((c) => c && typeof c.name === 'string' && typeof c.why === 'string') ||
    !Array.isArray(f.irreversible) ||
    !f.irreversible.every((s) => typeof s === 'string')
  ) {
    return null;
  }
  return { refuse: f.refuse, classes: f.classes, irreversible: f.irreversible };
}

function parseFacts(text: string, count: number): MigrationFacts[] | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
    // eslint-disable-next-line no-catch-all/no-catch-all -- output that is not JSON is reported as unreadable facts
  } catch {
    return null;
  }
  if (!Array.isArray(raw) || raw.length !== count) return null;
  const facts = raw.map(oneFact);
  return facts.every((f): f is MigrationFacts => f !== null) ? facts : null;
}

export async function migrationFacts(
  target: MigrateTarget,
  repo: RepoReader,
  p: MigrationProposal,
  run: Docker = docker,
  root = path.join(APPROVED_RUN_DIR, 'facts'),
): Promise<MigrationFacts[] | { error: string }> {
  const id = randomUUID();
  const tree = path.join(root, id, 'tree');
  const { layout } = target;
  const files = p.files.map((f) => ({
    migration: f.migration,
    path: migrationPath(target, f),
    checked: target.checked.includes(f.database),
  }));
  const checkedFolders = [
    ...new Set(p.files.filter((f) => target.checked.includes(f.database)).map((f) => target.folders[f.database])),
  ];
  try {
    await repo.extract(
      p.commit,
      [...new Set([...layout.extract, layout.factsModule, ...files.map((f) => f.path)])],
      tree,
    );
    const folders: Record<string, string[]> = {};
    for (const folder of checkedFolders) {
      folders[folder] = (await repo.names(p.commit, folder))
        .filter((n) => n.endsWith('.sql'))
        .map((n) => n.slice(0, -4));
    }
    const config = { module: `/work/${layout.factsModule}`, root: '/work', files, folders };
    const name = `nanoclaw-approved-run-facts-${id}`;
    const r = await run(
      [...sandboxArgs(name, tree, 'none'), SANDBOX_IMAGE, '--input-type=module', '-e', SCRIPT, JSON.stringify(config)],
      name,
      FACTS_TIMEOUT_MS,
    );
    const facts = r.code === 0 ? parseFacts(r.stdout, files.length) : null;
    if (!facts) {
      const why = r.overflowed
        ? 'it printed too much output'
        : r.timedOut
          ? 'it timed out'
          : (r.stderr.trim().split('\n').pop() ?? '').slice(0, 200) || `exit ${r.code}`;
      return {
        error: `the repository's own checks (${path.posix.basename(layout.factsModule)}) could not be read at this commit: ${why}`,
      };
    }
    return facts;
  } finally {
    fs.rmSync(path.join(root, id), { recursive: true, force: true });
  }
}
