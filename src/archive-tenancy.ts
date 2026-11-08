import type { ArchiveTenancy } from './archive-search-index.js';
import { getAgentGroup } from './db/agent-groups.js';

/**
 * Which workgroup's search index a message the agent group archives now belongs to, read from the central DB at the
 * write and never kept: a message stays in the index of the workgroup its agent group was in when it was archived.
 * Undefined for an agent group the central DB does not hold, whose message is archived but not indexed.
 */
export async function archiveTenancyOf(agentGroupId: string): Promise<ArchiveTenancy | undefined> {
  const group = await getAgentGroup(agentGroupId);
  return group && { workgroupId: group.workgroup_id ?? null };
}
