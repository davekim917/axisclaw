/**
 * "Reject with reason…" capture flow.
 *
 * Covers the three entry points end to end against the real central DB:
 *   - arming (handleApprovalsResponse with the third option) holds the row and
 *     prompts the admin instead of finalizing;
 *   - the captured reply relays one combined message, clamped to 280 chars;
 *   - the host sweep finalizes a ghosted hold as a plain reject.
 *
 * writeSessionMessage is mocked so the relayed agent-facing text can be read
 * back directly; the delivery adapter is a fake that records prompt sends.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboundEvent } from '../../channels/adapter.js';
import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import {
  createSession,
  createPendingApproval,
  deletePendingApproval,
  getPendingApproval,
  markApprovalAwaitingReason,
  restartApprovalReasonWindow,
} from '../../db/sessions.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { initSessionFolder, writeSessionMessage } from '../../session-manager.js';
import { openInboundDb as openInboundDbAt } from '../mailbox/openers.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import type { PendingApproval } from '../../types.js';
import { recordCardCopy } from './card-copies.js';
import { REJECT_WITH_REASON_VALUE } from './primitive.js';

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-reject-reason') }));
const DM_CHANNEL = 'slack';
const DM_PLATFORM = 'D-admin-1';

function now(): string {
  return new Date().toISOString();
}

let delivered: Array<{ channelType: string; platformId: string; threadId: string | null; content: string }>;

const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver(channelType, platformId, threadId, _kind, content) {
    delivered.push({ channelType, platformId, threadId, content });
    return 'pm-1';
  },
};

async function seedApproval(
  approvalId: string,
  action = 'create_agent',
  card: Partial<PendingApproval> = {},
): Promise<void> {
  await createPendingApproval({
    ...card,
    approval_id: approvalId,
    session_id: 'sess-1',
    request_id: approvalId,
    action,
    payload: JSON.stringify({ name: 'child' }),
    created_at: now(),
    title: 'Approval',
    options_json: JSON.stringify([]),
  });
}

function dmReply(text?: string): InboundEvent {
  const content: Record<string, unknown> = { sender: 'admin-1', senderId: 'admin-1' };
  if (text !== undefined) content.text = text;
  return {
    channelType: DM_CHANNEL,
    platformId: DM_PLATFORM,
    threadId: null,
    message: { id: 'm-1', kind: 'chat', content: JSON.stringify(content), timestamp: now() },
  };
}

/** Click the "Reject with reason…" button as the seeded admin. */
async function clickRejectWithReason(
  approvalId: string,
  at: { platformId: string; threadId: string | null; messageId?: string } = { platformId: '', threadId: null },
): Promise<void> {
  const { handleApprovalsResponse } = await import('./response-handler.js');
  await handleApprovalsResponse({
    questionId: approvalId,
    value: REJECT_WITH_REASON_VALUE,
    userId: 'admin-1',
    channelType: DM_CHANNEL,
    // A card with a stored location takes a click only on that card message.
    platformId: at.platformId,
    threadId: at.threadId,
    ...(at.messageId ? { messageId: at.messageId } : {}),
  });
}

/** The text of the most recent agent-facing note written via writeSessionMessage. */
function lastRelayedText(): string | undefined {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1);
  if (!call) return undefined;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  delivered = [];

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });

  // Authorized approver + a cached DM so ensureUserDm resolves without a
  // platform openDM call.
  await upsertUser({ id: 'slack:admin-1', kind: 'slack', display_name: 'Admin', created_at: now() });
  await grantRole({
    user_id: 'slack:admin-1',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: DM_CHANNEL,
    platform_id: DM_PLATFORM,
    name: 'Admin DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({
    user_id: 'slack:admin-1',
    channel_type: DM_CHANNEL,
    messaging_group_id: 'mg-dm-1',
    resolved_at: now(),
  });

  setDeliveryAdapter(fakeAdapter);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('reject with reason', () => {
  it('holds the row and prompts the admin instead of finalizing', async () => {
    await seedApproval('appr-1');
    await clickRejectWithReason('appr-1');

    const row = await getPendingApproval('appr-1');
    expect(row?.status).toBe('awaiting_reason');
    expect(row?.expires_at).toBeTruthy();

    // Prompt went to the admin's resolved DM, not the (empty) click platformId.
    expect(delivered).toHaveLength(1);
    expect(delivered[0].channelType).toBe(DM_CHANNEL);
    expect(delivered[0].platformId).toBe(DM_PLATFORM);
    expect((JSON.parse(delivered[0].content) as { text: string }).text).toMatch(/reason/i);

    // Agent is not notified yet — the hold is still open.
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });

  it('relays the captured reason as one combined message and clears the row', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    await seedApproval('appr-2', 'install_packages');
    await clickRejectWithReason('appr-2');

    const consumed = await captureReasonReply(dmReply('too risky for prod'));

    expect(consumed).toBe(true);
    expect(await getPendingApproval('appr-2')).toBeUndefined();
    expect(lastRelayedText()).toBe('Your install_packages request was rejected by admin: "too risky for prod"');
  });

  it('truncates an over-long reason to 280 chars with an ellipsis', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    await seedApproval('appr-3');
    await clickRejectWithReason('appr-3');

    await captureReasonReply(dmReply('x'.repeat(400)));

    const reason = lastRelayedText()!.match(/: "(.*)"$/)![1];
    expect(reason).toHaveLength(280);
    expect(reason.endsWith('…')).toBe(true);
  });

  it('finalizes a plain reject when the captured reply carries no text', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    await seedApproval('appr-4');
    await clickRejectWithReason('appr-4');

    const consumed = await captureReasonReply(dmReply(undefined));

    expect(consumed).toBe(true);
    expect(await getPendingApproval('appr-4')).toBeUndefined();
    expect(lastRelayedText()).toBe('Your create_agent request was rejected by admin.');
  });

  it('does not swallow a later DM once the hold was already finalized', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    await seedApproval('appr-5');
    await clickRejectWithReason('appr-5');
    // Simulate the sweep (or any other path) finalizing first.
    await deletePendingApproval('appr-5');

    const consumed = await captureReasonReply(dmReply('late reason'));

    expect(consumed).toBe(false);
  });

  it('ignores DMs on channels with no armed reason capture', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    const consumed = await captureReasonReply({
      channelType: DM_CHANNEL,
      platformId: 'D-someone-else',
      threadId: null,
      message: { id: 'm', kind: 'chat', content: JSON.stringify({ text: 'hi' }), timestamp: now() },
    });
    expect(consumed).toBe(false);
  });
});

describe('reject-with-reason host sweep', () => {
  it('finalizes a hold whose window elapsed as a plain reject', async () => {
    const { sweepAwaitingReasonRejects } = await import('./reason-capture.js');
    await seedApproval('appr-ghost', 'add_mcp_server');
    await markApprovalAwaitingReason('appr-ghost', new Date(Date.now() - 1000).toISOString());

    await sweepAwaitingReasonRejects();

    expect(await getPendingApproval('appr-ghost')).toBeUndefined();
    expect(lastRelayedText()).toBe('Your add_mcp_server request was rejected by admin.');
  });

  it('leaves a still-open hold untouched', async () => {
    const { sweepAwaitingReasonRejects } = await import('./reason-capture.js');
    await seedApproval('appr-open');
    await markApprovalAwaitingReason('appr-open', new Date(Date.now() + 60_000).toISOString());

    await sweepAwaitingReasonRejects();

    expect((await getPendingApproval('appr-open'))?.status).toBe('awaiting_reason');
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
  });
});

describe('a reject-with-reason racing another answer', () => {
  it('does not run the action when Approve lands while the reason prompt is still being sent', async () => {
    const { registerApprovalHandler } = await import('./primitive.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    const handler = vi.fn().mockResolvedValue(undefined);
    registerApprovalHandler('install_packages_held', handler);
    await seedApproval('appr-held', 'install_packages_held');
    let releasePrompt!: () => void;
    setDeliveryAdapter({
      deliver: () => new Promise<string>((resolve) => (releasePrompt = () => resolve('pm-1'))),
    });

    const hold = clickRejectWithReason('appr-held');
    await vi.waitFor(() => expect(releasePrompt).toBeDefined());
    await handleApprovalsResponse({
      questionId: 'appr-held',
      value: 'approve',
      userId: 'admin-1',
      channelType: DM_CHANNEL,
      platformId: '',
      threadId: null,
    });
    releasePrompt();
    await hold;

    expect(handler).not.toHaveBeenCalled();
    expect((await getPendingApproval('appr-held'))?.status).toBe('awaiting_reason');
  });

  it('tells the agent once when the reason reply and the expiry sweep finalize together', async () => {
    const { captureReasonReply, sweepAwaitingReasonRejects } = await import('./reason-capture.js');
    await seedApproval('appr-both');
    await clickRejectWithReason('appr-both');
    await restartApprovalReasonWindow('appr-both', new Date(Date.now() - 1000).toISOString());

    await Promise.all([captureReasonReply(dmReply('not now')), sweepAwaitingReasonRejects()]);

    expect(vi.mocked(writeSessionMessage)).toHaveBeenCalledTimes(1);
    expect(await getPendingApproval('appr-both')).toBeUndefined();
  });
});

describe('a reason prompt still in flight when the hold expires', () => {
  it('is not re-armed, and its finished card not reopened, after the sweep closed the hold', async () => {
    const { captureReasonReply, sweepAwaitingReasonRejects } = await import('./reason-capture.js');
    await createPendingApproval({
      approval_id: 'appr-slow-prompt',
      session_id: 'sess-1',
      request_id: 'appr-slow-prompt',
      action: 'create_agent',
      payload: JSON.stringify({ name: 'child' }),
      created_at: now(),
      title: 'Approval',
      options_json: JSON.stringify([]),
      channel_type: DM_CHANNEL,
      platform_id: DM_PLATFORM,
      platform_message_id: 'card-1',
    });
    let releasePrompt!: () => void;
    const cardEdits: string[] = [];
    setDeliveryAdapter({
      deliver: (_channelType, _platformId, _threadId, _kind, content) => {
        if (!releasePrompt) return new Promise<string>((resolve) => (releasePrompt = () => resolve('pm-1')));
        cardEdits.push(content);
        return Promise.resolve('pm-edit');
      },
    });

    const { handleApprovalsResponse } = await import('./response-handler.js');
    const hold = handleApprovalsResponse({
      questionId: 'appr-slow-prompt',
      value: REJECT_WITH_REASON_VALUE,
      userId: 'admin-1',
      channelType: DM_CHANNEL,
      platformId: '',
      threadId: null,
      messageId: 'card-1',
    });
    await vi.waitFor(() => expect(releasePrompt).toBeDefined());
    await restartApprovalReasonWindow('appr-slow-prompt', new Date(Date.now() - 1000).toISOString());
    await sweepAwaitingReasonRejects();
    const editsWhenClosed = cardEdits.length;
    releasePrompt();
    await hold;

    expect(cardEdits).toHaveLength(editsWhenClosed);
    expect(await captureReasonReply(dmReply('late'))).toBe(false);
  });
});

describe('the expiry sweep', () => {
  it('leaves a hold whose window was restarted after the sweep listed it', async () => {
    const { sweepAwaitingReasonRejects } = await import('./reason-capture.js');
    await seedApproval('appr-a');
    await seedApproval('appr-b');
    const past = new Date(Date.now() - 1000).toISOString();
    await markApprovalAwaitingReason('appr-a', past);
    await markApprovalAwaitingReason('appr-b', past);
    let releaseNote!: () => void;
    vi.mocked(writeSessionMessage).mockImplementationOnce(
      () => new Promise<void>((resolve) => (releaseNote = resolve)),
    );

    const sweep = sweepAwaitingReasonRejects();
    await vi.waitFor(() => expect(releaseNote).toBeDefined());
    await restartApprovalReasonWindow('appr-b', new Date(Date.now() + 60_000).toISOString());
    releaseNote();
    await sweep;

    expect((await getPendingApproval('appr-b'))?.status).toBe('awaiting_reason');
  });
});

describe('plain reject (regression)', () => {
  it('finalizes immediately with no reason and no DM prompt', async () => {
    const { handleApprovalsResponse } = await import('./response-handler.js');
    await seedApproval('appr-plain', 'install_packages');

    await handleApprovalsResponse({
      questionId: 'appr-plain',
      value: 'reject',
      userId: 'admin-1',
      channelType: DM_CHANNEL,
      platformId: '',
      threadId: null,
    });

    expect(await getPendingApproval('appr-plain')).toBeUndefined();
    expect(delivered).toHaveLength(0);
    expect(lastRelayedText()).toBe('Your install_packages request was rejected by admin.');
  });
});

describe('a rejected command gate', () => {
  async function seedGateApproval(): Promise<void> {
    await import('../bash-gate/index.js');
    initSessionFolder('ag-1', 'sess-1');
    await createPendingApproval({
      approval_id: 'appr-gate',
      session_id: 'sess-1',
      request_id: 'gate-1',
      action: 'bash-gate',
      payload: JSON.stringify({
        requestId: 'gate-1',
        sessionId: 'sess-1',
        label: 'Email send',
        summary: '',
        command: '',
      }),
      created_at: now(),
      title: 'Email send',
      options_json: JSON.stringify([]),
    });
  }

  function gateAck(): unknown {
    const inbound = openInboundDbAt(inboundDbPath('ag-1', 'sess-1'));
    try {
      return inbound.prepare('SELECT status, error FROM delivered WHERE message_out_id = ?').get('gate-1');
    } finally {
      inbound.close();
    }
  }

  it.each([['reject'], [REJECT_WITH_REASON_VALUE]])(
    'fails the waiting container’s gate at the click (%s), before any reason arrives',
    async (value) => {
      await seedGateApproval();
      const { handleApprovalsResponse } = await import('./response-handler.js');

      await handleApprovalsResponse({
        questionId: 'appr-gate',
        value,
        userId: 'admin-1',
        channelType: DM_CHANNEL,
        platformId: '',
        threadId: null,
      });

      expect(gateAck()).toEqual({ status: 'failed', error: 'Rejected by an approver.' });
    },
  );

  it('ignores an Approve that arrives while the reject waits for its reason', async () => {
    await seedGateApproval();
    const { handleApprovalsResponse, resolveApprovalFromHost } = await import('./response-handler.js');
    const click = (value: string) =>
      handleApprovalsResponse({
        questionId: 'appr-gate',
        value,
        userId: 'admin-1',
        channelType: DM_CHANNEL,
        platformId: '',
        threadId: null,
      });

    await click(REJECT_WITH_REASON_VALUE);
    expect((await getPendingApproval('appr-gate'))?.status).toBe('awaiting_reason');

    await click('approve');
    expect(await resolveApprovalFromHost('appr-gate', 'approve', 'slack:admin-1')).toEqual({
      resolved: false,
      error: 'Approval appr-gate was already rejected; it is waiting for the reason.',
    });

    expect(gateAck()).toEqual({ status: 'failed', error: 'Rejected by an approver.' });
    expect((await getPendingApproval('appr-gate'))?.status).toBe('awaiting_reason');
  });

  it('fails the gate when a hold parked before this version ends at the sweep', async () => {
    await seedGateApproval();
    await markApprovalAwaitingReason('appr-gate', new Date(Date.now() - 1000).toISOString());
    const { sweepAwaitingReasonRejects } = await import('./reason-capture.js');

    await sweepAwaitingReasonRejects();

    expect(await getPendingApproval('appr-gate')).toBeUndefined();
    expect(gateAck()).toEqual({ status: 'failed', error: 'Rejected by an approver.' });
  });
});

describe("reject with reason, asked in the card's thread", () => {
  const ROOM = 'slack:C-room';
  const THREAD = 'slack:C-room:111.1';
  const inThread = { channel_type: 'slack', platform_id: ROOM, thread_id: THREAD, platform_message_id: '222.2' };

  // The reason prompt among everything delivered; the card edit goes to the same place and must not stand in for it.
  function prompts() {
    return delivered.filter((d) => {
      const c = JSON.parse(d.content) as { text?: string; operation?: string };
      return !c.operation && /reason/i.test(c.text ?? '');
    });
  }

  function reply(threadId: string | null, sender: string, text: string, platformId = ROOM): InboundEvent {
    return {
      channelType: 'slack',
      platformId,
      threadId,
      message: {
        id: 'm-t',
        kind: 'chat-sdk',
        content: JSON.stringify({ text, author: { userId: sender } }),
        timestamp: now(),
      },
    };
  }

  it("prompts in the card's thread and relays the clicker's reply there", async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    await seedApproval('appr-t1', 'install_packages', inThread);
    await clickRejectWithReason('appr-t1', { platformId: ROOM, threadId: THREAD, messageId: '222.2' });

    expect(prompts().map((d) => [d.platformId, d.threadId])).toEqual([[ROOM, THREAD]]);
    expect(delivered.some((d) => d.platformId === DM_PLATFORM)).toBe(false);

    expect(await captureReasonReply(reply(THREAD, 'admin-1', 'wrong schema'))).toBe(true);
    expect(lastRelayedText()).toBe('Your install_packages request was rejected by admin: "wrong schema"');
    expect(await getPendingApproval('appr-t1')).toBeUndefined();
  });

  it('pressed on the DM copy of a thread card, it prompts in that DM and takes the reply there', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    const copy = { channel_type: DM_CHANNEL, platform_id: DM_PLATFORM, instance: null, platform_message_id: 'copy-1' };
    await seedApproval('appr-tc', 'install_packages', inThread);
    await recordCardCopy('appr-tc', copy);
    await clickRejectWithReason('appr-tc', { platformId: DM_PLATFORM, threadId: null, messageId: 'copy-1' });

    expect(prompts().map((d) => [d.platformId, d.threadId])).toEqual([[DM_PLATFORM, null]]);
    expect(await captureReasonReply(reply(THREAD, 'admin-1', 'in the thread'))).toBe(false);
    expect(await captureReasonReply(dmReply('wrong schema'))).toBe(true);
    expect(lastRelayedText()).toBe('Your install_packages request was rejected by admin: "wrong schema"');
  });

  it("leaves someone else's message in the thread alone and keeps waiting for the clicker", async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    await seedApproval('appr-t2', 'install_packages', inThread);
    await clickRejectWithReason('appr-t2', { platformId: ROOM, threadId: THREAD, messageId: '222.2' });

    expect(await captureReasonReply(reply(THREAD, 'teammate-2', 'what happened?'))).toBe(false);
    expect((await getPendingApproval('appr-t2'))?.status).toBe('awaiting_reason');

    expect(await captureReasonReply(reply(THREAD, 'admin-1', 'not now'))).toBe(true);
    expect(lastRelayedText()).toBe('Your install_packages request was rejected by admin: "not now"');
  });

  it('does not take a DM as the reason when the card has a thread', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    await seedApproval('appr-t3', 'install_packages', inThread);
    await clickRejectWithReason('appr-t3', { platformId: ROOM, threadId: THREAD, messageId: '222.2' });

    expect(await captureReasonReply(dmReply('in the dm'))).toBe(false);
    expect((await getPendingApproval('appr-t3'))?.status).toBe('awaiting_reason');
  });

  it('asks beside a card with no thread, and takes the reply there or under the card', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    await seedApproval('appr-t4', 'install_packages', { ...inThread, thread_id: null });
    await clickRejectWithReason('appr-t4', { platformId: ROOM, threadId: null, messageId: '222.2' });

    // A DM can't hold a thread, so the prompt goes beside the card, never into an invented thread.
    expect(prompts().map((d) => [d.platformId, d.threadId])).toEqual([[ROOM, null]]);
    expect(await captureReasonReply(reply(`${ROOM}:222.2`, 'admin-1', 'duplicate'))).toBe(true);

    await seedApproval('appr-t5', 'install_packages', { ...inThread, thread_id: null, platform_message_id: '555.5' });
    await clickRejectWithReason('appr-t5', { platformId: ROOM, threadId: null, messageId: '555.5' });
    expect(await captureReasonReply(reply(null, 'admin-1', 'beside it'))).toBe(true);
    expect(lastRelayedText()).toBe('Your install_packages request was rejected by admin: "beside it"');
  });

  it('takes a top-level DM reply, which the Slack bridge labels with its own id as thread', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    await seedApproval('appr-t8', 'install_packages', { ...inThread, thread_id: null, platform_message_id: '666.6' });
    await clickRejectWithReason('appr-t8', { platformId: ROOM, threadId: null, messageId: '666.6' });

    const event = reply(`${ROOM}:999.9`, 'admin-1', 'top level');
    event.message.nativeId = '999.9';
    expect(await captureReasonReply(event)).toBe(true);
    expect(lastRelayedText()).toBe('Your install_packages request was rejected by admin: "top level"');
  });

  it('takes a Discord DM reply, which the bridge labels with the channel itself as thread', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    await seedApproval('appr-t9', 'install_packages', { ...inThread, thread_id: null, platform_message_id: '777.7' });
    await clickRejectWithReason('appr-t9', { platformId: ROOM, threadId: null, messageId: '777.7' });

    expect(await captureReasonReply(reply(ROOM, 'admin-1', 'channel root'))).toBe(true);
    expect(lastRelayedText()).toBe('Your install_packages request was rejected by admin: "channel root"');
  });

  it("takes the copy reaching the card's own bot, not a sibling bot's copy of the same message", async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    await seedApproval('appr-t10', 'install_packages', {
      ...inThread,
      platform_message_id: '888.8',
      instance: 'slack-card-bot',
    });
    await clickRejectWithReason('appr-t10', { platformId: ROOM, threadId: THREAD, messageId: '888.8' });

    const sibling = { ...reply(THREAD, 'admin-1', 'why'), instance: 'slack-sibling-bot' };
    expect(await captureReasonReply(sibling)).toBe(false);
    expect(await captureReasonReply({ ...reply(THREAD, 'admin-1', 'why'), instance: 'slack-card-bot' })).toBe(true);
  });

  it('keeps two approvers asked in one thread apart', async () => {
    const { captureReasonReply } = await import('./reason-capture.js');
    const { handleApprovalsResponse } = await import('./response-handler.js');
    await upsertUser({ id: 'slack:admin-2', kind: 'slack', display_name: 'Admin 2', created_at: now() });
    await grantRole({
      user_id: 'slack:admin-2',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    await seedApproval('appr-t6', 'install_packages', { ...inThread, platform_message_id: '333.3' });
    await seedApproval('appr-t7', 'add_mcp_server', { ...inThread, platform_message_id: '444.4' });
    await clickRejectWithReason('appr-t6', { platformId: ROOM, threadId: THREAD, messageId: '333.3' });
    await handleApprovalsResponse({
      questionId: 'appr-t7',
      value: REJECT_WITH_REASON_VALUE,
      userId: 'admin-2',
      channelType: DM_CHANNEL,
      platformId: ROOM,
      threadId: THREAD,
      messageId: '444.4',
    });

    expect(await captureReasonReply(reply(THREAD, 'admin-1', 'first'))).toBe(true);
    expect(lastRelayedText()).toBe('Your install_packages request was rejected by admin: "first"');
    expect(await captureReasonReply(reply(THREAD, 'admin-2', 'second'))).toBe(true);
    expect(lastRelayedText()).toBe('Your add_mcp_server request was rejected by admin: "second"');
  });
});
