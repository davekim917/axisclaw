import { getChannelAdapter } from './channels/channel-registry.js';
import { dispatch } from './cli/dispatch.js';
import { getDb } from './db/connection.js';
import { log } from './log.js';

export type OpenThreadError = 'agent_not_wired_to_channel' | 'channel_cannot_open_threads' | 'thread_create_failed';

const channelKey = (name: string): string => name.replace(/^#/, '').toLowerCase();

/**
 * The id of the first of this agent's wired rooms with this name. Names can repeat across workspaces, and nothing here
 * can tell two such rooms apart, so a caller that holds an id passes that instead.
 */
export async function wiredChannelIdNamed(agentGroupId: string, channel: string): Promise<string | null> {
  const wired = await getDb().all<{ id: string; name: string }>(
    `SELECT mg.id, mg.name
       FROM messaging_group_agents mga
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
      WHERE mga.agent_group_id = ?`,
    agentGroupId,
  );
  return wired.find((m) => channelKey(m.name) === channelKey(channel))?.id ?? null;
}

/**
 * Anchors a real thread in one of this agent's wired rooms: a parent post, then a thread under it opened with
 * `firstMessage`. An agent can only be made to speak where it is wired.
 */
export async function openThreadFor(
  agentGroupId: string,
  channelId: string,
  announcement: string,
  title: string,
  firstMessage: string,
): Promise<
  { threadId: string; messagingGroupId: string; title: string } | { error: OpenThreadError; channel: string }
> {
  const target = await getDb().get<{ id: string; name: string; platform_id: string; channel_type: string }>(
    `SELECT mg.id, mg.name, mg.platform_id, mg.channel_type
       FROM messaging_group_agents mga
       JOIN messaging_groups mg ON mg.id = mga.messaging_group_id
      WHERE mga.agent_group_id = ? AND mg.id = ?`,
    agentGroupId,
    channelId,
  );
  if (!target) return { error: 'agent_not_wired_to_channel', channel: channelId };

  const adapter = getChannelAdapter(target.channel_type);
  if (!adapter || typeof adapter.postParent !== 'function' || typeof adapter.createThread !== 'function') {
    return { error: 'channel_cannot_open_threads', channel: target.name };
  }

  try {
    const { messageId } = await adapter.postParent(target.platform_id, announcement);
    const threadTitle = title.slice(0, 80);
    const created = await adapter.createThread(target.platform_id, messageId, threadTitle, firstMessage);
    // chat-sdk routes on the ENCODED thread id (`<platform_id>:<thread>`); createThread returns the bare one.
    return {
      threadId: created.threadId.includes(':') ? created.threadId : `${target.platform_id}:${created.threadId}`,
      messagingGroupId: target.id,
      title: threadTitle,
    };
  } catch (err) {
    log.warn('open thread: could not open a thread', { channel: target.name, err });
    return { error: 'thread_create_failed', channel: target.name };
  }
}

export async function startThreadTask(task: {
  agentGroupId: string;
  messagingGroupId: string;
  threadId: string;
  name: string;
  prompt: string;
}): Promise<{ ok: true; seriesId: string | null } | { ok: false; error: unknown }> {
  const res = await dispatch(
    {
      id: `thread-task-${Date.now()}`,
      command: 'tasks-create',
      args: {
        group: task.agentGroupId,
        name: task.name,
        prompt: task.prompt,
        process_after: new Date().toISOString(),
        messaging_group: task.messagingGroupId,
        thread_id: task.threadId,
      },
    },
    { caller: 'host' },
  );
  if (!res.ok) return { ok: false, error: res };
  return { ok: true, seriesId: (res.data as { series_id?: string } | null | undefined)?.series_id ?? null };
}
