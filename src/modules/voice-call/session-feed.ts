import { onOutboundDelivered, type DeliveredOutbound } from '../../delivery-events.js';
import { log } from '../../log.js';
import { recentThreadMessages } from '../../message-archive.js';
import { scrubSecrets } from '../../secret-scrubber.js';
import { readSessionInbound, readSessionOutbound } from '../mailbox/index.js';
import type { MessageFeedRow } from '../mailbox/ops/reads.js';
import type { CallRoute } from './registry.js';

const POLL_MS = 500;
const BATCH = 200;
const RECENT_MESSAGES = 40;
const STARTUP_CONTEXT_BYTES = 4800;

export type FeedEvent =
  | { type: 'inbound'; sender: string; text: string }
  | { type: 'progress'; text: string; inReplyTo: string | null }
  | { type: 'reply'; text: string; inReplyTo: string | null }
  | { type: 'turn-end' };

interface FeedContent {
  text?: unknown;
  sender?: unknown;
  senderId?: unknown;
  origin?: unknown;
  author?: { fullName?: unknown; userName?: unknown };
  reporting?: { purpose?: unknown };
}

function parse(content: string): FeedContent | null {
  try {
    const parsed = JSON.parse(scrubSecrets(content)) as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as FeedContent) : null;
  } catch {
    return null;
  }
}

const sameRoute = (
  at: { channelType: string | null; platformId: string | null; threadId: string | null },
  route: CallRoute,
) => at.channelType === route.channelType && at.platformId === route.platformId && at.threadId === route.threadId;

const rowRoute = (row: MessageFeedRow) => ({
  channelType: row.channel_type,
  platformId: row.platform_id,
  threadId: row.thread_id ?? null,
});

/**
 * The agent's step labels. `work_log` is not progress: it holds the turn's whole suppressed output, including text
 * meant for other destinations.
 */
function progressEvent(row: MessageFeedRow, route: CallRoute): FeedEvent | null {
  if (row.kind !== 'status') return null;
  const content = parse(row.content);
  if (!content || content.reporting?.purpose === 'liveness') return null;
  const text = typeof content.text === 'string' ? content.text.trim() : '';
  if (!text || !sameRoute(rowRoute(row), route)) return null;
  return { type: 'progress', text, inReplyTo: row.in_reply_to };
}

function inboundEvent(row: MessageFeedRow, route: CallRoute, ownIdPrefix: string): FeedEvent | null {
  if ((row.kind !== 'chat' && row.kind !== 'chat-sdk') || row.id.startsWith(ownIdPrefix)) return null;
  if (!sameRoute(rowRoute(row), route)) return null;
  const content = parse(row.content);
  if (!content || content.origin === 'host' || content.sender === 'system' || content.senderId === 'system')
    return null;
  const text = typeof content.text === 'string' ? content.text.trim() : '';
  if (!text) return null;
  const name = [content.sender, content.author?.fullName, content.author?.userName].find(
    (v): v is string => typeof v === 'string' && v.length > 0,
  );
  return { type: 'inbound', sender: name ?? 'Someone', text };
}

/** What delivery posted is what the caller hears; delivery has already scrubbed, rewritten and placed it. */
function deliveredEvent(event: DeliveredOutbound, sessionId: string, route: CallRoute): FeedEvent | null {
  if (event.sessionId !== sessionId) return null;
  if (event.action !== undefined) return event.action === 'turn_end' ? { type: 'turn-end' } : null;
  const text = event.post?.text.trim();
  if (!text || !sameRoute(event.post!, route)) return null;
  return { type: 'reply', text, inReplyTo: event.inReplyTo };
}

export function startupContext(events: FeedEvent[], agentName: string, platform: string): string {
  const lines: string[] = [];
  let remaining = STARTUP_CONTEXT_BYTES;
  for (const event of [...events].reverse()) {
    if (event.type !== 'inbound' && event.type !== 'reply') continue;
    const who = event.type === 'reply' ? agentName : event.sender;
    const text = event.text.replace(/\s+/g, ' ');
    const line = `${who}: ${text.length > 600 ? text.slice(0, 600) + '…' : text}`;
    const size = Buffer.byteLength(line) + 1;
    if (size > remaining) break;
    lines.unshift(line);
    remaining -= size;
  }
  if (lines.length === 0) return '';
  return `Recent messages in this ${platform} thread, oldest first. Background only; do not read them back unless asked:\n${lines.join('\n')}`;
}

function recentThread(agentGroupId: string, route: CallRoute): FeedEvent[] {
  return recentThreadMessages({
    agentGroupId,
    channelType: route.channelType,
    platformId: route.platformId,
    threadId: route.threadId,
    limit: RECENT_MESSAGES,
  }).flatMap((m): FeedEvent[] => {
    const text = scrubSecrets(m.text).trim();
    if (!text) return [];
    return [
      m.role === 'assistant'
        ? { type: 'reply', text, inReplyTo: null }
        : { type: 'inbound', sender: m.senderName ?? 'Someone', text },
    ];
  });
}

export interface SessionFeed {
  recent: FeedEvent[];
  close(): void;
}

/**
 * Follows the call's session: the agent's replies and turn ends as delivery posts them, its progress as the runner
 * writes it, and people's messages as the host routes them in. Reports only what happens after it starts.
 */
export function followSessionFeed(
  location: { agentGroupId: string; sessionId: string; dataDir?: string },
  route: CallRoute,
  ownIdPrefix: string,
  onEvent: (event: FeedEvent) => void,
): SessionFeed {
  const read = (afterOut: number | null, afterIn: number | null, limit: number) => ({
    out: readSessionOutbound(location, (db) => db.listOutboundFeed(afterOut, limit)) ?? [],
    in: readSessionInbound(location, (db) => db.listInboundFeed(afterIn, limit)) ?? [],
  });

  let recent: FeedEvent[] = [];
  try {
    recent = recentThread(location.agentGroupId, route);
  } catch (err) {
    log.warn('Voice call: thread history read failed', { sessionId: location.sessionId, err });
  }
  let lastOut = 0;
  let lastIn = 0;
  try {
    const rows = read(null, null, 1);
    lastOut = rows.out[0]?.seq ?? 0;
    lastIn = rows.in[0]?.seq ?? 0;
  } catch (err) {
    log.warn('Voice call: session read failed at start', { sessionId: location.sessionId, err });
  }

  let closed = false;
  const stopDelivered = onOutboundDelivered((delivered) => {
    if (closed) return;
    const event = deliveredEvent(delivered, location.sessionId, route);
    if (event) onEvent(event);
  });
  const poll = () => {
    if (closed) return;
    try {
      const rows = read(lastOut, lastIn, BATCH);
      const events = [
        ...rows.out.map((r) => ({ seq: r.seq, event: progressEvent(r, route) })),
        ...rows.in.map((r) => ({ seq: r.seq, event: inboundEvent(r, route, ownIdPrefix) })),
      ].sort((a, b) => a.seq - b.seq);
      for (const r of rows.out) lastOut = Math.max(lastOut, r.seq);
      for (const r of rows.in) lastIn = Math.max(lastIn, r.seq);
      for (const { event } of events) if (event) onEvent(event);
    } catch (err) {
      log.warn('Voice call: session read failed', { sessionId: location.sessionId, err });
    }
  };
  const timer = setInterval(poll, POLL_MS);
  timer.unref();
  return {
    recent,
    close() {
      closed = true;
      stopDelivered();
      clearInterval(timer);
    },
  };
}
