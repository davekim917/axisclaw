/** Worker-thread half of `src/archive-search-sync.ts`: the boot migration holds the archive's write lock here. */
import { parentPort, workerData } from 'node:worker_threads';

import { runArchiveSearchMigration, type ArchiveSearchMigrateRequest } from './archive-search-index.js';

export type { ArchiveSearchMigrateRequest, ArchiveSearchMigrateResult } from './archive-search-index.js';

const port = parentPort;
if (!port) throw new Error('Archive search migration worker requires a parent port');

port.postMessage(runArchiveSearchMigration(workerData as ArchiveSearchMigrateRequest));
