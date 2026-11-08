/**
 * The pull_request lane's lint step: eslint over the files a change touched, so an error fails the PR instead of the
 * deploy (the build refuses any lint error). `pnpm run lint` over the whole tree costs about 90 seconds and 3 GB on the
 * production host; this costs about 12 seconds and 1 GB, because typed lint loads the project once however few files it
 * then checks. A change that makes an untouched file fail gets past this step; ci-full.yml lints the tree.
 *
 *   pnpm exec tsx scripts/lint-changed.ts
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { findLintErrors, formatLintErrors, LINT_ROOTS } from './check-build-clean.js';

const LINTABLE = /\.(?:[cm]?[jt]s|tsx)$/;
/**
 * Changes that can fail a file the change never touched: the rules, eslint's own version, and which files the
 * TypeScript project (and so typed lint's parser) takes in. A deletion or rename counts by its old name too.
 */
const WHOLE_TREE_TRIGGER = /^(?:eslint\.config\.[cm]?[jt]s|tsconfig[^/]*\.json|pnpm-lock\.yaml)$/;

export function lintTargets(changed: string[], exists: (file: string) => boolean): string[] {
  if (changed.some((file) => WHOLE_TREE_TRIGGER.test(file))) return LINT_ROOTS;
  return changed.filter(
    (file) => LINTABLE.test(file) && LINT_ROOTS.some((root) => file.startsWith(root)) && exists(file),
  );
}

function changedPaths(root: string): string[] {
  const git = (args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const base = git(['merge-base', 'HEAD', 'origin/main']).trim();
  // --no-renames lists a rename as its deletion and its addition, so both names reach lintTargets.
  return git(['diff', '--name-only', '--no-renames', '-z', base, 'HEAD']).split('\0').filter(Boolean);
}

function main(): number {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const targets = lintTargets(changedPaths(root), (file) => fs.existsSync(path.join(root, file)));
  if (targets.length === 0) {
    console.log('lint-changed: nothing to lint');
    return 0;
  }
  console.log(`lint-changed: ${targets.length} target(s)`);
  const found = findLintErrors(targets, root);
  if ('failure' in found) {
    console.error(`lint-changed: eslint ${found.failure}`);
    return 1;
  }
  if (found.errors.length === 0) return 0;
  console.error(
    `lint-changed: ${found.errors.length} error(s)`,
    ...['', ...formatLintErrors(found.errors)].map((l) => `\n${l}`),
  );
  return 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main());
