/**
 * The executor files each approved migration ran, per target, so a card can say when the code that will run with the
 * database password changed since the last approved run. Display only: an unreadable record shows as "nothing to
 * compare with", the louder of the two warnings, and never blocks a run.
 */
import fs from 'node:fs';
import path from 'node:path';

import { log } from '../../log.js';

import { APPROVED_RUN_DIR, loadTarget, type MigrateTarget } from './targets.js';

export interface ExecutorSeen {
  commit: string;
  blobs: Record<string, string | null>;
  at: string;
}

/** A run to compare with; `from` names the other target it came from, when it is not this one. */
export type Baseline = ExecutorSeen & { from?: string };

const SEEN_FILE = path.join(APPROVED_RUN_DIR, 'executor-seen.json');

function readAll(file: string): Record<string, ExecutorSeen> {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, ExecutorSeen>) : {};
    // eslint-disable-next-line no-catch-all/no-catch-all -- a missing or unreadable record means nothing to compare with
  } catch {
    return {};
  }
}

function lastExecutor(targetId: string, file = SEEN_FILE): ExecutorSeen | null {
  const seen = readAll(file)[targetId];
  return seen && typeof seen.commit === 'string' && seen.blobs && typeof seen.blobs === 'object' ? seen : null;
}

/** Watched files whose blob differs from the last approved run's. */
export function changedFiles(last: ExecutorSeen, blobs: Record<string, string | null>): string[] {
  return Object.keys(blobs).filter((f) => (last.blobs[f] ?? null) !== (blobs[f] ?? null));
}

export function recordExecutor(targetId: string, seen: ExecutorSeen, file = SEEN_FILE): void {
  try {
    const all = readAll(file);
    all[targetId] = seen;
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n', { mode: 0o600 });
    fs.renameSync(tmp, file);
    // eslint-disable-next-line no-catch-all/no-catch-all -- a record that cannot be written costs the next card's comparison, never the run
  } catch (err) {
    log.warn('Could not record the executor an approved migration ran', { targetId, err });
  }
}

const sameSet = (a: string[], b: string[]) => [...a].sort().join('\n') === [...b].sort().join('\n');

/**
 * Another target's run vouches for this one's code only if no one could approve there who cannot approve here, and
 * its record covers the same files.
 */
export function baselineFor(
  target: MigrateTarget,
  load: typeof loadTarget = loadTarget,
  file = SEEN_FILE,
): Baseline | null {
  const own = lastExecutor(target.id, file);
  if (own || !target.compareWith) return own;
  const other = load(target.compareWith);
  const why =
    'error' in other
      ? other.error
      : other.kind !== 'repo-migrate'
        ? 'it is not a migration target'
        : other.repo !== target.repo
          ? 'it reads another repository'
          : !sameSet(other.layout.watched, target.layout.watched) ||
              !sameSet(other.layout.extract, target.layout.extract)
            ? 'it records different files'
            : !other.approvers.every((a) => target.approvers.includes(a))
              ? 'it has approvers this target does not'
              : null;
  if (why || 'error' in other) {
    log.warn('A migration target cannot compare with the target it names', {
      target: target.id,
      compareWith: target.compareWith,
      why,
    });
    return null;
  }
  const theirs = lastExecutor(other.id, file);
  return theirs ? { ...theirs, from: other.id } : null;
}
