import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { REPOSITORY_LOCK_QUEUE_WAIT_MS, withHostRepositoryLock } from './repository-workspaces.js';

vi.mock('./file-lock.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./file-lock.js')>();
  return {
    ...real,
    // A one-second `flock` clock, so three 400 ms holders outlast it without a two-minute test.
    withFileLock: <T>(file: string, fn: () => Promise<T> | T, options: { label?: string } = {}) =>
      real.withFileLock(file, fn, { ...options, waitSec: 1 }),
  };
});

describe('repository lock queue', () => {
  let root: string;
  const hold = <T>(fn: () => Promise<T> | T): Promise<T> => withHostRepositoryLock('wg', 'repo', fn, root);
  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'repository-lock-queue-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('a burst runs in arrival order, and the fourth waiter outlasts one flock timeout', async () => {
    const order: number[] = [];

    await Promise.all(
      [1, 2, 3, 4].map((n) =>
        hold(async () => {
          order.push(n);
          await sleep(400);
        }),
      ),
    );

    expect(order).toEqual([1, 2, 3, 4]);
  });

  it('a holder that throws hands the lock to the next waiter', async () => {
    const failed = hold(() => {
      throw new Error('clone failed');
    });
    const next = hold(() => 'ran');

    await expect(failed).rejects.toThrow('clone failed');
    await expect(next).resolves.toBe('ran');
  });

  it('a stuck line fails its waiters with an error and still serves whoever is behind them', async () => {
    let releaseHolder!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseHolder = resolve;
    });
    let entered!: () => void;
    const holding = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const holder = hold(async () => {
      entered();
      await held;
    });
    await holding;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const stuck = hold(() => 'never');
    const stuckResult = expect(stuck).rejects.toThrow(/timed out queueing/);
    await vi.advanceTimersByTimeAsync(REPOSITORY_LOCK_QUEUE_WAIT_MS / 2);
    const behind = hold(() => 'served');
    await vi.advanceTimersByTimeAsync(REPOSITORY_LOCK_QUEUE_WAIT_MS / 2);
    await stuckResult;
    vi.useRealTimers();

    releaseHolder();

    await holder;
    await expect(behind).resolves.toBe('served');
  });
});
