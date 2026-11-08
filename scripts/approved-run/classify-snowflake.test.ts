/**
 * Runs the Snowflake classifier's own suite against the snow install it pins, named by APPROVED_RUN_SNOW_ROOT (the
 * target's `classifier.snowRoot`). Without a readable install every file is refused and the suite cannot say anything,
 * so it is skipped rather than failed; CI runners cannot read this host's install yet.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const snowRoot = process.env.APPROVED_RUN_SNOW_ROOT ?? '';

function readable(p: string): boolean {
  if (!p) return false;
  try {
    fs.accessSync(p, fs.constants.R_OK);
    return true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- any failure means the pinned install is not usable here
  } catch {
    return false;
  }
}

describe('classify_snowflake.py', () => {
  it.skipIf(!readable(snowRoot))(
    'passes its own suite against the pinned snow install (skipped unless APPROVED_RUN_SNOW_ROOT names a readable one)',
    () => {
      const r = spawnSync('python3', ['-I', path.join(DIR, 'test_classify_snowflake.py')], {
        cwd: DIR,
        encoding: 'utf8',
        timeout: 600_000,
        env: { PATH: process.env.PATH ?? '/usr/bin:/bin', APPROVED_RUN_SNOW_ROOT: snowRoot },
      });
      expect(r.stderr.trim().split('\n').at(-1)).toBe('OK');
      expect(r.status).toBe(0);
    },
    660_000,
  );
});
