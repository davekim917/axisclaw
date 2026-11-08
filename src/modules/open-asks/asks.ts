import { parseUtcTimestampMs } from '../../thread-context.js';

export type SessionAskCause = 'task_needs_input' | 'ask_question';
type AskCause = SessionAskCause | 'outcome';

export interface SessionAskRow {
  attached_task_needs_input: number | null;
  last_outbound_kind: string | null;
  last_active: string | null;
  last_outbound_at: string | null;
}

/** `last_active` is inbound-only, so an ask_question card stays open until an inbound arrives after it. */
export function sessionAskCause(row: SessionAskRow): SessionAskCause | null {
  if (row.attached_task_needs_input === 1) return 'task_needs_input';
  if (
    row.last_outbound_kind === 'chat-sdk:ask_question' &&
    (parseUtcTimestampMs(row.last_active) ?? 0) < (parseUtcTimestampMs(row.last_outbound_at) ?? 0)
  ) {
    return 'ask_question';
  }
  return null;
}

/** Agents sometimes fill the optional field with the renderer's own "nothing needed" wording. */
const NOTHING_NEEDED = /^(?:no action (?:is )?needed|nothing|none|n\/a)(?: for now)?\.?$/i;

export function outcomeAskText(needsYou: unknown): string | null {
  if (typeof needsYou !== 'string') return null;
  const text = needsYou.trim();
  if (!text || NOTHING_NEEDED.test(text)) return null;
  return text;
}

/** Agents address an ask by name when it is not for the requester: "Avery:", "Jordan or Sam:", "Avery/Jordan,". */
const LEADING_NAMES = /^([A-Z][\w'-]*(?:\s*(?:\/|\bor\b|\band\b)\s*[A-Z][\w'-]*)*)\s*[:,]/;

/** The known people an ask opens by naming; empty when it opens with no one `people` knows ("Optional:"). */
export function leadingAddressees(text: string, people: Set<string>): string[] {
  const match = LEADING_NAMES.exec(text);
  if (!match) return [];
  return match[1].split(/\s*(?:\/|\bor\b|\band\b)\s*/).filter((name) => people.has(name));
}

export interface Ask {
  id: string;
  cause: AskCause;
  workgroupId: string | null;
  agentGroupId: string;
  sessionId: string;
  threadId: string | null;
  askedAt: string;
  text: string;
  /** The person the ask is addressed to is an owner or global admin. */
  forOperator: boolean;
}

export interface AskMark {
  ask_id: string;
  claimed_by: string | null;
  claimed_at: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolution: string | null;
  alerted_at: string | null;
  reminded_at: string | null;
}

export const UNCLAIMED_ALERT_MS = 2 * 60 * 60_000;
export const UNANSWERED_REMINDER_MS = 24 * 60 * 60_000;

export interface AlertPlan {
  alert: Ask[];
  remind: Ask[];
}

/**
 * Asks raised before the backstop existed (`sinceMs`) were never promised an alert; alerting them at once would bury
 * the live ones. A reminder is the last word on an ask.
 */
export function planAlerts(asks: Ask[], marks: Map<string, AskMark>, nowMs: number, sinceMs: number): AlertPlan {
  const plan: AlertPlan = { alert: [], remind: [] };
  for (const ask of asks) {
    if (!ask.forOperator) continue;
    const askedMs = parseUtcTimestampMs(ask.askedAt);
    if (askedMs === null || askedMs < sinceMs) continue;
    const mark = marks.get(ask.id);
    if (mark?.resolved_at || mark?.reminded_at) continue;
    const age = nowMs - askedMs;
    if (age >= UNANSWERED_REMINDER_MS) plan.remind.push(ask);
    else if (age >= UNCLAIMED_ALERT_MS && !mark?.claimed_at && !mark?.alerted_at) plan.alert.push(ask);
  }
  return plan;
}
