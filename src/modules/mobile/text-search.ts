import { startHostWorker } from '../../host-worker.js';
import { log } from '../../log.js';
import type { ThreadHit, WalkRequest } from './text-walk.js';
import type { WalkUpdate } from './text-walk-worker-thread.js';

/** On the live archive an uncommon word answers in under 100 ms, and a common word in a one-channel scope usually reaches this. */
const TEXT_SEARCH_LIMIT_MS = 1_500;
/** One phone sends a list per pairing, so a search is several walks at once. A cut-off walk counts until it exits. */
const MAX_WALKS = 4;

export interface TextMatches {
  threads: ThreadHit[];
  cutShort: boolean;
}

export const NO_TEXT_MATCHES: TextMatches = { threads: [], cutShort: false };

let walking = 0;

/**
 * Never rejects: the list answers with what the walk has found so far, and `cutShort` says it did not finish. The error
 * text stays out of the log because SQLite quotes the query in it.
 */
export function findInMessages(request: WalkRequest): Promise<TextMatches> {
  if (walking >= MAX_WALKS) return Promise.resolve({ threads: [], cutShort: true });
  return new Promise((resolve) => {
    const threads: ThreadHit[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (cutShort: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ threads, cutShort });
    };
    const failed = (code: unknown): void => {
      log.warn('Mobile: text search failed', { code: typeof code === 'string' ? code : 'unknown' });
      settle(true);
    };
    walking += 1;
    try {
      const worker = startHostWorker('./text-walk-worker-thread', import.meta.url, { workerData: request });
      worker.unref();
      timer = setTimeout(() => {
        settle(true);
        void worker.terminate();
      }, TEXT_SEARCH_LIMIT_MS);
      worker.on('message', (update: WalkUpdate) => {
        if (settled) return;
        if ('found' in update) threads.push(...update.found);
        else settle(!update.complete);
      });
      worker.on('error', (err: NodeJS.ErrnoException) => failed(err.code));
      worker.on('exit', () => {
        walking -= 1;
        settle(true);
      });
    } catch (err) {
      walking -= 1;
      failed((err as NodeJS.ErrnoException).code);
    }
  });
}
