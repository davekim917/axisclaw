/** On a worker, because the boot migration holds the archive's write lock for whole chunks. */
import fs from 'fs';

import type { ArchiveSearchMigrateRequest, ArchiveSearchMigrateResult } from './archive-search-sync-worker-thread.js';
import { getDb } from './db/connection.js';
import { startHostWorker } from './host-worker.js';
import { log } from './log.js';
import { ARCHIVE_PATH } from './message-archive.js';

/** At boot nothing else writes the archive, so a chunk can be large. */
const MIGRATE_CHUNK_ROWS = 20_000;

async function members(): Promise<ArchiveSearchMigrateRequest['members']> {
  const groups = await getDb().all<{ id: string; workgroup_id: string | null }>(
    'SELECT id, workgroup_id FROM agent_groups',
  );
  return groups.map((group) => ({ agentGroupId: group.id, workgroupId: group.workgroup_id }));
}

function runWorker(request: ArchiveSearchMigrateRequest): Promise<ArchiveSearchMigrateResult> {
  return new Promise((resolve, reject) => {
    let answer: ArchiveSearchMigrateResult | undefined;
    const worker = startHostWorker('./archive-search-sync-worker-thread', import.meta.url, { workerData: request });
    worker.on('message', (message: ArchiveSearchMigrateResult) => {
      answer = message;
    });
    worker.on('error', reject);
    worker.on('exit', (code) =>
      answer ? resolve(answer) : reject(new Error(`archive search migration worker exited with code ${code}`)),
    );
  });
}

/**
 * Boot step, after the central migrations and before the channel adapters and the sweep start. A failure does not stop
 * the host: search stays off unless the tables already held every row and edit (`archiveSearchReady`), and the next boot
 * places every row again.
 */
export async function migrateArchiveSearchAtBoot(): Promise<void> {
  if (!fs.existsSync(ARCHIVE_PATH)) return;
  try {
    const result = await runWorker({
      archivePath: ARCHIVE_PATH,
      members: await members(),
      chunkRows: MIGRATE_CHUNK_ROWS,
    });
    if (!result.alreadyReady) log.info('Archive search partitions built', { ...result });
  } catch (err) {
    log.error('Archive search migration failed; text search is on only if the tables already held every row and edit', {
      err,
    });
  }
}
