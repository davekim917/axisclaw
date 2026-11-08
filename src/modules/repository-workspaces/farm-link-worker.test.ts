import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import { log } from '../../log.js';
import { linkFarmsOffThread, type FarmWorkerStarter } from './farm-link-worker.js';

const REQUEST = { mode: 'apply', cacheRoot: '/cache', workgroupId: 'wg', pkgDirs: ['/pkg'] } as const;

function fakeWorker(drive: (worker: EventEmitter) => void): FarmWorkerStarter {
  return () => {
    const worker = Object.assign(new EventEmitter(), { unref: () => undefined });
    setImmediate(() => drive(worker));
    return worker;
  };
}

describe('linkFarmsOffThread', () => {
  it.each<[string, FarmWorkerStarter, number, boolean]>([
    [
      'an answer, then a clean exit',
      fakeWorker((w) => {
        w.emit('message', { linked: 2 });
        w.emit('exit', 0);
      }),
      2,
      false,
    ],
    ['a clean exit with no answer', fakeWorker((w) => w.emit('exit', 0)), 0, true],
    ['a non-zero exit', fakeWorker((w) => w.emit('exit', 1)), 0, true],
    [
      'a worker error, then its exit',
      fakeWorker((w) => {
        w.emit('error', new Error('boom'));
        w.emit('exit', 1);
      }),
      0,
      true,
    ],
    [
      'a worker that cannot start',
      () => {
        throw new Error('no threads');
      },
      0,
      true,
    ],
  ])('settles on %s', async (_name, start, linked, warns) => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => undefined);

    await expect(linkFarmsOffThread({ ...REQUEST, pkgDirs: [...REQUEST.pkgDirs] }, start)).resolves.toBe(linked);

    expect(warn).toHaveBeenCalledTimes(warns ? 1 : 0);
    warn.mockRestore();
  });
});
