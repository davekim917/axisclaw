import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it } from 'vitest';

import { CODEX_ROLLOUT_MAX_AGE_MS, codexRolloutPruneHomes, pruneCodexRollouts } from './codex-rollout-prune.js';

const NOW = Date.parse('2026-09-30T12:00:00.000Z');
const OLD = NOW - CODEX_ROLLOUT_MAX_AGE_MS - 60_000;
const FRESH = NOW - CODEX_ROLLOUT_MAX_AGE_MS + 60_000;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function home(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-prune-'));
  roots.push(root);
  return root;
}

function put(file: string, mtimeMs: number, body = 'x'): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  return file;
}

describe('codexRolloutPruneHomes', () => {
  function account(dir: string): string {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'auth.json'), '{}');
    return dir;
  }

  it("names each group's fallback homes once and never a primary, scoped or not", () => {
    const h = home();
    account(path.join(h, '.codex'));
    account(path.join(h, '.codex-scoped-group'));
    const secondary = account(path.join(h, '.codex-secondary'));
    const third = account(path.join(h, '.codex-third'));
    const fallbacks: Record<string, string[] | undefined> = {
      'plain-group': ['~/.codex-secondary'],
      'scoped-group': ['~/.codex-secondary', '~/.codex-third'],
      'no-fallbacks': undefined,
    };

    const selected = codexRolloutPruneHomes(
      Object.keys(fallbacks).map((folder) => ({ folder })),
      (folder) => fallbacks[folder],
      h,
    );

    expect(selected).toEqual({ homes: [secondary, third], errors: [] });
  });

  it.each([
    ['as written', '~/.codex'],
    ['with a trailing slash', '~/.codex/'],
    ['through a symlinked alias', '~/.codex-alias'],
  ])(
    "never names a home that is any group's primary when another group declares it as its fallback, %s",
    (_label, declared) => {
      const h = home();
      const primary = account(path.join(h, '.codex'));
      fs.symlinkSync(primary, path.join(h, '.codex-alias'));
      account(path.join(h, '.codex-scoped-group'));
      const secondary = account(path.join(h, '.codex-secondary'));
      const fallbacks: Record<string, string[]> = {
        'plain-group': ['~/.codex-secondary'],
        'scoped-group': [declared],
      };

      const selected = codexRolloutPruneHomes(
        Object.keys(fallbacks).map((folder) => ({ folder })),
        (folder) => fallbacks[folder],
        h,
      );

      expect(selected).toEqual({ homes: [fs.realpathSync(secondary)], errors: [] });
    },
  );

  it("never names the operator's ~/.codex, even when every group has its own scoped primary", () => {
    const h = home();
    account(path.join(h, '.codex'));
    account(path.join(h, '.codex-only-group'));

    const selected = codexRolloutPruneHomes([{ folder: 'only-group' }], () => ['~/.codex'], h);

    expect(selected).toEqual({ homes: [], errors: [] });
  });

  it('reports a group whose config cannot be read and still selects the others', () => {
    const h = home();
    account(path.join(h, '.codex'));
    const secondary = account(path.join(h, '.codex-secondary'));

    const selected = codexRolloutPruneHomes(
      [{ folder: 'broken' }, { folder: 'fine' }],
      (folder) => {
        if (folder === 'broken') throw new Error('container.json invalid');
        return ['~/.codex-secondary'];
      },
      h,
    );

    expect(selected.homes).toEqual([secondary]);
    expect(selected.errors).toEqual(['broken: container.json invalid']);
  });
});

describe('pruneCodexRollouts', () => {
  it('deletes rollouts last written over 30 days ago, plain and compressed, and the date dirs they empty', async () => {
    const h = home();
    const day = path.join(h, 'sessions', '2026', '08', '01');
    put(path.join(day, 'rollout-2026-08-01T00-00-00-a.jsonl'), OLD, 'abc');
    put(path.join(day, 'rollout-2026-08-01T01-00-00-b.jsonl.zst'), OLD, 'de');

    const result = await pruneCodexRollouts([h], NOW);

    expect(result).toEqual({ deleted: 2, bytes: 5, errors: [] });
    expect(fs.existsSync(path.join(h, 'sessions', '2026'))).toBe(false);
    expect(fs.existsSync(path.join(h, 'sessions'))).toBe(true);
  });

  it('keeps a rollout named for an old date that is still being written, and its dirs', async () => {
    const h = home();
    const live = put(path.join(h, 'sessions', '2026', '07', '01', 'rollout-2026-07-01T00-00-00-c.jsonl'), FRESH);

    expect(await pruneCodexRollouts([h], NOW)).toEqual({ deleted: 0, bytes: 0, errors: [] });
    expect(fs.existsSync(live)).toBe(true);
  });

  it('touches nothing but rollout files under real date dirs', async () => {
    const h = home();
    const other = home();
    const day = path.join(h, 'sessions', '2026', '08', '02');
    const note = put(path.join(day, 'notes.txt'), OLD);
    const outside = put(path.join(other, 'sessions', '2026', '08', '02', 'rollout-x.jsonl'), OLD);
    fs.symlinkSync(path.join(other, 'sessions', '2026'), path.join(h, 'sessions', '2025'));
    const stray = put(path.join(h, 'sessions', 'rollout-at-root.jsonl'), OLD);
    const archived = put(path.join(h, 'archived_sessions', 'rollout-2026-01-01T00-00-00-d.jsonl.zst'), OLD);

    expect(await pruneCodexRollouts([h], NOW)).toEqual({ deleted: 0, bytes: 0, errors: [] });
    for (const kept of [note, outside, stray, archived]) expect(fs.existsSync(kept)).toBe(true);
  });

  it('skips a home whose sessions dir is missing or a symlink, and still prunes the others', async () => {
    const missing = home();
    const linked = home();
    const real = home();
    const target = put(path.join(real, 'sessions', '2026', '08', '03', 'rollout-e.jsonl'), OLD);
    fs.symlinkSync(path.join(real, 'sessions'), path.join(linked, 'sessions'));

    expect(await pruneCodexRollouts([missing, linked], NOW)).toEqual({ deleted: 0, bytes: 0, errors: [] });
    expect(fs.existsSync(target)).toBe(true);
    expect((await pruneCodexRollouts([missing, linked, real], NOW)).deleted).toBe(1);
  });
});
