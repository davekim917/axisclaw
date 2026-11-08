/**
 * requestApproval delivery-failure cleanup.
 *
 * requestApproval records the pending_approvals row before delivering the
 * card to the single picked approver. If that delivery throws, the row used
 * to linger forever as an approval nobody ever saw (and so nobody could
 * act on). These tests pin the fix: a failed delivery removes the
 * just-created row and notifies the requesting agent; a successful delivery
 * keeps it.
 *
 * Setup mirrors reason-capture.test.ts: real central DB, fake delivery
 * adapter, writeSessionMessage mocked to read back agent-facing text.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import {
  setDeliveryAdapter,
  settleSessionStatusAfterPublicDelivery,
  type ChannelDeliveryAdapter,
} from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { requestApproval, requestApprovalOutcome } from './primitive.js';
import { canAnswerApproval } from './response-handler.js';

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

vi.mock('../../delivery.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../delivery.js')>()),
  settleSessionStatusAfterPublicDelivery: vi.fn().mockResolvedValue(undefined),
}));

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-approval-primitive') }));
const DM_CHANNEL = 'slack';
const DM_PLATFORM = 'D-admin-1';

function now(): string {
  return new Date().toISOString();
}

let session: Session;

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();

  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  await createSession(session);

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
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

/** The text of the most recent agent-facing note written via writeSessionMessage. */
function lastNotifyText(): string | undefined {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1);
  if (!call) return undefined;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

describe('requestApproval delivery failure', () => {
  it('removes the pending approval row and notifies the agent when delivery throws', async () => {
    const failingAdapter: ChannelDeliveryAdapter = {
      async deliver() {
        throw new Error('platform down');
      },
    };
    setDeliveryAdapter(failingAdapter);

    await requestApproval({
      session,
      agentName: 'Agent',
      action: 'test_action',
      payload: { key: 'value' },
      title: 'Test Approval',
      question: 'Approve the thing?',
    });

    // No orphan: the row created before the delivery attempt is gone.
    expect(await getPendingApprovalsByAction('test_action')).toHaveLength(0);
    expect(lastNotifyText()).toMatch(/test_action failed: could not deliver/);
    expect(vi.mocked(settleSessionStatusAfterPublicDelivery)).not.toHaveBeenCalled();
  });

  it('keeps the pending approval row when delivery succeeds', async () => {
    const okAdapter: ChannelDeliveryAdapter = {
      async deliver() {
        return 'pm-1';
      },
    };
    setDeliveryAdapter(okAdapter);

    await requestApproval({
      session,
      agentName: 'Agent',
      action: 'test_action',
      payload: { key: 'value' },
      title: 'Test Approval',
      question: 'Approve the thing?',
    });

    expect(await getPendingApprovalsByAction('test_action')).toHaveLength(1);
    expect(vi.mocked(writeSessionMessage)).not.toHaveBeenCalled();
    expect(settleSessionStatusAfterPublicDelivery).toHaveBeenCalledWith(session.id, {
      conversation: { channelType: DM_CHANNEL, platformId: DM_PLATFORM, threadId: null },
      waitWhenElsewhere: true,
    });
  });
});

describe('a card bound to its recipient', () => {
  beforeEach(async () => {
    setDeliveryAdapter({ deliver: async () => 'pm-1' });
    await createAgentGroup({ id: 'ag-2', name: 'Other', folder: 'other', agent_provider: null, created_at: now() });
    for (const [user, group, dm] of [
      ['slack:admin-a', 'ag-1', 'D-admin-a'],
      ['slack:admin-b', 'ag-2', 'D-admin-b'],
    ] as const) {
      await upsertUser({ id: user, kind: 'slack', display_name: user, created_at: now() });
      await grantRole({ user_id: user, role: 'admin', agent_group_id: group, granted_by: null, granted_at: now() });
      await createMessagingGroup({
        id: `mg-${dm}`,
        channel_type: DM_CHANNEL,
        platform_id: dm,
        name: null,
        is_group: 0,
        unknown_sender_policy: 'strict',
        created_at: now(),
      });
      await upsertUserDm({
        user_id: user,
        channel_type: DM_CHANNEL,
        messaging_group_id: `mg-${dm}`,
        resolved_at: now(),
      });
    }
  });

  it.each([
    [
      'only the recipient answers, even an admin of another agent',
      true,
      { 'slack:admin-b': true, 'slack:admin-a': false },
    ],
    ["otherwise the session group's admins answer", false, { 'slack:admin-b': false, 'slack:admin-a': true }],
  ])('%s', async (_name, onlyRecipientAnswers, canAnswer) => {
    await requestApproval({
      session,
      agentName: 'Agent',
      action: 'test_action',
      payload: {},
      title: 'Test Approval',
      question: 'Approve the thing?',
      approvers: ['slack:admin-b'],
      onlyRecipientAnswers,
    });
    const [row] = await getPendingApprovalsByAction('test_action');
    for (const [user, expected] of Object.entries(canAnswer)) {
      expect(await canAnswerApproval(row, user), user).toBe(expected);
    }
  });
});

describe('a card goes out through the bot that owns its conversation', () => {
  let sentThrough: Array<string | undefined>;

  beforeEach(() => {
    sentThrough = [];
    setDeliveryAdapter({
      deliver: async (_channelType, _platformId, _threadId, _kind, _content, _files, instance) => {
        sentThrough.push(instance);
        return 'pm-1';
      },
    });
  });

  const ask = (s: Session, deliveryTarget: 'thread' | 'admin') =>
    requestApprovalOutcome({
      session: s,
      agentName: 'Agent',
      action: 'test_action',
      payload: {},
      title: 'Test Approval',
      question: 'Approve the thing?',
      deliveryTarget,
    });

  it("posts a thread card through the thread's own bot and records it for later edits", async () => {
    await createMessagingGroup({
      id: 'mg-work',
      channel_type: 'slack',
      platform_id: 'C-work',
      instance: 'acme-bot',
      name: 'Work',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    const threaded: Session = { ...session, id: 'sess-thread', messaging_group_id: 'mg-work', thread_id: 'T-1' };
    await createSession(threaded);

    expect(await ask(threaded, 'thread')).toBe('posted');
    expect(sentThrough).toEqual(['acme-bot']);
    expect((await getPendingApprovalsByAction('test_action'))[0].instance).toBe('acme-bot');
  });

  it("posts an approver's DM card through the bot that DM belongs to", async () => {
    await createMessagingGroup({
      id: 'mg-dm-named',
      channel_type: DM_CHANNEL,
      platform_id: 'D-admin-named',
      instance: 'acme-bot',
      name: 'Admin DM (acme-bot)',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await upsertUserDm({
      user_id: 'slack:admin-1',
      channel_type: DM_CHANNEL,
      messaging_group_id: 'mg-dm-named',
      resolved_at: now(),
    });

    expect(await ask(session, 'admin')).toBe('posted');
    expect(sentThrough).toEqual(['acme-bot']);
    expect((await getPendingApprovalsByAction('test_action'))[0].instance).toBe('acme-bot');
  });
});
