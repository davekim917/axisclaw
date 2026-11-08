import { once } from 'node:events';
import fs from 'fs';
import path from 'path';
import { Worker } from 'node:worker_threads';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({ worker: null as import('node:worker_threads').Worker | null }));

vi.mock('../../log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));
vi.mock('../../host-worker.js', async (orig) => ({
  ...(await orig<typeof import('../../host-worker.js')>()),
  startHostWorker: () => H.worker,
}));

const { allowWritesTo } = await import('../../test-hermeticity.js');
const { startHostWorker } = await vi.importActual<typeof import('../../host-worker.js')>('../../host-worker.js');
const { initArchiveSchema, writeArchiveRow } = await import('../../message-archive.js');
const { findInMessages } = await import('./text-search.js');

const ROOT = uniqueTmpRoot('mobile-text-search');

beforeEach(() => {
  allowWritesTo(ROOT);
  fs.mkdirSync(ROOT, { recursive: true });
});

afterEach(async () => {
  await H.worker?.terminate();
  H.worker = null;
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('the walk off the main thread', () => {
  it('answers from the real worker file over a real archive', async () => {
    const archivePath = path.join(ROOT, 'archive.db');
    const db = new Database(archivePath);
    initArchiveSchema(db);
    writeArchiveRow(
      db,
      {
        id: 'm1',
        agentGroupId: 'ag-1',
        messagingGroupId: null,
        channelType: 'slack',
        channelName: null,
        platformId: 'slack:C1',
        threadId: 'slack:C1:1.0',
        role: 'user',
        senderId: null,
        senderName: null,
        senderIsBot: null,
        text: 'the zeppelin landed',
        sentAt: new Date().toISOString(),
      },
      { workgroupId: 'acme' },
    );
    db.close();

    const worker = startHostWorker('./text-walk-worker-thread', import.meta.url, {
      workerData: {
        archivePath,
        match: 'text : ("zeppelin")',
        since: '2020-01-01T00:00:00.000Z',
        scopes: [{ tenantKey: 'workgroup:acme', workgroupId: 'acme', platformId: 'slack:C1', threadIds: [] }],
        maxThreads: 10,
      },
    });
    const updates: unknown[] = [];
    worker.on('message', (update) => updates.push(update));
    await once(worker, 'exit');

    expect(updates).toEqual([
      { found: [{ workgroupId: 'acme', threadRef: 'slack:C1:1.0' }] },
      { finished: true, complete: true },
    ]);
  });

  it('keeps the event loop turning through a walk that never yields, and ends it at the limit', async () => {
    H.worker = new Worker('for (;;);', { eval: true });
    const exited = once(H.worker, 'exit');
    let last = Date.now();
    let longestGap = 0;
    const beat = setInterval(() => {
      longestGap = Math.max(longestGap, Date.now() - last);
      last = Date.now();
    }, 10);

    const startedAt = Date.now();
    const answer = await findInMessages({
      archivePath: '',
      match: '',
      since: '',
      scopes: [],
      maxThreads: 1,
    });
    const tookMs = Date.now() - startedAt;
    clearInterval(beat);

    expect(answer).toEqual({ threads: [], cutShort: true });
    expect(tookMs).toBeGreaterThanOrEqual(1_400);
    expect(tookMs).toBeLessThan(5_000);
    expect(longestGap).toBeLessThan(500);
    await exited;
  });
});
