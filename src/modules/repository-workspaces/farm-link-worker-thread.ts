import { parentPort, workerData } from 'node:worker_threads';

import { linkPackageDir, startDependencyCachePass } from '../../dependency-cache.js';
import { log } from '../../log.js';

export interface FarmLinkRequest {
  mode: 'apply' | 'report';
  cacheRoot: string;
  workgroupId: string;
  pkgDirs: string[];
  /** Absent means the worker asks for the agent image's own fingerprint. */
  fingerprint?: string | null;
}

export interface FarmLinkResponse {
  linked: number;
}

const port = parentPort;
if (!port) throw new Error('Farm link worker requires a parent port');

const { mode, cacheRoot, workgroupId, pkgDirs, fingerprint } = workerData as FarmLinkRequest;
const pass = startDependencyCachePass({
  mode,
  cacheRoot,
  now: Date.now(),
  reclaimableBytes: () => 0,
  fingerprint: fingerprint === undefined ? undefined : () => fingerprint,
});
let linked = 0;
for (const pkgDir of pkgDirs) {
  try {
    if (linkPackageDir(pass, workgroupId, pkgDir) === 'linked' && pass.mode === 'apply') linked += 1;
  } catch (err) {
    log.warn('Repository checkout could not link a dependency farm', { path: pkgDir, err });
  }
}
port.postMessage({ linked } satisfies FarmLinkResponse);
