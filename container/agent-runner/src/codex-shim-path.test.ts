import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { withCodexShimPath } from './codex-shim-path.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function shimDir(mode: number | null): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shim-'));
  dirs.push(dir);
  if (mode !== null) fs.writeFileSync(path.join(dir, 'codex'), '#!/bin/sh\n', { mode });
  return dir;
}

describe('withCodexShimPath', () => {
  it('puts a runnable shim first, once, ahead of the real codex', () => {
    const dir = shimDir(0o755);
    expect(withCodexShimPath('/pnpm:/usr/bin', dir)).toBe(`${dir}:/pnpm:/usr/bin`);
    expect(withCodexShimPath(`/pnpm:${dir}:/usr/bin`, dir)).toBe(`${dir}:/pnpm:/usr/bin`);
    expect(withCodexShimPath(undefined, dir)).toBe(dir);
  });

  it('leaves PATH as it was when the shim is missing or cannot run', () => {
    expect(withCodexShimPath('/pnpm:/usr/bin', shimDir(null))).toBe('/pnpm:/usr/bin');
    expect(withCodexShimPath('/pnpm:/usr/bin', shimDir(0o644))).toBe('/pnpm:/usr/bin');
    expect(withCodexShimPath(undefined, path.join(os.tmpdir(), 'no-such-codex-shim'))).toBeUndefined();
  });
});
