/**
 * A host-private, blobless mirror of a migration target's repository under `data/approved-run/repos/`. Agents can't
 * write to it, so its refs and config can't be planted, and git runs there with hooks off. Every read names a full
 * commit, and a commit counts only once it is an ancestor of develop or main as just fetched.
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { APPROVED_RUN_DIR } from './targets.js';

const GIT_TIMEOUT_MS = 120_000;
const MAX_BLOB_BYTES = 8 * 1024 * 1024;
const NO_ATTRIBUTES = '* -export-subst -export-ignore -ident -text -eol -filter -diff -merge -working-tree-encoding\n';
const fetches = new Map<string, Promise<unknown>>();

export interface RepoReader {
  /** Fetches develop and main from the remote. */
  refresh(): Promise<void>;
  /** The first of develop and main the commit is on, as last fetched; null when it is on neither. */
  branchOf(commit: string): Promise<'develop' | 'main' | null>;
  /** The file's bytes at that commit, or null when the commit has no such file. */
  blob(commit: string, file: string): Promise<Buffer | null>;
  /** The git blob id of the file at that commit, or null when there is none. */
  blobId(commit: string, file: string): Promise<string | null>;
  /** The names of the entries in that directory at that commit. */
  names(commit: string, dir: string): Promise<string[]>;
  /** Writes those paths, as they are at that commit, under `into`. */
  extract(commit: string, paths: string[], into: string): Promise<void>;
}

// Only what git and its credential helper need: the host's own proxy would send github.com through the gateway.
function gitEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
  };
}

function git(dir: string, args: string[], encoding: 'utf8' | 'buffer' = 'utf8'): Promise<string | Buffer> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-C', dir, '-c', 'core.hooksPath=/dev/null', ...args],
      { env: gitEnv(), timeout: GIT_TIMEOUT_MS, maxBuffer: MAX_BLOB_BYTES, encoding },
      (err, stdout, stderr) => {
        if (err) {
          const detail = String(stderr || err.message)
            .trim()
            .split('\n')
            .pop();
          reject(Object.assign(new Error(`git ${args[0]} failed: ${detail}`), { exitCode: err.code }));
        } else resolve(stdout);
      },
    );
  });
}

export function repoReader(
  repo: string,
  url = `https://github.com/${repo}.git`,
  root = path.join(APPROVED_RUN_DIR, 'repos'),
): RepoReader {
  const dir = path.join(root, `${repo.replace('/', '--')}.git`);
  const ready = async (): Promise<void> => {
    if (fs.existsSync(path.join(dir, 'HEAD'))) return;
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    await git(dir, ['init', '--bare', '--quiet']);
    await git(dir, ['remote', 'add', 'origin', url]);
    await git(dir, ['config', 'remote.origin.promisor', 'true']);
    await git(dir, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
    // The commit's own .gitattributes would let `git archive` rewrite a file after its blob was hashed.
    fs.mkdirSync(path.join(dir, 'info'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'info', 'attributes'), NO_ATTRIBUTES);
  };
  const fetchBranches = async (): Promise<void> => {
    await ready();
    await git(dir, [
      'fetch',
      '--quiet',
      '--no-tags',
      '--prune',
      '--filter=blob:none',
      'origin',
      '+refs/heads/develop:refs/heads/develop',
      '+refs/heads/main:refs/heads/main',
    ]);
  };
  return {
    async refresh() {
      const prior = fetches.get(dir) ?? Promise.resolve();
      const next = prior.then(
        () => fetchBranches(),
        () => fetchBranches(),
      );
      fetches.set(
        dir,
        next.catch(() => undefined),
      );
      await next;
    },
    async branchOf(commit) {
      for (const branch of ['develop', 'main'] as const) {
        try {
          await git(dir, ['merge-base', '--is-ancestor', commit, `refs/heads/${branch}`]);
          return branch;
          // eslint-disable-next-line no-catch-all/no-catch-all -- exit 1 means not an ancestor; an unknown commit fails the same way
        } catch {
          continue;
        }
      }
      return null;
    },
    async blob(commit, file) {
      try {
        await git(dir, ['cat-file', '-e', `${commit}:${file}`]);
        // eslint-disable-next-line no-catch-all/no-catch-all -- a commit without the file is an answer, not an error
      } catch {
        return null;
      }
      return (await git(dir, ['cat-file', 'blob', `${commit}:${file}`], 'buffer')) as Buffer;
    },
    async blobId(commit, file) {
      try {
        return String(await git(dir, ['rev-parse', '--verify', '--quiet', `${commit}:${file}`])).trim() || null;
        // eslint-disable-next-line no-catch-all/no-catch-all -- a commit without the file is an answer, not an error
      } catch {
        return null;
      }
    },
    async names(commit, folder) {
      const out = String(await git(dir, ['ls-tree', '--name-only', `${commit}:${folder}`]));
      return out.split('\n').filter(Boolean);
    },
    async extract(commit, paths, into) {
      fs.mkdirSync(into, { recursive: true, mode: 0o700 });
      const tar = path.join(into, '..', 'tree.tar');
      await git(dir, ['archive', '--format=tar', `--output=${tar}`, commit, '--', ...paths]);
      await new Promise<void>((resolve, reject) => {
        execFile('tar', ['-xf', tar, '-C', into, '--no-same-owner'], { timeout: GIT_TIMEOUT_MS }, (err) =>
          err ? reject(err) : resolve(),
        );
      });
      fs.rmSync(tar, { force: true });
    },
  };
}
