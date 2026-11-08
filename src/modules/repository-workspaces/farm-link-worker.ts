import { startHostWorker } from '../../host-worker.js';
import { log } from '../../log.js';
import type { FarmLinkRequest, FarmLinkResponse } from './farm-link-worker-thread.js';

interface FarmWorker {
  once(event: 'message', listener: (response: FarmLinkResponse) => void): unknown;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'exit', listener: (code: number) => void): unknown;
  unref(): void;
}

export type FarmWorkerStarter = (request: FarmLinkRequest) => FarmWorker;

const startFarmWorker: FarmWorkerStarter = (request) =>
  startHostWorker('./farm-link-worker-thread', import.meta.url, { workerData: request });

/**
 * Links farms on a one-shot worker thread: a farm is one `link(2)` per installed file, which took 10-20 s on the main
 * thread. Never rejects: a checkout without a farm still works, npm installs into it, so a failed worker counts as
 * zero links and is logged. No timeout: linking sits outside the repository lock, so a hang holds only this checkout,
 * and terminating mid-link would leave a partial farm.
 */
export function linkFarmsOffThread(
  request: FarmLinkRequest,
  start: FarmWorkerStarter = startFarmWorker,
): Promise<number> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (linked: number, failure?: string): void => {
      if (settled) return;
      settled = true;
      if (failure !== undefined) {
        log.warn('Repository checkout could not link dependency farms', {
          workgroupId: request.workgroupId,
          reason: failure,
        });
      }
      resolve(linked);
    };
    try {
      const worker = start(request);
      worker.unref();
      worker.once('message', (response) => settle(response.linked));
      worker.once('error', (error) => settle(0, error.message));
      worker.once('exit', (code) => settle(0, `worker exited ${code} without answering`));
    } catch (error) {
      settle(0, error instanceof Error ? error.message : String(error));
    }
  });
}
