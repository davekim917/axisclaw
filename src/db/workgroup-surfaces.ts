import { getDb } from './connection.js';

/** The channel types of every conversation a workgroup's agents are wired to: the surfaces that are its own. */
export async function getWorkgroupChannelTypes(workgroupId: string): Promise<string[]> {
  const rows = await getDb().all<{ channel_type: string }>(
    `SELECT DISTINCT mg.channel_type
       FROM messaging_group_agents mga
       JOIN agent_groups ag ON ag.id = mga.agent_group_id
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
      WHERE COALESCE(ag.workgroup_id, ag.folder) = ?
      ORDER BY mg.channel_type`,
    workgroupId,
  );
  return rows.map((r) => r.channel_type);
}
