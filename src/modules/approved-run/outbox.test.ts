import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { log } from '../../log.js';
import { deliverQueued, queueReport, type Leg, type LegResult } from './outbox.js';

const ROUTE = { channelType: 'slack', platformId: 'C-1', threadId: 'T-1', instance: null };
const thread: Leg = { to: 'thread', route: ROUTE, text: 'run report' };
const agent: Leg = { to: 'agent', sessionId: 'sess-1', text: 'run report + rows' };
const owner: Leg = { to: 'owner', title: 'Alert', text: 'grant removed' };

let root: string;

beforeEach(() => {
  root = uniqueTmpRoot('approved-run-outbox');
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

/** A deliverer that answers each leg's `to` from `script` in turn, and records what it was asked to deliver. */
function deliverer(script: Partial<Record<Leg['to'], Array<LegResult | Error>>> = {}) {
  const asked: Leg[] = [];
  const deliver = vi.fn(async (leg: Leg) => {
    asked.push(leg);
    const next = script[leg.to]?.shift() ?? 'delivered';
    if (next instanceof Error) throw next;
    return next;
  });
  return { deliver, asked };
}

const queued = () => (fs.existsSync(root) ? fs.readdirSync(root) : []);

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;

describe('approved-run outbox', () => {
  it('delivers every leg in order and removes the report once all landed', async () => {
    queueReport('run-1', [thread, agent], root);
    const d = deliverer();
    await deliverQueued(undefined, { root, deliver: d.deliver });
    expect(d.asked).toEqual([thread, agent]);
    expect(queued()).toEqual([]);
  });

  it('keeps a leg that failed for the next pass, and never resends one that already landed', async () => {
    queueReport('run-1', [thread, agent], root);
    const first = deliverer({ thread: [new Error('platform unavailable')] });
    await deliverQueued(undefined, { root, deliver: first.deliver });
    expect(first.asked).toEqual([thread, agent]);
    expect(queued()).toEqual(['run-1.json']);

    const second = deliverer({ thread: ['retry'] });
    await deliverQueued(['run-1'], { root, deliver: second.deliver, now: () => Date.now() + 11 * MINUTE });
    expect(second.asked).toEqual([thread]);

    const third = deliverer();
    await deliverQueued(['run-1'], { root, deliver: third.deliver, now: () => Date.now() + 32 * MINUTE });
    expect(third.asked).toEqual([thread]);
    expect(queued()).toEqual([]);
  });

  it('keeps the first report queued under an id, so re-queueing after a restart changes nothing', async () => {
    queueReport('run-1', [thread], root);
    queueReport('run-1', [owner], root);
    const d = deliverer();
    await deliverQueued(undefined, { root, deliver: d.deliver });
    expect(d.asked).toEqual([thread]);
  });

  it('drops a leg that can never be delivered and still delivers the rest', async () => {
    queueReport('run-1', [agent, thread], root);
    const d = deliverer({ agent: ['gone'] });
    await deliverQueued(undefined, { root, deliver: d.deliver });
    expect(d.asked).toEqual([agent, thread]);
    expect(queued()).toEqual([]);
  });

  it('leaves an unreadable report in place and still delivers the others', async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, 'broken.json'), 'null');
    fs.writeFileSync(path.join(root, 'torn.json'), '{"id":');
    queueReport('alert-1', [owner], root);
    const d = deliverer();
    await deliverQueued(undefined, { root, deliver: d.deliver });
    expect(d.asked).toEqual([owner]);
    expect(queued().sort()).toEqual(['broken.json', 'torn.json']);
  });

  /** Runs the 10-minute sweep pass from now until `days` have passed, with `deliver` answering every leg. */
  async function sweepFor(days: number, deliver: (leg: Leg, at: number) => Promise<LegResult>): Promise<void> {
    const start = Date.now();
    for (let at = start; at <= start + days * DAY; at += 10 * MINUTE) {
      await deliverQueued(undefined, { root, deliver: (leg) => deliver(leg, at - start), now: () => at });
    }
  }

  it('still delivers a report held up by a two-hour outage, retrying with growing waits', async () => {
    queueReport('run-1', [thread], root);
    const tries: number[] = [];
    await sweepFor(0.5, async (_leg, elapsed) => {
      tries.push(elapsed / MINUTE);
      return elapsed < 120 * MINUTE ? 'retry' : 'delivered';
    });
    expect(tries).toEqual([0, 10, 30, 70, 150]);
    expect(queued()).toEqual([]);
  });

  it('tries a leg that never delivers about ten times in seven days, then drops it and alerts the owner once', async () => {
    queueReport('run-1', [agent, thread], root);
    const tries: Leg['to'][] = [];
    await sweepFor(7.1, async (leg) => {
      tries.push(leg.to);
      return leg.to === 'agent' ? 'delivered' : 'retry';
    });
    expect(tries.filter((t) => t === 'agent')).toHaveLength(1);
    expect(tries.filter((t) => t === 'thread')).toHaveLength(10);
    const left = queued();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatch(/^undelivered-[0-9a-f]{24}\.json$/);
    const alert = new Set<Leg>();
    await deliverQueued(undefined, {
      root,
      deliver: async (leg) => (alert.add(leg), 'delivered'),
      now: () => Date.now() + 8 * DAY,
    });
    expect([...alert]).toEqual([
      {
        to: 'owner',
        title: 'Approved-run report not delivered',
        text: 'The thread copy of approved-run report run-1 went undelivered for 7 days and was dropped. It said:\nrun report',
      },
    ]);
    expect(queued()).toEqual([]);
  });

  it('gives up on a report still undelivered after seven days', async () => {
    queueReport('run-1', [thread], root);
    const d = deliverer({ thread: ['retry', 'retry'] });
    await deliverQueued(undefined, { root, deliver: d.deliver, now: () => Date.now() + 6 * DAY });
    expect(queued()).toEqual(['run-1.json']);
    await deliverQueued(undefined, { root, deliver: d.deliver, now: () => Date.now() + 8 * DAY });
    expect(queued().filter((n) => n.startsWith('run-'))).toEqual([]);
  });

  it('drops an owner alert still undelivered after seven days without queueing another one, logging what it said', async () => {
    const logged = vi.spyOn(log, 'error');
    queueReport('alert-1', [owner], root);
    const d = deliverer({ owner: Array<LegResult>(2).fill('retry') });
    await deliverQueued(undefined, { root, deliver: d.deliver, now: () => Date.now() + 6 * DAY });
    await deliverQueued(undefined, { root, deliver: d.deliver, now: () => Date.now() + 8 * DAY });
    expect(d.asked).toHaveLength(2);
    expect(queued()).toEqual([]);
    expect(logged).toHaveBeenCalledWith(expect.stringContaining('undelivered for 7 days'), {
      id: 'alert-1',
      leg: expect.objectContaining(owner),
    });
  });

  it('never sends a leg twice when two passes overlap', async () => {
    queueReport('run-1', [thread], root);
    let release: () => void = () => {};
    const deliver = vi.fn(
      () =>
        new Promise<LegResult>((resolve) => {
          release = () => resolve('delivered');
        }),
    );
    const firstPass = deliverQueued(undefined, { root, deliver });
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    await deliverQueued(['run-1'], { root, deliver });
    release();
    await firstPass;
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(queued()).toEqual([]);
  });

  it('refuses an id that could leave the outbox directory', () => {
    expect(() => queueReport('../x', [thread], root)).toThrow('invalid outbox id');
  });

  it('does nothing when nothing was ever queued', async () => {
    const d = deliverer();
    await expect(
      deliverQueued(undefined, { root: path.join(root, 'absent'), deliver: d.deliver }),
    ).resolves.toBeUndefined();
    expect(d.asked).toEqual([]);
  });
});
