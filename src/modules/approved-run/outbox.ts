/**
 * Reports the lane owes someone: a run's outcome to its thread and its agent, a removed-grant alert to the owner.
 * Each is a file under `data/approved-run/outbox/`, written before the event it reports is recorded as settled and
 * deleted only once every leg is delivered; the token-guard sweep retries what is left. A leg is marked delivered
 * only after it lands, so a crash between the two sends it twice, never zero times. A failed leg waits twice as long
 * before each retry, so a thread report that lands only its first chunk reposts it about ten times in a week, not on
 * every pass, while a report held up by an outage of hours or days is still delivered when it ends.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { notifyOwner } from '../../notify-owner.js';
import { notifyAgent } from '../approvals/primitive.js';
import { APPROVED_RUN_DIR } from './targets.js';

const OUTBOX_DIR = path.join(APPROVED_RUN_DIR, 'outbox');
const ID_RE = /^[A-Za-z0-9._-]{1,160}$/;
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const FIRST_RETRY_MS = 10 * 60 * 1000;

export interface Route {
  channelType: string;
  platformId: string;
  threadId: string | null;
  instance: string | null;
}

export type Leg =
  | { to: 'thread'; route: Route; text: string }
  | { to: 'agent'; sessionId: string; text: string }
  | { to: 'owner'; title: string; text: string };

/** `gone`: the leg can never be delivered (its session was deleted), so it is dropped, not retried. */
export type LegResult = 'delivered' | 'retry' | 'gone';

interface Entry {
  id: string;
  createdAt: string;
  legs: Array<Leg & { delivered?: true; attempts?: number; retryAt?: string }>;
}

export interface OutboxOptions {
  root?: string;
  deliver?: (leg: Leg) => Promise<LegResult>;
  now?: () => number;
}

function writeTmp(file: string, entry: Entry): string {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(entry, null, 2) + '\n', { mode: 0o600 });
  return tmp;
}

/** Queues a report under `id`; a report already queued under that id is kept as it is. */
export function queueReport(id: string, legs: Leg[], root = OUTBOX_DIR, at = Date.now()): void {
  if (!ID_RE.test(id)) throw new Error(`invalid outbox id ${JSON.stringify(id)}`);
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const file = path.join(root, `${id}.json`);
  const tmp = writeTmp(file, { id, createdAt: new Date(at).toISOString(), legs });
  try {
    fs.linkSync(tmp, file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  } finally {
    fs.unlinkSync(tmp);
  }
}

function isLeg(v: unknown): v is Leg & { delivered?: true; attempts?: number; retryAt?: string } {
  if (!v || typeof v !== 'object') return false;
  const l = v as Record<string, unknown>;
  if (typeof l.text !== 'string') return false;
  if (l.attempts !== undefined && !(Number.isInteger(l.attempts) && (l.attempts as number) >= 0)) return false;
  if (l.retryAt !== undefined && (typeof l.retryAt !== 'string' || Number.isNaN(Date.parse(l.retryAt)))) return false;
  if (l.to === 'agent') return typeof l.sessionId === 'string';
  if (l.to === 'owner') return typeof l.title === 'string';
  if (l.to !== 'thread' || !l.route || typeof l.route !== 'object') return false;
  const r = l.route as Record<string, unknown>;
  return typeof r.channelType === 'string' && typeof r.platformId === 'string';
}

function readEntry(file: string): Entry | null {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Partial<Entry>;
  if (typeof e.id !== 'string' || typeof e.createdAt !== 'string' || !Array.isArray(e.legs)) return null;
  return e.legs.every(isLeg) ? (e as Entry) : null;
}

async function deliverLeg(leg: Leg): Promise<LegResult> {
  if (leg.to === 'owner')
    return (await notifyOwner({ title: leg.title, body: leg.text })).code === 0 ? 'delivered' : 'retry';
  if (leg.to === 'agent') {
    const session = await getSession(leg.sessionId);
    if (!session) return 'gone';
    await notifyAgent(session, leg.text);
    return 'delivered';
  }
  const adapter = getDeliveryAdapter();
  if (!adapter) return 'retry';
  const { route } = leg;
  await adapter.deliver(
    route.channelType,
    route.platformId,
    route.threadId,
    'chat-sdk',
    // A long report goes out in chunks; without this, one that lands only its first chunk would count as delivered.
    JSON.stringify({ text: leg.text, requireCompleteDelivery: true }),
    undefined,
    route.instance ?? route.channelType,
  );
  return 'delivered';
}

function dropLeg(entry: Entry, leg: Leg, root: string, at: number): void {
  log.error('Approved-run report leg undelivered for 7 days; dropped', { id: entry.id, leg });
  if (leg.to === 'owner') return;
  const id = `undelivered-${createHash('sha256').update(`${entry.id}\0${leg.to}`).digest('hex').slice(0, 24)}`;
  queueReport(
    id,
    [
      {
        to: 'owner',
        title: 'Approved-run report not delivered',
        text: `The ${leg.to} copy of approved-run report ${entry.id} went undelivered for 7 days and was dropped. It said:\n${leg.text.slice(0, 1500)}`,
      },
    ],
    root,
    at,
  );
}

const inFlight = new Set<string>();

/** Delivers every queued report, or only `ids`; anything not delivered stays queued for the next pass. */
export async function deliverQueued(ids?: string[], opts: OutboxOptions = {}): Promise<void> {
  const root = opts.root ?? OUTBOX_DIR;
  const deliver = opts.deliver ?? deliverLeg;
  const now = opts.now ?? Date.now;
  let names: string[];
  try {
    names = ids ? ids.map((id) => `${id}.json`) : fs.readdirSync(root).filter((n) => n.endsWith('.json'));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  for (const name of names) {
    const file = path.join(root, name);
    if (inFlight.has(file)) continue;
    inFlight.add(file);
    try {
      const entry = fs.existsSync(file) ? readEntry(file) : undefined;
      if (entry === undefined) continue;
      if (entry === null) {
        log.error('Unreadable approved-run report left queued', { file });
        continue;
      }
      for (const leg of entry.legs) {
        if (leg.delivered) continue;
        if (leg.retryAt && Date.parse(leg.retryAt) > now()) continue;
        let result: LegResult;
        try {
          const { delivered: _delivered, attempts: _attempts, retryAt: _retryAt, ...bare } = leg;
          result = await deliver(bare as Leg);
          // eslint-disable-next-line no-catch-all/no-catch-all -- a failed leg stays queued and is retried on the next pass
        } catch (err) {
          log.warn('Approved-run report not delivered yet', { id: entry.id, to: leg.to, err });
          result = 'retry';
        }
        if (result === 'retry') {
          leg.attempts = (leg.attempts ?? 0) + 1;
          leg.retryAt = new Date(now() + FIRST_RETRY_MS * 2 ** (leg.attempts - 1)).toISOString();
          fs.renameSync(writeTmp(file, entry), file);
          continue;
        }
        if (result === 'gone') log.warn('Approved-run report leg has nowhere to go; dropped', { id: entry.id, leg });
        leg.delivered = true;
        fs.renameSync(writeTmp(file, entry), file);
      }
      if (entry.legs.every((l) => l.delivered)) fs.unlinkSync(file);
      else if (now() - Date.parse(entry.createdAt) > MAX_AGE_MS) {
        for (const leg of entry.legs) if (!leg.delivered) dropLeg(entry, leg, root, now());
        fs.unlinkSync(file);
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- one unreadable report must not stop the others
    } catch (err) {
      log.error('Could not process a queued approved-run report', { file, err });
    } finally {
      inFlight.delete(file);
    }
  }
}
