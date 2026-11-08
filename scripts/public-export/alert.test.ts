import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { alertOwner, type AlertDeps } from './alert.js';
import type { Status } from './export-flow.js';

const QUOTE = 'Bramblewick Hollow Ltd';
const NAME = 'quillfern';

let dir: string;
let sent: { title: string; body: string }[];
let deliveryCode: number;
let subject: string;
let quotes: () => string[];
let isClean: (text: string) => boolean;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'export-alert-'));
  sent = [];
  deliveryCode = 0;
  subject = `fix: rename the ${QUOTE.toUpperCase()} fixture`;
  quotes = () => [QUOTE];
  isClean = (text) => !text.toLowerCase().includes(NAME);
});

afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

function deps(): AlertDeps {
  return {
    recordFile: path.join(dir, 'public-export-alert.json'),
    heldDetailLabel: 'logs/public-export/held.json',
    origin: (sha) => ({ rev: `${sha.slice(0, 2)}${'f'.repeat(38)}`, subject }),
    quotes: () => quotes(),
    isClean: (text) => isClean(text),
    notify: async (title, body) => {
      sent.push({ title, body });
      return { code: deliveryCode, message: 'fake' };
    },
  };
}

function held(sha: string): Status {
  return {
    status: 'held',
    at: '2026-01-02T03:04:05.000Z',
    dryRun: false,
    workflow: 'export',
    lastPublished: 'c'.repeat(40),
    lastPassing: 'c'.repeat(40),
    held: {
      sha,
      reasons: [
        { source: 'scanner', where: 'src/widget.ts:12', category: 'identifier' },
        { source: 'ai', where: 'batch 1', category: 'possible-identifier' },
      ],
    },
  };
}

function squashHeld(firstSha: string, squashSha: string): Status {
  return {
    ...held(squashSha),
    workflow: 'export_squash',
    held: { sha: squashSha, reasons: [{ source: 'gate', where: 'run', category: 'ai-budget-exceeded' }] },
    perCommitHold: { sha: firstSha, reasons: [{ source: 'ai', where: 'batch 2', category: 'possible-identifier' }] },
    squashReason: 'ai-hold-fixed-forward',
  };
}

const ok: Status = {
  status: 'ok',
  at: '2026-01-02T03:04:05.000Z',
  dryRun: false,
  lastPublished: null,
  lastPassing: null,
};

describe('alertOwner', () => {
  it('notifies once per held private commit, and again for a new one', async () => {
    expect(await alertOwner(held('a'.repeat(40)), false, deps())).toBe('sent');
    expect(await alertOwner(held('a'.repeat(40)), false, deps())).toBe('quiet');
    expect(await alertOwner(held('b'.repeat(40)), false, deps())).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('says where the hold is, why, and how to fix it, with the flagged quote redacted', async () => {
    await alertOwner(held('a'.repeat(40)), false, deps());
    const { title, body } = sent[0];
    expect(title).toBe('Public export held');
    expect(body).toContain('`aaaaaaaaaa` (private `aaffffffff`: fix: rename the <redacted> fixture)');
    expect(body).toContain('• src/widget.ts:12 — scanner: identifier');
    expect(body).toContain('• batch 1 — ai: possible-identifier');
    expect(body).toContain('`logs/public-export/held.json`');
    expect(body).toContain('a change in the private repo');
    expect(body.toLowerCase()).not.toContain('bramblewick');
  });

  it('redacts a flagged name from the subject when the quote is a whole line', async () => {
    quotes = () => ['const tenant = "Bramblewick Hollow Ltd";'];
    subject = 'feat: bramblewick invoice import';
    await alertOwner(held('a'.repeat(40)), false, deps());
    expect(sent[0].body).toContain('(private `aaffffffff`: feat: <redacted> invoice import)');
  });

  it.each([
    ['the scanner flags it', () => {}],
    [
      'the scanner cannot run',
      () => {
        isClean = () => {
          throw new Error('scanner unavailable');
        };
      },
    ],
    [
      'the quotes cannot be loaded',
      () => {
        quotes = () => {
          throw new Error('malformed ai-holds.json');
        };
      },
    ],
  ])('withholds the subject when %s', async (_name, setup) => {
    subject = `feat: the ${NAME}-dashboard widget`;
    setup();
    expect(await alertOwner(held('a'.repeat(40)), false, deps())).toBe('sent');
    expect(sent[0].body).toContain('(private `aaffffffff`: <subject withheld>)');
    expect(sent[0].body.toLowerCase()).not.toContain(NAME);
  });

  it('a squash hold names and dedupes on the commit that first held, whatever the squash commit is', async () => {
    expect(await alertOwner(squashHeld('d'.repeat(40), 'e'.repeat(40)), false, deps())).toBe('sent');
    expect(await alertOwner(squashHeld('d'.repeat(40), '9'.repeat(40)), false, deps())).toBe('quiet');
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toContain('Held on `dddddddddd` (private `ddffffffff`:');
    expect(sent[0].body).toContain('• batch 2 — ai: possible-identifier');
    expect(sent[0].body).toContain('The squash retry also held:\n• run — gate: ai-budget-exceeded');
  });

  it('a squash hold that changes reason under the same first-held commit notifies again', async () => {
    const budget = (count: number): Status => {
      const status = squashHeld('d'.repeat(40), 'e'.repeat(40));
      status.held!.reasons = [
        { source: 'gate', where: 'run', category: `AI budget exceeded: ${count} batches > cap 15` },
      ];
      return status;
    };
    expect(await alertOwner(budget(16), false, deps())).toBe('sent');
    expect(await alertOwner(budget(17), false, deps())).toBe('quiet');
    expect(await alertOwner(squashHeld('d'.repeat(40), 'e'.repeat(40)), false, deps())).toBe('sent');
    expect(sent).toHaveLength(2);
  });

  it('never notifies on a dry run', async () => {
    expect(await alertOwner(held('a'.repeat(40)), true, deps())).toBe('skipped');
    expect(await alertOwner({ ...held('a'.repeat(40)), dryRun: true }, false, deps())).toBe('skipped');
    expect(sent).toHaveLength(0);
  });

  it('notifies a failure once per reason, and when the status could not be written', async () => {
    const failed = (error: string): Status => ({ ...ok, status: 'failed', error });
    expect(await alertOwner(failed(`staging commit ${'1a'.repeat(20)} has no GitOrigin-RevId`), false, deps())).toBe(
      'sent',
    );
    expect(await alertOwner(failed(`staging commit ${'2b'.repeat(20)} has no GitOrigin-RevId`), false, deps())).toBe(
      'quiet',
    );
    expect(await alertOwner(failed(`copybara export exited 3 for ${NAME}`), false, deps())).toBe('sent');
    expect(await alertOwner(null, false, deps())).toBe('sent');
    expect(sent.map((message) => message.title)).toEqual([
      'Public export failed',
      'Public export failed',
      'Public export failed',
    ]);
    expect(sent[1].body).toContain('failed: <error text withheld; see the status file>');
    expect(sent[1].body.toLowerCase()).not.toContain(NAME);
  });

  it('retries an undelivered alert on the next run', async () => {
    deliveryCode = 1;
    expect(await alertOwner(held('a'.repeat(40)), false, deps())).toBe('undelivered');
    deliveryCode = 0;
    expect(await alertOwner(held('a'.repeat(40)), false, deps())).toBe('sent');
  });

  it('a successful publish clears the record, so the same hold notifies again', async () => {
    await alertOwner(held('a'.repeat(40)), false, deps());
    expect(await alertOwner(ok, false, deps())).toBe('cleared');
    expect(await alertOwner(held('a'.repeat(40)), false, deps())).toBe('sent');
    expect(sent).toHaveLength(2);
  });
});
