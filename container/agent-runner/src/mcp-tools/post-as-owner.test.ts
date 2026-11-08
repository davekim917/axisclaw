import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getOutboundDb } from '../mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';

const { postAsOwner, uploadAsOwner } = await import('./post-as-owner.js');

let inbound: ReturnType<typeof initTestSessionDb>['inbound'];
beforeEach(() => {
  inbound = initTestSessionDb().inbound;
});
afterEach(() => closeSessionDb());

function request(): { id: string; content: Record<string, unknown> } | undefined {
  const row = getOutboundDb().prepare(`SELECT id, content FROM messages_out WHERE kind = 'system'`).get() as
    | { id: string; content: string }
    | undefined;
  return row && { id: row.id, content: JSON.parse(row.content) as Record<string, unknown> };
}

/** Plays the host: once the request lands, writes the verdict the host would. */
function hostAnswers(status: string, receipt: string | null, error: string | null): void {
  const timer = setInterval(() => {
    const req = request();
    if (!req) return;
    clearInterval(timer);
    inbound
      .prepare(
        `INSERT INTO delivered (message_out_id, platform_message_id, status, error, delivered_at) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(req.id, receipt, status, error, new Date().toISOString());
  }, 20);
}

describe('post_as_owner', () => {
  const TEXT = "It's live.\n<@U0EXAMPLE1> — see thread.";

  it('hands the host the exact text and destination, and reports the posted ts', async () => {
    hostAnswers('delivered', '1790000000.000100', null);
    const result = await postAsOwner.handler({ channel: ' C0EXAMPLE9 ', text: TEXT, thread_ts: '1790000000.000001' });

    expect(request()!.content).toEqual({
      action: 'request_post_as_owner',
      requestId: request()!.id,
      op: 'post',
      channel: 'C0EXAMPLE9',
      text: TEXT,
      threadTs: '1790000000.000001',
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('1790000000.000100');
  });

  it('asks for an edit when given the ts to replace', async () => {
    hostAnswers('delivered', '1790000000.000222', null);
    await postAsOwner.handler({ channel: 'C0EXAMPLE9', text: TEXT, edit_ts: '1790000000.000222' });

    expect(request()!.content).toMatchObject({ op: 'update', ts: '1790000000.000222', text: TEXT });
  });

  it("returns the host's refusal as an error, so a post nobody can approve fails visibly", async () => {
    hostAnswers('failed', null, 'nobody is watching to approve this');
    const result = await postAsOwner.handler({ channel: 'C0EXAMPLE9', text: TEXT });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('nobody is watching to approve this');
  });

  it('says a card is waiting, and not that anything posted, while the host holds it', async () => {
    hostAnswers('pending', null, null);
    const result = await postAsOwner.handler({ channel: 'C0EXAMPLE9', text: TEXT });

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(result.content)).toContain('waiting for approval');
  });

  it('says the host has not answered, and not that anything posted, when no verdict arrives in time', async () => {
    let now = Date.now();
    const clock = spyOn(Date, 'now').mockImplementation(() => (now += 60_000));
    try {
      const result = await postAsOwner.handler({ channel: 'C0EXAMPLE9', text: TEXT });

      expect(request()).toBeTruthy();
      expect(result.isError).toBeFalsy();
      expect(JSON.stringify(result.content)).toContain('the host has not answered yet');
    } finally {
      clock.mockRestore();
    }
  });
});

describe('upload_as_owner', () => {
  it('hands the host a copy of the file in its outbox, with the comment and destination', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'upload-as-owner-'));
    const file = path.join(dir, 'report.csv');
    fs.writeFileSync(file, 'a,b\n1,2\n');
    const copies: Array<[string, string]> = [];
    const mkdir = spyOn(fs, 'mkdirSync').mockImplementation(((target: fs.PathLike, opts?: fs.MakeDirectoryOptions) =>
      String(target).startsWith('/workspace/outbox') ? undefined : fs.mkdirSync.call(fs, target, opts)) as never);
    const copy = spyOn(fs, 'copyFileSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
      copies.push([String(from), String(to)]);
    }) as never);
    try {
      hostAnswers('pending', null, null);
      const result = await uploadAsOwner.handler({ channel: 'C0EXAMPLE9', file, comment: "Here's Q3.", title: 'Q3' });

      const req = request()!;
      expect(req.content).toEqual({
        action: 'request_post_as_owner',
        requestId: req.id,
        op: 'upload',
        channel: 'C0EXAMPLE9',
        file: 'report.csv',
        text: "Here's Q3.",
        title: 'Q3',
      });
      expect(copies).toEqual([[fs.realpathSync(file), `/workspace/outbox/${req.id}/report.csv`]]);
      expect(result.isError).toBeFalsy();
    } finally {
      mkdir.mockRestore();
      copy.mockRestore();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a missing file and asks the host nothing', async () => {
    const result = await uploadAsOwner.handler({ channel: 'C0EXAMPLE9', file: 'no-such-report.csv' });

    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain('File not found: no-such-report.csv');
    expect(request()).toBeFalsy();
  });

  it('refuses a file outside the workspace and asks the host nothing', async () => {
    const result = await uploadAsOwner.handler({ channel: 'C0EXAMPLE9', file: '/etc/hostname' });

    expect(result.isError).toBe(true);
    expect(request()).toBeFalsy();
  });
});
