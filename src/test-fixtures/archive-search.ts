import type Database from 'better-sqlite3';

import type { ArchiveTenancy } from '../archive-search-index.js';

/** The tenancy an archive writer reads from the central DB at its write (`archiveTenancyOf`), read synchronously. */
export function tenancyNow(central: Database.Database, agentGroupId: string): ArchiveTenancy | undefined {
  const row = central.prepare('SELECT workgroup_id FROM agent_groups WHERE id = ?').get(agentGroupId) as
    | { workgroup_id: string | null }
    | undefined;
  return row && { workgroupId: row.workgroup_id };
}
