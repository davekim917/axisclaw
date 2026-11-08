/**
 * The read-only git proof that a checkout holds nothing worth keeping. Kept apart from worktree cleanup, which reaches
 * the container runner and the central DB, so a worker thread can load it: one proof walked a large ignored tree for
 * 5-6 s, and on the host's main thread that froze every channel for as long.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { log } from './log.js';
import { safeGitArgs, safeGitEnv, safeGitFilterNames } from './safe-git.js';

// May we recursively delete this from a live checkout? A wrong entry destroys the only copy, so only names
// whose contents are reconstructible from a version-controlled file belong here. Deliberately excluded: `dist`,
// `build`, `.next`, `coverage` (often tracked, may hold uncommitted output), `.cache` (means anything), and
// `.venv`/`venv` (an ad-hoc `pip install` venv is unique state; do not re-add it as "just a cache").
// `__pycache__` qualifies: PEP 3147 bytecode is not importable without its `.py`, so it is never the only copy.
export const REGENERABLE_SWEEP_DIR_NAMES: ReadonlySet<string> = new Set<string>([
  'node_modules',
  '.pnpm-store',
  '.turbo',
  '__pycache__',
]);

export function git(
  cwd: string,
  args: string[],
  env: NodeJS.ProcessEnv = {},
  filterNames: readonly string[] = [],
  input?: string,
): string | null {
  try {
    return execFileSync('git', safeGitArgs(args, undefined, filterNames), {
      cwd,
      env: safeGitEnv(env),
      encoding: 'utf8',
      input,
      stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      timeout: 30_000,
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Git's environment for a question about exactly one checkout. With a missing or corrupt `.git`, discovery would
 * walk up into the install's own checkout (`data/` sits inside it); the ceiling makes such a checkout unprovable.
 */
function checkoutGitEnv(dir: string): NodeJS.ProcessEnv {
  return { GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(dir)) };
}

/**
 * Every filter the repository's effective config defines, so safeGitArgs can neutralize each by name; `null` when
 * the config cannot be read. A clone's `.git` is container-writable, and `status` runs clean filters.
 */
function repositoryFilterNames(dir: string, env: NodeJS.ProcessEnv): string[] | null {
  const gitDir = git(dir, ['rev-parse', '--absolute-git-dir'], env);
  if (gitDir === null) return null;
  try {
    return safeGitFilterNames(gitDir, dir);
  } catch {
    return null;
  }
}

/**
 * Directory names under a topic's worktrees root, `[]` on ENOENT, or `null` on any other read failure: an
 * unreadable fleet must not look like a collected one. The caller counts it.
 */
export function safeDirectories(directory: string): string[] | null {
  try {
    return fs
      .readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.isSymbolicLink())
      .map((entry) => entry.name)
      .sort();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    log.warn('Worktree cleanup: worktrees root unreadable; preserving its topic', { directory, err });
    return null;
  }
}

/**
 * Ignored output a clean, fully pushed checkout may take to the trash beyond REGENERABLE_SWEEP_DIR_NAMES, which the
 * regenerable sweep deletes from live checkouts with no git proof and so must stay narrow. `dist` is not here: a
 * gh-pages clone or a hand-placed export commonly lives in it.
 */
const RECLAIM_IGNORABLE_DIR_NAMES: ReadonlySet<string> = new Set(['allure-results', '.pytest_cache', '.ruff_cache']);
const RECLAIM_IGNORABLE_FILE_SUFFIX = '.tsbuildinfo';
const NESTED_REPOSITORY_SCAN_LIMIT = 50_000;

/** No repository, `.git` or bare, anywhere under `root`; a tree too large or unreadable to finish refuses. */
function holdsNoRepository(root: string): boolean {
  const stack = [root];
  let seen = 0;
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return false;
    }
    const names = new Set(entries.map((entry) => entry.name));
    if (names.has('HEAD') && names.has('objects')) return false;
    for (const entry of entries) {
      if (entry.name === '.git' || ++seen > NESTED_REPOSITORY_SCAN_LIMIT) return false;
      if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(path.join(current, entry.name));
    }
  }
  return true;
}

/**
 * `entry` is a porcelain path. Git collapses a directory to one `dir/` entry when it is ignored, and also when it is
 * not but everything in it is, so a listed name counts only once `isIgnoredDirectory` says the directory itself is.
 * That question goes without the trailing slash: `check-ignore dir/` also matches `dir/*`, which ignores only the
 * contents.
 */
function reclaimIgnorable(dir: string, entry: string, isIgnoredDirectory: (entry: string) => boolean): boolean {
  const segments = entry.split('/').filter(Boolean);
  if (segments.some((segment) => REGENERABLE_SWEEP_DIR_NAMES.has(segment))) return true;
  if (!entry.endsWith('/')) return segments.at(-1)?.endsWith(RECLAIM_IGNORABLE_FILE_SUFFIX) ?? false;
  return (
    RECLAIM_IGNORABLE_DIR_NAMES.has(segments.at(-1) ?? '') &&
    isIgnoredDirectory(entry.slice(0, -1)) &&
    holdsNoRepository(path.join(dir, entry))
  );
}

/**
 * A `git worktree lock` marker makes a checkout non-disposable: the agent said "don't touch", and `worktree prune`
 * (git 2.43) keeps a locked registration even once its path is gone. No-op for a plain clone.
 */
export function isWorktreeLocked(dir: string): boolean {
  const gitDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir'], checkoutGitEnv(dir));
  return gitDir !== null && fs.existsSync(path.join(gitDir, 'locked'));
}

/**
 * Positive proof that a checkout holds nothing worth keeping; reach it through proveCheckoutDisposable. A git
 * invocation that fails (pruned admin dir, container-only gitdir) returns unprovable, never clean.
 */
export function provenDisposable(
  dir: string,
  scope: 'head' | 'all',
  inheritedTags: ReadonlyMap<string, string> | null = null,
  liveTopic = false,
): { ok: boolean; reason: string } {
  if (isWorktreeLocked(dir)) return { ok: false, reason: 'worktree-locked' };
  const env = checkoutGitEnv(dir);

  // Host git runs in a repository a container may have configured: signature programs are off and every filter
  // is neutralized by name. An embedded repository is refused before `status` could recurse into it; one whose
  // config or index cannot be read is unprovable.
  const filters = repositoryFilterNames(dir, env);
  if (filters === null) return { ok: false, reason: 'status-unprovable' };
  const modes = git(dir, ['ls-files', '-z', '--format=%(objectmode)'], env, filters);
  if (modes === null) return { ok: false, reason: 'status-unprovable' };
  if (modes.split('\0').includes('160000')) return { ok: false, reason: 'submodule' };

  const status = git(
    dir,
    ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=all'],
    env,
    filters,
  );
  if (status === null) return { ok: false, reason: 'status-unprovable' };
  if (status !== '') return { ok: false, reason: 'dirty' };
  if (liveTopic) {
    // `status` reads a skip-worktree or assume-unchanged entry as clean whatever its file holds.
    const tags = git(dir, ['ls-files', '-v', '-z'], env, filters);
    if (tags === null) return { ok: false, reason: 'status-unprovable' };
    if (tags.split('\0').some((entry) => entry !== '' && !entry.startsWith('H '))) {
      return { ok: false, reason: 'index-flagged' };
    }
    const ignored = git(
      dir,
      [
        'status',
        '--porcelain=v1',
        '-z',
        '--ignored=traditional',
        '--untracked-files=normal',
        '--ignore-submodules=all',
      ],
      env,
      filters,
    );
    if (ignored === null) return { ok: false, reason: 'status-unprovable' };
    const kept = ignored
      .split('\0')
      .filter((entry) => entry.startsWith('!! '))
      .some(
        (entry) =>
          !reclaimIgnorable(
            dir,
            entry.slice(3),
            // A leading `./` keeps a name that starts with `:` from reading as pathspec magic.
            (candidate) => git(dir, ['check-ignore', '-q', '--', `./${candidate}`], env, filters) !== null,
          ),
      );
    if (kept) return { ok: false, reason: 'ignored-files' };
  }

  const stashVerdict = (): { ok: boolean; reason: string } | null => {
    const stash = git(dir, ['stash', 'list'], env);
    if (stash === null) return { ok: false, reason: 'stash-unprovable' };
    return stash === '' ? null : { ok: false, reason: 'stashed' };
  };
  // For a clone the stash is read before the log below, which counts refs/stash too and would call it 'unpushed'.
  if (scope === 'all') {
    const stashed = stashVerdict();
    if (stashed) return stashed;
  }

  // Scope 'all': every local ref's commits must be on origin. `--all` covers tags, notes and a detached HEAD,
  // which `--branches` would miss; HEAD stays explicit because `--all` alone exits 0 silently on an unborn HEAD.
  // Only origin counts as evidence: another remote can hold commits no real remote has. Scope 'head' checks HEAD
  // against every remote-tracking ref. Exception: tags the host recorded when it built the clone, still at the
  // same object, are the canonical's (a release tag off every branch would otherwise keep every clone forever).
  // The record is host-only; matching name and object only drops roots, so a commit another ref holds still counts.
  let unpushed: string | null;
  if (scope === 'all' && inheritedTags !== null && inheritedTags.size > 0) {
    const refs = git(dir, ['for-each-ref', '--format=%(objectname) %(refname)'], env);
    if (refs === null) return { ok: false, reason: 'log-unprovable' };
    const roots = refs
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        const separator = line.indexOf(' ');
        const object = line.slice(0, separator);
        return inheritedTags.get(line.slice(separator + 1)) === object ? [] : [`${object}\n`];
      });
    unpushed = git(dir, ['log', '--oneline', 'HEAD', '--stdin', '--not', '--remotes=origin'], env, [], roots.join(''));
  } else {
    const unpushedArgs =
      scope === 'all'
        ? ['log', '--all', 'HEAD', '--not', '--remotes=origin', '--oneline']
        : ['log', 'HEAD', '--not', '--remotes', '--oneline'];
    unpushed = git(dir, unpushedArgs, env);
  }
  if (unpushed === null) return { ok: false, reason: 'log-unprovable' };
  if (unpushed !== '') return { ok: false, reason: 'unpushed' };

  if (scope === 'head') {
    const stashed = stashVerdict();
    if (stashed) return stashed;
  }

  // A clone backing linked worktrees owns their shared object store. Asked here (git's own registry) rather than
  // only at scan time, so the post-move re-proof catches a `git worktree add` made in between. Clones only.
  if (scope === 'all') {
    const gitDir = git(dir, ['rev-parse', '--path-format=absolute', '--git-dir'], env);
    if (gitDir === null) return { ok: false, reason: 'gitdir-unprovable' };
    const registered = safeDirectories(path.join(gitDir, 'worktrees'));
    // null is "exists but unreadable": unprovable, not empty.
    if (registered === null && fs.existsSync(path.join(gitDir, 'worktrees'))) {
      return { ok: false, reason: 'worktree-registry-unprovable' };
    }
    if (registered !== null && registered.length > 0) return { ok: false, reason: 'backs-worktrees' };
  }

  return { ok: true, reason: 'clean-and-pushed' };
}
