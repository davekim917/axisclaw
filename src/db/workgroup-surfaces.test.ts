import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, getDb } from './connection.js';
import { initMigratedTestDb } from './index.js';
import { getWorkgroupChannelTypes } from './workgroup-surfaces.js';

const at = '2026-01-01T00:00:00.000Z';

async function wire(agentGroup: string, workgroup: string | null, messagingGroup: string, channelType: string) {
  const db = getDb();
  if (workgroup) await db.run('INSERT OR IGNORE INTO workgroups (id, created_at) VALUES (?, ?)', workgroup, at);
  await db.run(
    'INSERT OR IGNORE INTO agent_groups (id, name, folder, created_at, workgroup_id) VALUES (?, ?, ?, ?, ?)',
    agentGroup,
    agentGroup,
    agentGroup,
    at,
    workgroup,
  );
  await db.run(
    'INSERT OR IGNORE INTO messaging_groups (id, channel_type, platform_id, instance, created_at) VALUES (?, ?, ?, ?, ?)',
    messagingGroup,
    channelType,
    `${channelType}:${messagingGroup}`,
    channelType,
    at,
  );
  await db.run(
    'INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at) VALUES (?, ?, ?, ?)',
    `${messagingGroup}-${agentGroup}`,
    messagingGroup,
    agentGroup,
    at,
  );
}

beforeEach(async () => {
  await initMigratedTestDb();
});

afterEach(async () => {
  await closeDb();
});

describe('getWorkgroupChannelTypes', () => {
  it("lists the channel types a workgroup's agents are wired to, and no other workgroup's", async () => {
    await wire('ag-north', 'wg-north', 'mg-1', 'slack-north');
    await wire('ag-north', 'wg-north', 'mg-2', 'discord');
    await wire('ag-north-2', 'wg-north', 'mg-3', 'slack-north');
    await wire('ag-south', 'wg-south', 'mg-4', 'slack-south');
    await wire('legacy', null, 'mg-5', 'slack-legacy');
    expect(await getWorkgroupChannelTypes('wg-north')).toEqual(['discord', 'slack-north']);
    expect(await getWorkgroupChannelTypes('wg-south')).toEqual(['slack-south']);
    expect(await getWorkgroupChannelTypes('legacy')).toEqual(['slack-legacy']);
    expect(await getWorkgroupChannelTypes('wg-none')).toEqual([]);
  });
});
