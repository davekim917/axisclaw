import { execFileSync } from 'child_process';
import { EventEmitter } from 'events';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { provenDisposable } from './checkout-proof.js';
import { openCheckoutProofs, type ProofWorkerStarter } from './checkout-proof-worker.js';
import { log } from './log.js';

const GIT_ENV = {
  PATH: process.env.PATH,
  HOME: '/nonexistent',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.invalid',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.invalid',
};

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, env: GIT_ENV, stdio: 'pipe' });
}

describe('checkout proofs on a worker thread', () => {
  let root: string;
  let clone: string;

  beforeEach(() => {
    vi.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-proof-worker-'));
    const origin = path.join(root, 'origin');
    fs.mkdirSync(origin);
    git(origin, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(origin, 'file.txt'), 'content\n');
    git(origin, 'add', '-A');
    git(origin, 'commit', '-q', '-m', 'first');
    clone = path.join(root, 'clone');
    git(root, 'clone', '-q', origin, clone);
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it(
    'answers exactly what the main-thread proof answers, for a clone it clears and one it refuses',
    { timeout: 60_000 },
    async () => {
      const proofs = openCheckoutProofs();
      try {
        const clean = await proofs.prove({ path: clone, inheritedTags: null });
        expect(clean).toEqual({ ok: true, reason: 'clean-and-pushed' });
        expect(clean).toEqual(provenDisposable(clone, 'all', null, true));

        fs.writeFileSync(path.join(clone, 'scratch.txt'), 'uncommitted\n');
        const dirty = await proofs.prove({ path: clone, inheritedTags: new Map([['refs/tags/kept', 'abc']]) });
        expect(dirty).toEqual({ ok: false, reason: 'dirty' });
        expect(dirty).toEqual(provenDisposable(clone, 'all', null, true));
      } finally {
        proofs.close();
      }
      expect(log.warn).not.toHaveBeenCalled();
    },
  );

  it('answers nothing once the worker dies, and starts no second one in that pass', async () => {
    const worker = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(() => worker.emit('exit', 1)),
      terminate: vi.fn(async () => 0),
      unref: vi.fn(),
    });
    const start = vi.fn(() => worker) as unknown as ProofWorkerStarter;
    const proofs = openCheckoutProofs(start);

    expect(await proofs.prove({ path: clone, inheritedTags: null })).toBeNull();
    expect(await proofs.prove({ path: clone, inheritedTags: null })).toBeNull();

    expect(start).toHaveBeenCalledOnce();
    expect(log.warn).toHaveBeenCalledOnce();
  });

  it('starts no worker for a pass that needs no proof, and stays quiet when it closes one', async () => {
    const start = vi.fn() as unknown as ProofWorkerStarter;
    openCheckoutProofs(start).close();
    expect(start).not.toHaveBeenCalled();

    const worker = Object.assign(new EventEmitter(), {
      postMessage: vi.fn(() => worker.emit('message', { ok: false, reason: 'dirty' })),
      terminate: vi.fn(async () => {
        worker.emit('exit', 1);
        return 1;
      }),
      unref: vi.fn(),
    });
    const proofs = openCheckoutProofs(() => worker);
    await proofs.prove({ path: clone, inheritedTags: null });
    proofs.close();

    expect(worker.terminate).toHaveBeenCalledOnce();
    expect(log.warn).not.toHaveBeenCalled();
  });
});
