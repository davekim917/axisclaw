import fs from 'fs';
import path from 'path';

/** The rotation shim from the read-only skills mount; its `codex exec` moves to a guarded fallback at a usage limit. */
export const CODEX_SHIM_DIR = '/app/skills/pr-review-loop/scripts/codex-bin';

/**
 * For the agent's own shells only, never the runner's `process.env`: the runner spawns codex itself and must keep
 * resolving the real binary. A missing or unreadable mount leaves PATH as it was, so plain codex still runs.
 */
export function withCodexShimPath(pathVar: string | undefined, shimDir: string = CODEX_SHIM_DIR): string | undefined {
  try {
    fs.accessSync(path.join(shimDir, 'codex'), fs.constants.X_OK);
    // eslint-disable-next-line no-catch-all/no-catch-all -- any reason the shim cannot run means plain codex, never a broken PATH
  } catch {
    return pathVar;
  }
  const rest = (pathVar ?? '').split(':').filter((dir) => dir && dir !== shimDir);
  return [shimDir, ...rest].join(':');
}
