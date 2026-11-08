import { EventEmitter } from 'node:events';
import fs from 'node:fs';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertStorageAdmissionInBackground,
  BackgroundStorageMaintenance,
  runStorageMaintenanceInBackground,
} from './storage-maintenance-worker.js';
import type { StorageReport } from './storage-manager.js';

const sharedWorker = vi.hoisted(() => ({ current: null as null | { posted: Array<Record<string, unknown>> } }));
vi.mock('./host-worker.js', () => ({
  startHostWorker: () => sharedWorker.current,
}));

class FakeWorker extends EventEmitter {
  readonly posted: Array<Record<string, unknown>> = [];
  readonly terminate = vi.fn(async () => 0);

  postMessage(message: Record<string, unknown>): void {
    this.posted.push(message);
  }
}

function usageAt(pct: number): fs.StatsFs {
  return { blocks: 100, bsize: 1, bfree: 100 - pct, bavail: 100 - pct } as fs.StatsFs;
}

function report(timestamp: string): StorageReport {
  return { timestamp } as StorageReport;
}

describe('BackgroundStorageMaintenance', () => {
  it('returns a rejected promise when worker creation fails synchronously', async () => {
    const runner = new BackgroundStorageMaintenance(() => {
      throw new Error('worker unavailable');
    });

    await expect(runner.runMaintenance([])).rejects.toThrow('worker unavailable');
    await runner.close();
  });

  it('dispatches maintenance without executing it on the caller and coalesces overlapping sweeps', async () => {
    const worker = new FakeWorker();
    const runner = new BackgroundStorageMaintenance(() => worker as never);

    const first = runner.runMaintenance(['sess-live']);
    const overlapping = runner.runMaintenance(['sess-live']);

    expect(worker.posted).toHaveLength(1);
    expect(worker.posted[0]).toMatchObject({ command: 'maintenance', activeSessionIds: ['sess-live'] });
    await expect(overlapping).resolves.toBeNull();

    worker.emit('message', { id: worker.posted[0].id, ok: true, result: report('2026-07-21T00:00:00Z') });
    await expect(first).resolves.toMatchObject({ timestamp: '2026-07-21T00:00:00Z' });
    await runner.close();
  });

  it('passes a fresh active-session snapshot to admission and report jobs', async () => {
    const worker = new FakeWorker();
    const runner = new BackgroundStorageMaintenance(() => worker as never);

    const admission = runner.assertAdmission(['sess-a', 'sess-b']);
    expect(worker.posted[0]).toMatchObject({ command: 'admission', activeSessionIds: ['sess-a', 'sess-b'] });
    worker.emit('message', {
      id: worker.posted[0].id,
      ok: true,
      result: { allowed: true, reason: 'below-threshold', report: report('admission') },
    });
    await expect(admission).resolves.toMatchObject({ allowed: true });

    const dryRun = runner.getReport(['sess-c'], { mode: 'dry-run' });
    expect(worker.posted[1]).toMatchObject({
      command: 'report',
      activeSessionIds: ['sess-c'],
      options: { mode: 'dry-run' },
    });
    worker.emit('message', { id: worker.posted[1].id, ok: true, result: report('report') });
    await expect(dryRun).resolves.toMatchObject({ timestamp: 'report' });
    await runner.close();
  });

  it('rejects pending work on worker failure and creates a fresh worker for the next job', async () => {
    const firstWorker = new FakeWorker();
    const secondWorker = new FakeWorker();
    const factory = vi.fn().mockReturnValueOnce(firstWorker).mockReturnValueOnce(secondWorker);
    const runner = new BackgroundStorageMaintenance(factory as never);

    const first = runner.assertAdmission([]);
    firstWorker.emit('error', new Error('boom'));
    await expect(first).rejects.toThrow('boom');

    const second = runner.getReport([], { mode: 'dry-run' });
    expect(secondWorker).not.toBe(firstWorker);
    firstWorker.emit('exit', 1);
    secondWorker.emit('message', { id: secondWorker.posted[0].id, ok: true, result: report('restarted') });
    await expect(second).resolves.toMatchObject({ timestamp: 'restarted' });
    expect(factory).toHaveBeenCalledTimes(2);
    await runner.close();
  });
});

describe('assertStorageAdmissionInBackground', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    { usagePct: 70, waitsForPass: false },
    { usagePct: 90, waitsForPass: true },
  ])(
    'with a maintenance pass running, admission at $usagePct% waits for it: $waitsForPass',
    async (row) => {
      vi.stubEnv('NANOCLAW_STORAGE_MANAGER_ENABLED', '1');
      vi.stubEnv('NANOCLAW_STORAGE_CLEANUP_THRESHOLD_PCT', '65');
      vi.stubEnv('NANOCLAW_STORAGE_ADMISSION_REFUSE_PCT', '90');
      vi.spyOn(fs.promises, 'statfs').mockResolvedValue(usageAt(row.usagePct) as never);
      sharedWorker.current ??= new FakeWorker();
      const worker = sharedWorker.current;
      void runStorageMaintenanceInBackground([]);
      const postedBefore = worker.posted.length;
      const queued = () => worker.posted.slice(postedBefore).map((m) => m.command);

      const admission = assertStorageAdmissionInBackground([]);

      if (row.waitsForPass) {
        let settled = false;
        void admission.then(() => (settled = true));
        await vi.waitFor(() => expect(queued()).toEqual(['admission']));
        expect(settled).toBe(false);
      } else {
        await expect(admission).resolves.toMatchObject({ allowed: true });
        expect(queued()).toEqual([]);
      }
    },
    2000,
  );
});
