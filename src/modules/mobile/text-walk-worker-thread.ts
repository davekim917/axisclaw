import { parentPort, workerData } from 'node:worker_threads';

import { walkArchiveText, type ThreadHit, type WalkRequest } from './text-walk.js';

export type WalkUpdate = { found: ThreadHit[] } | { finished: true; complete: boolean };

const port = parentPort;
if (!port) throw new Error('Text walk worker requires a parent port');

const complete = walkArchiveText(workerData as WalkRequest, (found) =>
  port.postMessage({ found } satisfies WalkUpdate),
);
port.postMessage({ finished: true, complete } satisfies WalkUpdate);
