import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initMigratedTestDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalByRequestId, getSession } from '../../db/sessions.js';
import { initSessionFolder } from '../../session-manager.js';
import { openInboundDb } from '../../modules/mailbox/openers.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { openOutboundDbWritable } from '../../modules/mailbox/openers.js';
import { deliverSessionMessages, setDeliveryAdapter } from '../../delivery.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { __resetArchiveConnectionForTest, archiveMessage } from '../../message-archive.js';
import { convertEmojiPlaceholders } from 'chat';
import type { SlackUserApi } from '../../slack-user-api.js';
import { _setSlackOwnerApiForTest } from './index.js';

const mocks = vi.hoisted(() => ({ deliver: vi.fn(), failRecordingOnce: null as string | null }));
const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-post-as-owner') }));

vi.mock('../../config.js', async () => ({
  ...(await vi.importActual('../../config.js')),
  DATA_DIR: TEST_DIR,
  GROUPS_DIR: `${TEST_DIR}/groups`,
}));
vi.mock('../../session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...actual,
    withExistingMailboxSession: ((agentGroupId, sessionId, action) =>
      actual.withExistingMailboxSession(agentGroupId, sessionId, (mailbox) =>
        action(
          new Proxy(mailbox, {
            get(target, prop, receiver) {
              if (prop !== 'markDelivered' && prop !== 'markPending' && prop !== 'markDeliveryFailed') {
                return Reflect.get(target, prop, receiver);
              }
              return (id: string, ...rest: unknown[]) => {
                if (id === mocks.failRecordingOnce) {
                  mocks.failRecordingOnce = null;
                  throw new Error('SQLITE_BUSY: database is locked');
                }
                return (target[prop] as (...a: unknown[]) => unknown)(id, ...rest);
              };
            },
          }),
        ),
      )) as typeof actual.withExistingMailboxSession,
  };
});
vi.mock('../approvals/card-pointer.js', () => ({ sendCardPointer: vi.fn().mockResolvedValue('skipped-no-recipient') }));
vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../delivery.js', async () => ({
  ...(await vi.importActual<typeof import('../../delivery.js')>('../../delivery.js')),
  getDeliveryAdapter: () => ({ deliver: mocks.deliver }),
}));

const THREAD = 'slack:C123:1790000000.000300';
const TEXT = "Carol — it's live.\nOwner: <@U0EXAMPLE1>, see <#C0EXAMPLE2>.";
const now = () => new Date().toISOString();

interface Sent {
  call: string;
  args: unknown[];
}
let sent: Sent[] = [];
const fakeSlack: SlackUserApi = {
  postMessage: async (...args) => (sent.push({ call: 'postMessage', args }), { ok: true, ts: '1790000000.000100' }),
  updateMessage: async (...args) => (sent.push({ call: 'updateMessage', args }), { ok: true, ts: String(args[1]) }),
  uploadFile: async (...args) => (sent.push({ call: 'uploadFile', args }), { ok: true, fileId: 'F0EXAMPLE' }),
  authTest: async () => (sent.push({ call: 'authTest', args: [] }), { ok: false, error: 'unused' }),
  shareFiles: async (...args) => (sent.push({ call: 'shareFiles', args }), { ok: false, error: 'unused' }),
};
const fakeApiFor = vi.fn(async (_agent: string) => fakeSlack);

function config(cfg: Record<string, unknown>): void {
  fs.mkdirSync(`${TEST_DIR}/groups/agent`, { recursive: true });
  fs.writeFileSync(`${TEST_DIR}/groups/agent/container.json`, JSON.stringify(cfg));
}

function result(sessionId: string, requestId: string): unknown {
  const db = openInboundDb(inboundDbPath('ag-1', sessionId));
  try {
    return (
      db.prepare('SELECT status, platform_message_id, error FROM delivered WHERE message_out_id = ?').get(requestId) ??
      null
    );
  } finally {
    db.close();
  }
}

function toldAgent(sessionId: string): string[] {
  const db = openInboundDb(inboundDbPath('ag-1', sessionId));
  try {
    return (db.prepare("SELECT content FROM messages_in WHERE kind = 'chat'").all() as Array<{ content: string }>).map(
      (r) => (JSON.parse(r.content) as { text: string }).text,
    );
  } finally {
    db.close();
  }
}

let seq = 0;
async function request(sessionId: string, content: Record<string, unknown>): Promise<void> {
  const db = openOutboundDbWritable(outboundDbPath('ag-1', sessionId));
  try {
    db.prepare("INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES (?, ?, ?, 'system', ?)").run(
      content.requestId,
      ++seq * 2 + 1,
      now(),
      JSON.stringify({ action: 'request_post_as_owner', ...content }),
    );
  } finally {
    db.close();
  }
  // Through the real delivery loop, which acks a row unless the action owns it.
  await deliverSessionMessages((await getSession(sessionId))!);
}

async function click(requestId: string, userId: string, value: 'approve' | 'reject' = 'approve'): Promise<void> {
  const card = await getPendingApprovalByRequestId(requestId);
  expect(card).toBeDefined();
  await handleApprovalsResponse({
    questionId: card!.approval_id,
    value,
    userId,
    channelType: 'slack-example-labs',
    platformId: 'slack:C123',
    threadId: THREAD,
    messageId: 'pm-1',
  });
}

function archived(role: 'user' | 'assistant', text: string, second: number, senderId: string | null = null): void {
  archiveMessage(
    {
      id: `arch-${++seq}`,
      agentGroupId: 'ag-1',
      messagingGroupId: 'mg-1',
      channelType: 'slack-example-labs',
      channelName: '#support',
      platformId: 'slack:C123',
      threadId: THREAD,
      role,
      senderId: role === 'user' ? senderId : 'ag-1',
      senderName: role === 'user' ? senderId : 'assistant',
      senderIsBot: role === 'user' ? false : undefined,
      text,
      sentAt: new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString(),
    },
    { workgroupId: null },
  );
}

function cardsPosted(): Array<{ title: string; question: string }> {
  return mocks.deliver.mock.calls.map((c) => JSON.parse(c[4] as string) as { title: string; question: string });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  __resetArchiveConnectionForTest();
  sent = [];
  fakeApiFor.mockClear();
  _setSlackOwnerApiForTest(fakeApiFor);
  mocks.deliver.mockReset();
  mocks.failRecordingOnce = null;
  mocks.deliver.mockResolvedValue('pm-1');
  setDeliveryAdapter({ deliver: mocks.deliver });
  await getDb().run('INSERT INTO workgroups (id, created_at) VALUES (?, ?)', 'example-labs', now());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Agent',
    folder: 'agent',
    agent_provider: null,
    created_at: now(),
    workgroup_id: 'example-labs',
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'slack-example-labs',
    platform_id: 'slack:C123',
    instance: 'slack-example-labs',
    name: '#support',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  const base = { agent_group_id: 'ag-1', agent_provider: null, status: 'active', container_status: 'running' } as const;
  await createSession({
    ...base,
    id: 'sess-1',
    messaging_group_id: 'mg-1',
    thread_id: THREAD,
    last_active: now(),
    created_at: now(),
  });
  initSessionFolder('ag-1', 'sess-1');
  await createSession({
    ...base,
    id: 'sess-bg',
    messaging_group_id: null,
    thread_id: `system:tasks:dispatch-${'b'.repeat(64)}`,
    last_active: now(),
    created_at: now(),
  });
  initSessionFolder('ag-1', 'sess-bg');
  const bg = openInboundDb(inboundDbPath('ag-1', 'sess-bg'));
  try {
    bg.prepare(
      `INSERT INTO messages_in (id, seq, timestamp, status, tries, kind, content) VALUES ('task-1', 2, ?, 'completed', 0, 'task', ?)`,
    ).run(now(), JSON.stringify({ prompt: 'Draft the weekly reply to the vendor.', originSessionId: 'sess-1' }));
  } finally {
    bg.close();
  }
  for (const [id, role] of [
    ['slack-example-labs:owner', 'owner'],
    ['slack-example-labs:admin', 'admin'],
    ['slack-example-labs:member', null],
  ] as const) {
    await upsertUser({ id, kind: 'slack', display_name: id, created_at: now() });
    if (role) {
      await grantRole({
        user_id: id,
        role,
        agent_group_id: role === 'admin' ? 'ag-1' : null,
        granted_by: null,
        granted_at: now(),
      });
    }
  }
  await createMessagingGroup({
    id: 'mg-dm-owner',
    channel_type: 'slack-example-labs',
    platform_id: 'slack:D0OWNER',
    name: 'owner',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({
    user_id: 'slack-example-labs:owner',
    channel_type: 'slack-example-labs',
    messaging_group_id: 'mg-dm-owner',
    resolved_at: now(),
  });
  config({
    post_as_owner: true,
    sends_as_user_id: 'slack-example-labs:owner',
    slack_user_token: { also_allowed_in: ['mg-1'] },
  });
});

afterEach(async () => {
  _setSlackOwnerApiForTest(null);
  __resetArchiveConnectionForTest();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('a post the owner already said "send" to', () => {
  it('still takes a card: a send word never stands in for it', async () => {
    archived('assistant', TEXT, 1);
    archived('user', 'send', 2, 'slack-example-labs:owner');
    await request('sess-1', { requestId: 'req-send', op: 'post', channel: 'C0EXAMPLE9', text: TEXT });

    expect(sent).toEqual([]);
    expect(cardsPosted()).toHaveLength(1);
    expect(result('sess-1', 'req-send')).toMatchObject({ status: 'pending' });
  });
});

describe('the identity that posts', () => {
  it("posts through the workspace's reserved agent, never the group's own identity", async () => {
    await request('sess-1', { requestId: 'req-who', op: 'post', channel: 'C0EXAMPLE9', text: TEXT });
    await click('req-who', 'slack-example-labs:owner');

    expect(fakeApiFor.mock.calls).toEqual([['approved-run-slack-owner-example-labs']]);
    expect(sent).toHaveLength(1);
  });

  it.each([
    ['an underscore', 'example_labs'],
    ['an uppercase letter', 'example-Labs'],
    ['over 51 characters', 'x'.repeat(52)],
  ])('a workgroup id with %s is refused before a card, and nothing posts', async (_why, id) => {
    await getDb().run('INSERT INTO workgroups (id, created_at) VALUES (?, ?)', id, new Date().toISOString());
    await getDb().run('UPDATE agent_groups SET workgroup_id = ? WHERE id = ?', id, 'ag-1');
    await request('sess-1', { requestId: 'req-wgid', op: 'post', channel: 'C0EXAMPLE9', text: TEXT });

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(fakeApiFor).not.toHaveBeenCalled();
    expect(result('sess-1', 'req-wgid')).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/lowercase letters, digits and hyphens, at most 51/),
    });
  });

  it('a group outside any workgroup is refused before a card', async () => {
    await getDb().run('UPDATE agent_groups SET workgroup_id = NULL WHERE id = ?', 'ag-1');
    await request('sess-1', { requestId: 'req-nowg', op: 'post', channel: 'C0EXAMPLE9', text: TEXT });

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(result('sess-1', 'req-nowg')).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/workgroup/),
    });
  });
});

describe('a post with no send', () => {
  it('shows exactly one card with the exact text, and posts that text on an admin approval only', async () => {
    await request('sess-1', {
      requestId: 'req-card',
      op: 'post',
      channel: 'C0EXAMPLE9',
      threadTs: '1790000000.000001',
      text: TEXT,
    });

    const cards = cardsPosted();
    expect(cards).toHaveLength(1);
    expect(cards[0].question).toContain('```\n' + TEXT + '\n```');
    expect(cards[0].question).toContain('<#C0EXAMPLE9>, in the thread of 1790000000.000001');
    expect(sent).toEqual([]);

    await click('req-card', 'slack-example-labs:member');
    expect(sent).toEqual([]);
    await click('req-card', 'slack-example-labs:admin');
    expect(sent).toEqual([{ call: 'postMessage', args: ['C0EXAMPLE9', TEXT, '1790000000.000001'] }]);
    expect(result('sess-1', 'req-card')).toMatchObject({
      status: 'delivered',
      platform_message_id: '1790000000.000100',
    });
  });

  it('an edit shows and sends the exact new text for that message', async () => {
    await request('sess-1', {
      requestId: 'req-edit',
      op: 'update',
      channel: 'C0EXAMPLE9',
      ts: '1790000000.000222',
      text: TEXT,
    });

    expect(cardsPosted()[0].question).toContain(
      'Edit your message 1790000000.000222 in <#C0EXAMPLE9> to exactly:\n\n```\n' + TEXT,
    );
    await click('req-edit', 'slack-example-labs:owner');
    expect(sent).toEqual([{ call: 'updateMessage', args: ['C0EXAMPLE9', '1790000000.000222', TEXT] }]);
  });

  it('an edit that names a thread is refused, so no card shows a thread the edit never checks', async () => {
    await request('sess-1', {
      requestId: 'req-edit-thread',
      op: 'update',
      channel: 'C0EXAMPLE9',
      ts: '1790000000.000222',
      threadTs: '1790000000.000001',
      text: TEXT,
    });

    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(result('sess-1', 'req-edit-thread')).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/edit takes no thread_ts/),
    });
  });

  it('the card shows an emoji placeholder as written, after the chat library renders it', async () => {
    const text = 'Use {{emoji:heart}} in the template, and ``` for code.';
    await request('sess-1', { requestId: 'req-emoji', op: 'post', channel: 'C0EXAMPLE9', text });

    const rendered = convertEmojiPlaceholders(cardsPosted()[0].question, 'slack').replace(/\u200b/g, '');
    expect(rendered).toContain('```\n' + text + '\n```');
    await click('req-emoji', 'slack-example-labs:owner');
    expect(sent).toEqual([{ call: 'postMessage', args: ['C0EXAMPLE9', text, undefined] }]);
  });

  it('a card whose pending mark fails is not posted again on the retry, and its approval sends once', async () => {
    mocks.failRecordingOnce = 'req-pend';
    await request('sess-1', { requestId: 'req-pend', op: 'post', channel: 'C0EXAMPLE9', text: TEXT });
    await deliverSessionMessages((await getSession('sess-1'))!);

    expect(cardsPosted()).toHaveLength(1);
    expect(result('sess-1', 'req-pend')).toMatchObject({ status: 'pending' });
    await click('req-pend', 'slack-example-labs:owner');
    expect(sent).toHaveLength(1);
  });

  it('an approved post whose result fails to record still tells the agent it posted', async () => {
    await request('sess-1', { requestId: 'req-replay-ack', op: 'post', channel: 'C0EXAMPLE9', text: TEXT });
    mocks.failRecordingOnce = 'req-replay-ack';
    await click('req-replay-ack', 'slack-example-labs:owner');

    expect(sent).toHaveLength(1);
    expect(toldAgent('sess-1')).toEqual([expect.stringMatching(/^Approved and posted \(ts 1790000000\.000100\)/)]);
  });

  it('a reject sends nothing and tells the waiting tool', async () => {
    await request('sess-1', { requestId: 'req-no', op: 'post', channel: 'C0EXAMPLE9', text: TEXT });
    await click('req-no', 'slack-example-labs:owner', 'reject');

    expect(sent).toEqual([]);
    expect(result('sess-1', 'req-no')).toMatchObject({
      status: 'failed',
      error: 'Declined on the card; nothing was sent.',
    });
  });

  it('an approval older than an hour sends nothing', async () => {
    await request('sess-1', { requestId: 'req-old', op: 'post', channel: 'C0EXAMPLE9', text: TEXT });
    await getDb().run(
      'UPDATE pending_approvals SET created_at = ? WHERE request_id = ?',
      new Date(Date.now() - 61 * 60 * 1000).toISOString(),
      'req-old',
    );
    await click('req-old', 'slack-example-labs:owner');

    expect(sent).toEqual([]);
    expect(result('sess-1', 'req-old')).toMatchObject({ status: 'failed' });
  });
});

describe('a send Slack does not complete', () => {
  it.each([
    [
      'refuses',
      async () => ({ ok: false, error: 'channel_not_found' }),
      /Slack refused it \(channel_not_found\); nothing was sent/,
    ],
    [
      'never answers',
      async () => Promise.reject(new Error('socket hang up')),
      /may or may not have gone out; check the channel/,
    ],
  ])('when Slack %s, the agent and the card say so', async (label, postMessage, why) => {
    const id = `req-fail-${label.replace(/\W+/g, '-')}`;
    _setSlackOwnerApiForTest(async () => ({ ...fakeSlack, postMessage }));
    await request('sess-1', { requestId: id, op: 'post', channel: 'C0EXAMPLE9', text: TEXT });
    await click(id, 'slack-example-labs:owner');

    expect((result('sess-1', id) as { error: string }).error).toMatch(why);
    expect(toldAgent('sess-1').filter((t) => t.startsWith('Post as the owner failed:'))).toEqual([
      expect.stringMatching(why),
    ]);
    const cardSays = mocks.deliver.mock.calls.slice(1).map((c) => String(c[4]));
    expect(cardSays.some((c) => why.test(c))).toBe(true);
    if (why.source.startsWith('may or may not')) expect(cardSays.join()).not.toMatch(/Nothing was sent/i);
  });
});

describe('an upload', () => {
  function handOver(requestId: string, bytes: string): void {
    const dir = `${TEST_DIR}/v2-sessions/ag-1/sess-1/outbox/${requestId}`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(`${dir}/report.csv`, bytes);
  }

  it('shows the file and comment on a card and uploads those bytes on approval', async () => {
    handOver('req-up', 'a,b\n1,2\n');
    await request('sess-1', {
      requestId: 'req-up',
      op: 'upload',
      channel: 'C0EXAMPLE9',
      file: 'report.csv',
      text: TEXT,
    });

    const q = cardsPosted()[0].question;
    expect(q).toContain('Upload `report.csv` (8 bytes, sha256 ');
    expect(q).toContain('With this comment, exactly:\n\n```\n' + TEXT);
    await click('req-up', 'slack-example-labs:owner');
    expect(sent).toEqual([
      {
        call: 'uploadFile',
        args: [
          'C0EXAMPLE9',
          { name: 'report.csv', bytes: Buffer.from('a,b\n1,2\n') },
          { threadTs: undefined, title: undefined, comment: TEXT },
        ],
      },
    ]);
  });

  it('a file rewritten between the approval check and the upload is not uploaded', async () => {
    handOver('req-race', 'a,b\n1,2\n');
    await request('sess-1', {
      requestId: 'req-race',
      op: 'upload',
      channel: 'C0EXAMPLE9',
      file: 'report.csv',
      text: '',
    });
    _setSlackOwnerApiForTest(async (agent) => {
      handOver('req-race', 'a,b\n9,9\n');
      return fakeApiFor(agent);
    });
    await click('req-race', 'slack-example-labs:owner');

    expect(sent).toEqual([]);
    expect(result('sess-1', 'req-race')).toMatchObject({ status: 'failed' });
  });

  it('a file changed after the card is not uploaded', async () => {
    handOver('req-swap', 'a,b\n1,2\n');
    await request('sess-1', {
      requestId: 'req-swap',
      op: 'upload',
      channel: 'C0EXAMPLE9',
      file: 'report.csv',
      text: '',
    });
    handOver('req-swap', 'a,b\n9,9\n');
    await click('req-swap', 'slack-example-labs:owner');

    expect(sent).toEqual([]);
    expect(result('sess-1', 'req-swap')).toMatchObject({ status: 'failed' });
  });
});

describe('who may ask', () => {
  it("a background task's post gets its card in the owner's DM, answerable by the owner alone", async () => {
    await request('sess-bg', { requestId: 'req-bg', op: 'post', channel: 'C0EXAMPLE9', text: TEXT });

    const card = await getPendingApprovalByRequestId('req-bg');
    expect(card).toMatchObject({ platform_id: 'slack:D0OWNER', approver_user_id: 'slack-example-labs:owner' });
    expect(card!.question).toContain('Draft the weekly reply to the vendor.');
    await click('req-bg', 'slack-example-labs:admin');
    expect(sent).toEqual([]);
    await click('req-bg', 'slack-example-labs:owner');
    expect(sent).toHaveLength(1);
  });

  it.each([
    [
      'nobody is set to approve a background post',
      'sess-bg',
      { post_as_owner: true, slack_user_token: { also_allowed_in: ['mg-1'] } },
      /nobody is watching/,
    ],
    [
      'the agent is not turned on',
      'sess-1',
      { sends_as_user_id: 'slack-example-labs:owner', slack_user_token: { also_allowed_in: ['mg-1'] } },
      /not turned on/,
    ],
    [
      'the conversation is not one the owner’s token reaches',
      'sess-1',
      { post_as_owner: true, sends_as_user_id: 'slack-example-labs:owner' },
      /owner's own Slack contexts/,
    ],
  ])('refuses visibly when %s', async (_label, sessionId, cfg, why) => {
    config(cfg);
    await request(sessionId, { requestId: 'req-refused', op: 'post', channel: 'C0EXAMPLE9', text: TEXT });

    expect(sent).toEqual([]);
    expect(mocks.deliver).not.toHaveBeenCalled();
    const row = result(sessionId, 'req-refused') as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toMatch(why);
  });
});
