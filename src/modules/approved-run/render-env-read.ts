/**
 * An agent reads a listed Render service's env vars without a card: the host fetches them as the target's reserved
 * identity and answers with every key, each value masked unless the resource lists the key as plaintext. Nothing is
 * written, and no unmasked secret reaches the container.
 */
import { notifyAgent } from '../approvals/primitive.js';
import { registerDeliveryAction } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { renderApiFor, type RenderApi } from './render-api.js';
import { maskKey, showEnvValue } from './render-mask.js';
import { ENV_KEY_RE, loadTarget, type RenderTarget } from './targets.js';

const READ_ACTION = 'request_render_env_read';
const MAX_PAGES = 20;
const REPLY_MAX = 12_000;

interface EnvEntry {
  key: string;
  value: string;
}

interface EnvRead {
  entries: EnvEntry[];
  /** True when the page cap stopped the read before Render's last page. */
  truncated: boolean;
}

function entryOf(raw: unknown): EnvEntry | null {
  const e = ((raw as { envVar?: unknown } | null)?.envVar ?? raw) as { key?: unknown; value?: unknown } | null;
  return e && typeof e.key === 'string' && typeof e.value === 'string' ? { key: e.key, value: e.value } : null;
}

async function readServiceEnv(api: RenderApi, service: string, key: string | null): Promise<EnvRead> {
  if (key) {
    const res = await api('GET', `/v1/services/${service}/env-vars/${key}`);
    if (res.status !== 200) throw new Error(`Render answered HTTP ${res.status}`);
    const entry = entryOf(res.body);
    return { entries: entry ? [entry] : [], truncated: false };
  }
  const entries: EnvEntry[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await api(
      'GET',
      `/v1/services/${service}/env-vars?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
    );
    if (res.status !== 200) throw new Error(`Render answered HTTP ${res.status}`);
    const list = Array.isArray(res.body) ? res.body : [];
    for (const raw of list) {
      const entry = entryOf(raw);
      if (entry) entries.push(entry);
    }
    const last = list[list.length - 1] as { cursor?: unknown } | undefined;
    if (list.length < 100 || typeof last?.cursor !== 'string') return { entries, truncated: false };
    cursor = last.cursor;
  }
  return { entries, truncated: true };
}

function formatEnvReply(target: RenderTarget, service: string, read: EnvRead, key: Buffer): string {
  const { entries, truncated } = read;
  const resource = target.resources[service];
  const lines = entries
    .sort((a, b) => a.key.localeCompare(b.key))
    .map((e) => `${e.key}=${showEnvValue(resource, e.key, e.value, key)}`);
  const count = truncated
    ? `the first ${entries.length} keys (the read stopped at its page cap; the list is incomplete)`
    : `${entries.length} keys`;
  const text = `${resource.label} (${service}) env, ${count}; masked values are length + keyed HMAC, equal values mask the same:\n${lines.join('\n')}`;
  return text.length > REPLY_MAX ? `${text.slice(0, REPLY_MAX)}\n… truncated` : text;
}

function readTarget(content: Record<string, unknown>, agentGroupId: string): RenderTarget | { error: string } {
  if (typeof content.target !== 'string') return { error: 'target is required' };
  const target = loadTarget(content.target);
  if ('error' in target) return target;
  if (target.kind !== 'render') return { error: `${target.label} is not a Render target` };
  if (!target.agentGroups.includes(agentGroupId)) return { error: `this agent may not read ${target.label}` };
  if (typeof content.service !== 'string' || !target.resources[content.service]) {
    return { error: 'service must be one of the resources this target lists' };
  }
  if (!/^(srv|crn)-/.test(content.service)) return { error: 'env vars belong to services and cron jobs only' };
  if (content.key !== undefined && (typeof content.key !== 'string' || !ENV_KEY_RE.test(content.key))) {
    return { error: 'key must be a plain env var name' };
  }
  return target;
}

const readAction = defineGuardedAction({
  action: 'approved_run.render_env_read',
  decide: (input) => {
    if (input.actor.kind !== 'agent') return DENY('env reads are requested by an agent');
    const t = readTarget(input.payload, input.actor.agentGroupId);
    return 'error' in t ? DENY(t.error) : ALLOW('a listed agent reading a listed service, values masked');
  },
});

async function reply(session: Session, text: string): Promise<void> {
  await notifyAgent(session, text).catch((err) => log.warn('Failed to deliver a Render env read', { err }));
}

registerDeliveryAction(
  READ_ACTION,
  async (content, session) => {
    const target = readTarget(content, session.agent_group_id);
    if ('error' in target) return reply(session, `Render env read refused: ${target.error}`);
    const service = content.service as string;
    let read: EnvRead;
    try {
      read = await readServiceEnv(
        await renderApiFor(target.execute.onecliAgent),
        service,
        (content.key as string | undefined) ?? null,
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- a failed read is reported to the agent, not retried
    } catch (err) {
      return reply(session, `Render env read failed: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}`);
    }
    await reply(session, formatEnvReply(target, service, read, maskKey(target.id)));
  },
  {
    guardAction: readAction,
    requestHold: async () => {
      throw new Error('a Render env read never asks for approval');
    },
    onDeny: (_content: Record<string, unknown>, session: Session, reason: string) =>
      void reply(session, `Render env read refused: ${reason}`),
  },
);
