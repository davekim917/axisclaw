/**
 * Codex 0.163 keeps every session rollout under `<home>/sessions/YYYY/MM/DD/` forever (it only compresses older ones
 * to `.jsonl.zst`), and since reviews stopped running `--ephemeral` each one also holds the source bundle it was sent.
 * Age is the file's mtime, not the date in its name, so a long-running session that is still appending is never cut.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { codexAccountRing, resolveCodexAuthDir } from './codex-accounts.js';

export const CODEX_ROLLOUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

const ROLLOUT_FILE = /^rollout-.+\.jsonl(\.zst)?$/;
const DATE_PART = [/^\d{4}$/, /^\d{2}$/, /^\d{2}$/];

export interface CodexRolloutPruneResult {
  deleted: number;
  bytes: number;
  errors: string[];
}

/** One spelling per directory, so a trailing slash or a symlinked alias cannot pass for a different home. */
function canonicalHome(home: string): string {
  try {
    return fs.realpathSync(home);
    // eslint-disable-next-line no-catch-all/no-catch-all -- a home that does not resolve is compared as written
  } catch {
    return path.resolve(home);
  }
}

/**
 * Only fallback accounts, and never `~/.codex` or a home that is any group's primary: a primary is the operator's own Codex home,
 * whose history is theirs to keep, even when another group names it as its fallback. A group whose config cannot be
 * read is reported and skipped, never a reason to skip the others.
 */
export function codexRolloutPruneHomes(
  groups: Array<{ folder: string }>,
  fallbacksOf: (folder: string) => string[] | undefined,
  homedir: string = os.homedir(),
): { homes: string[]; errors: string[] } {
  const primaries = new Set(
    [path.join(homedir, '.codex'), ...groups.map((group) => resolveCodexAuthDir(group.folder, homedir))].map(
      canonicalHome,
    ),
  );
  const homes = new Set<string>();
  const errors: string[] = [];
  for (const group of groups) {
    try {
      for (const account of codexAccountRing(group.folder, fallbacksOf(group.folder), homedir).slice(1)) {
        const home = canonicalHome(account.hostHome);
        if (!primaries.has(home)) homes.add(home);
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- one unreadable group is reported and must not stop the others
    } catch (err) {
      errors.push(`${group.folder}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return { homes: [...homes], errors };
}

/** A real directory that still resolves inside `root`: a container that can write `sessions/` may swap one for a link. */
async function realDirectories(dir: string, pattern: RegExp, root: string): Promise<string[]> {
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !pattern.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (await insideRoot(full, root)) out.push(full);
  }
  return out;
}

async function insideRoot(dir: string, root: string): Promise<boolean> {
  const stat = await fs.promises.lstat(dir).catch(() => null);
  if (!stat?.isDirectory()) return false;
  const real = await fs.promises.realpath(dir).catch(() => null);
  return real !== null && real.startsWith(root + path.sep);
}

async function removeIfEmpty(dir: string): Promise<void> {
  try {
    await fs.promises.rmdir(dir);
  } catch (err) {
    if (!['ENOTEMPTY', 'EEXIST', 'ENOENT'].includes((err as NodeJS.ErrnoException).code ?? '')) throw err;
  }
}

/** Never follows a symlink below `<home>/sessions`, and touches nothing but rollout files and the date dirs it empties. */
export async function pruneCodexRollouts(
  homes: string[],
  nowMs: number = Date.now(),
  maxAgeMs: number = CODEX_ROLLOUT_MAX_AGE_MS,
): Promise<CodexRolloutPruneResult> {
  const result: CodexRolloutPruneResult = { deleted: 0, bytes: 0, errors: [] };
  const cutoff = nowMs - maxAgeMs;
  for (const home of new Set(homes)) {
    const sessions = path.join(home, 'sessions');
    const stat = await fs.promises.lstat(sessions).catch(() => null);
    if (!stat?.isDirectory()) continue;
    try {
      const root = await fs.promises.realpath(sessions);
      for (const year of await realDirectories(sessions, DATE_PART[0], root)) {
        for (const month of await realDirectories(year, DATE_PART[1], root)) {
          for (const day of await realDirectories(month, DATE_PART[2], root)) {
            for (const entry of await fs.promises.readdir(day, { withFileTypes: true })) {
              if (!entry.isFile() || !ROLLOUT_FILE.test(entry.name)) continue;
              const file = path.join(day, entry.name);
              const fileStat = await fs.promises.lstat(file);
              if (fileStat.mtimeMs >= cutoff) continue;
              await fs.promises.unlink(file);
              result.deleted += 1;
              result.bytes += fileStat.size;
            }
            await removeIfEmpty(day);
          }
          await removeIfEmpty(month);
        }
        await removeIfEmpty(year);
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- one unreadable home is reported and must not stop the others
    } catch (err) {
      result.errors.push(`${sessions}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}
