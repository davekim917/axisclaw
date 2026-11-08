/** A control session's own sweep can die unnoticed (a session cron expires after 7 days), so the host owns this. */
import { threadPermalink } from '../../dashboard/api/observatory.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';
import { notifyOperators } from '../../operator-alert.js';
import { planAlerts, type Ask } from './asks.js';
import { backstopSinceMs, getMarks, listAsks, stampAlerts } from './store.js';

const SCAN_INTERVAL_MS = 5 * 60_000;
const MAX_LISTED = 10;

export interface BackstopDeps {
  now: () => number;
  listAsks: (nowMs: number) => Promise<Ask[]>;
  getMarks: typeof getMarks;
  sinceMs: () => Promise<number | null>;
  describe: (ask: Ask) => Promise<string>;
  notify: (text: string) => Promise<boolean>;
  stamp: typeof stampAlerts;
}

function ageText(ms: number): string {
  const hours = Math.floor(ms / 3_600_000);
  return hours >= 24
    ? `${Math.floor(hours / 24)}d ${hours % 24}h`
    : `${hours}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
}

async function describeAsk(ask: Ask, nowMs: number): Promise<string> {
  const group = (await getAgentGroup(ask.agentGroupId))?.name ?? ask.agentGroupId;
  const link = ask.threadId ? await threadPermalink(ask.threadId).catch(() => null) : null;
  const age = ageText(nowMs - Date.parse(ask.askedAt));
  return `• ${group}, ${age}: ${ask.text}${link ? ` — ${link}` : ''} (id \`${ask.id}\`)`;
}

async function message(heading: string, asks: Ask[], deps: BackstopDeps): Promise<string> {
  const lines = await Promise.all(asks.slice(0, MAX_LISTED).map((a) => deps.describe(a)));
  const more = asks.length > MAX_LISTED ? [`…and ${asks.length - MAX_LISTED} more: \`ncl asks list\``] : [];
  return [
    heading,
    ...lines,
    ...more,
    'Reply in the thread, or close one settled elsewhere with `ncl asks resolve --id <id> --reason "…"`.',
  ].join('\n');
}

export async function runBackstop(deps: BackstopDeps): Promise<{ alerted: number; reminded: number }> {
  const sinceMs = await deps.sinceMs();
  if (sinceMs === null) return { alerted: 0, reminded: 0 };
  const nowMs = deps.now();
  const asks = await deps.listAsks(nowMs);
  const plan = planAlerts(asks, await deps.getMarks(asks.map((a) => a.id)), nowMs, sinceMs);
  const nowIso = new Date(nowMs).toISOString();

  let alerted = 0;
  let reminded = 0;
  if (plan.alert.length > 0) {
    const n = plan.alert.length;
    const text = await message(
      `${n} ask${n === 1 ? ' has' : 's have'} waited over 2h for you, with no Anderton on ${n === 1 ? 'it' : 'them'}:`,
      plan.alert,
      deps,
    );
    if (await deps.notify(text)) {
      await deps.stamp(
        plan.alert.map((a) => a.id),
        'alerted_at',
        nowIso,
      );
      alerted = n;
    }
  }
  if (plan.remind.length > 0) {
    const n = plan.remind.length;
    const text = await message(
      `Reminder: ${n} ask${n === 1 ? ' is' : 's are'} still unanswered after a day:`,
      plan.remind,
      deps,
    );
    if (await deps.notify(text)) {
      await deps.stamp(
        plan.remind.map((a) => a.id),
        'reminded_at',
        nowIso,
      );
      reminded = n;
    }
  }
  return { alerted, reminded };
}

let scanning = false;
let lastScanAt = 0;

function registerOpenAsksSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.FORK9,
    phase: 'tick:housekeeping',
    order: 137,
    run: () => {
      if (scanning || Date.now() - lastScanAt < SCAN_INTERVAL_MS) return;
      scanning = true;
      lastScanAt = Date.now();
      // Detached: listing asks reads the archive once or twice per ask and must never hold the tick.
      void runBackstop({
        now: Date.now,
        listAsks: (nowMs) => listAsks({ nowMs }),
        getMarks,
        sinceMs: backstopSinceMs,
        describe: (ask) => describeAsk(ask, Date.now()),
        notify: (text) => notifyOperators(text, { source: 'open-asks' }),
        stamp: stampAlerts,
      })
        .then((r) => {
          if (r.alerted || r.reminded) log.info('open-asks: owner alerted', r);
        })
        .catch((err) => log.warn('open-asks backstop failed', { err }))
        .finally(() => {
          scanning = false;
        });
    },
  });
}

registerSweepDutySource('open-asks', registerOpenAsksSweepDuties);
