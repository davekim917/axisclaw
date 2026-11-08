/**
 * Run by the codex shim and codex-exec.sh, under their lock, before each codex call in a container that deferred
 * plugin registration: the first run registers, later ones only confirm. Prints the home codex may run in; a non-zero
 * exit refuses the call.
 */
import fs from 'fs';
import path from 'path';

import { PLUGINS_REGISTERED_MARKER, RUNTIME_CODEX_DIR } from './codex-home-sentinel.js';

if (import.meta.main) {
  if (fs.existsSync(path.join(RUNTIME_CODEX_DIR, PLUGINS_REGISTERED_MARKER))) {
    process.stdout.write(`${RUNTIME_CODEX_DIR}\n`);
    process.exit(0);
  }
  try {
    const { completeDeferredCodexRegistration } = await import('./codex-companion-setup.js');
    // The caller's PATH leads with the codex shim; registration spawns the real binary codex-exec.sh resolved.
    const realCodex = process.env.CODEX_REAL_BIN;
    if (realCodex) process.env.PATH = `${path.dirname(realCodex)}:${process.env.PATH ?? ''}`;
    const home = completeDeferredCodexRegistration();
    process.stdout.write(`${home}\n`);
  } catch (err) {
    console.error(
      `codex: refused — Codex plugin registration did not complete in this container, so codex will not run on a ` +
        `home without its plugins and hooks: ${err instanceof Error ? err.message : String(err)}`,
    );
    process.exit(1);
  }
}
