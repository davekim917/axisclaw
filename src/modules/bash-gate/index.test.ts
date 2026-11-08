import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { getRawDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getSession } from '../../db/sessions.js';
import { initSessionFolder } from '../../session-manager.js';
import type Database from 'better-sqlite3';

import { openInboundDb as openInboundDbAt } from '../../modules/mailbox/openers.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { getDeliveryAction } from '../../delivery.js';
import { editApprovalCardResolution } from '../approvals/primitive.js';
import {
  createPendingApproval,
  getApprovalByRequestId,
  getPendingApprovalByRequestId,
  getPendingApprovalsByAction,
  transitionPendingApprovalStatus,
} from '../../db/sessions.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import {
  _dropGateTimersForTesting,
  offerGateWithdraw,
  expireOverdueGates,
  openGateDeadlineMs,
  sessionHasActiveGates,
} from './index.js';
import { handleApprovalsResponse, resolveApprovalFromHost } from '../approvals/response-handler.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { __resetArchiveConnectionForTest, archiveMessage } from '../../message-archive.js';

// `session-manager`'s ids-addressed inbound opener went away with the mailbox
// seam's raw wrappers (PR 7). Production code opens sessions through the seam;
// this fixture still wants a plain handle on a named session's file, which is
// the module's own path-addressed funnel plus the layout helper.
function openInboundDb(agentGroupId: string, sessionId: string): Database.Database {
  return openInboundDbAt(inboundDbPath(agentGroupId, sessionId));
}

const mocks = vi.hoisted(() => ({
  deliver: vi.fn(),
  wakeContainer: vi.fn(),
  failedMailboxWrites: 0,
  containerName: null as string | null,
  pendingAdoption: false,
  duringAdminCheck: null as (() => void) | null,
}));

vi.mock('../permissions/db/user-roles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../permissions/db/user-roles.js')>();
  return {
    ...actual,
    hasAdminPrivilege: (...args: Parameters<typeof actual.hasAdminPrivilege>) => {
      mocks.duringAdminCheck?.();
      return actual.hasAdminPrivilege(...args);
    },
  };
});

vi.mock('../../session-manager.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../session-manager.js')>();
  return {
    ...actual,
    withExistingMailboxSession: ((...args: Parameters<typeof actual.withExistingMailboxSession>) => {
      if (mocks.failedMailboxWrites > 0) {
        mocks.failedMailboxWrites--;
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return actual.withExistingMailboxSession(...args);
    }) as typeof actual.withExistingMailboxSession,
  };
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: TEST_DIR, GROUPS_DIR: `${TEST_DIR}/groups` };
});

// Its own mailbox read would take a failure `failedMailboxWrites` injects for the gate; card-pointer.test.ts covers it.
vi.mock('../approvals/card-pointer.js', () => ({ sendCardPointer: vi.fn().mockResolvedValue('skipped-no-recipient') }));

vi.mock('../../container-runner.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../container-runner.js')>()),
  wakeContainer: mocks.wakeContainer,
  getContainerIdentity: () => mocks.containerName,
  hasPendingAdoption: () => mocks.pendingAdoption,
}));

vi.mock('../../delivery.js', async () => {
  const actual = await vi.importActual<typeof import('../../delivery.js')>('../../delivery.js');
  return {
    ...actual,
    getDeliveryAdapter: () => ({
      deliver: mocks.deliver,
    }),
  };
});

const { TEST_DIR } = vi.hoisted(() => ({ TEST_DIR: uniqueTmpRoot('test-bash-gate') }));

function now(): string {
  return new Date().toISOString();
}

function hasLoneSurrogate(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

async function seedSession(): Promise<void> {
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
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
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: 'slack:C123:1790000000.000300',
    agent_provider: null,
    status: 'active',
    container_status: 'running',
    last_active: now(),
    created_at: now(),
  });
  initSessionFolder('ag-1', 'sess-1');
}

async function runDestructiveGate(label: string, requestId: string, command?: string, summary?: string): Promise<void> {
  const handler = getDeliveryAction('request_destructive_gate');
  const session = await getSession('sess-1');
  expect(handler).toBeDefined();
  expect(session).toBeDefined();
  // Two arguments: the handler opens its own mailbox session now, and the
  // delivery loop holds none while it runs (plan §4.5b).
  await handler!(
    {
      requestId,
      label,
      summary: summary ?? 'The agent wants to run a destructive command.',
      command:
        command ??
        'CREATE OR REPLACE PROCEDURE HOOLI_PLATFORM.MASTER._LONG_TEST_SP() RETURNS STRING LANGUAGE SQL AS $$ SELECT 1; $$',
    },
    session!,
  );
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await initMigratedTestDb();
  await seedSession();
  mocks.deliver.mockReset();
  mocks.wakeContainer.mockReset();
  mocks.failedMailboxWrites = 0;
  mocks.containerName = 'nanoclaw-v2-agent-1';
  mocks.pendingAdoption = false;
  mocks.wakeContainer.mockResolvedValue(undefined);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('bash destructive gate delivery', () => {
  it('caps long destructive gate titles before Slack Block Kit delivery', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-1');

    await runDestructiveGate(
      'Destructive Snowflake SQL detected (CREATE OR REPLACE) — CREATE OR REPLACE PROCEDURE HOOLI_PLATFORM.MASTER._VERY_LONG_PROCEDURE_NAME_FOR_APPROVAL_CARD_LIMIT_REGRESSION() RETURNS STRING LANGUAGE SQL AS $$',
      'gate-long-title',
    );

    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    const content = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { title: string };
    expect(Array.from(content.title).length).toBeLessThanOrEqual(140);
    expect(content.title).toMatch(/…$/);

    const pending = getRawDb()
      .prepare('SELECT title, platform_message_id FROM pending_approvals WHERE request_id = ?')
      .get('gate-long-title') as { title: string; platform_message_id: string } | undefined;
    expect(pending?.title).toBe(content.title);
    expect(pending?.platform_message_id).toBe('slack-msg-1');
  });

  it('caps destructive gate titles without splitting emoji code points', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-emoji');

    await runDestructiveGate(`${'A'.repeat(135)}🚨 tail`, 'gate-emoji-title');

    const content = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { title: string };
    const codePoints = Array.from(content.title);
    expect(codePoints.length).toBeLessThanOrEqual(140);
    expect(codePoints.at(-2)).toBe('🚨');
    expect(codePoints.at(-1)).toBe('…');
    expect(hasLoneSurrogate(content.title)).toBe(false);
  });

  it('retains the full command for audit while showing both ends of a long command on the card', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-command');
    const command = `terraform apply -var='opening=${'a'.repeat(4000)}' -auto-approve --target=module.production`;

    await runDestructiveGate('Terraform apply', 'gate-long-command', command);

    const content = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { question: string };
    expect(content.question).toContain("terraform apply -var='opening=");
    expect(content.question).toContain('--target=module.production');
    expect(content.question).toContain('…[middle omitted; full command retained in the approval record]…');

    const pending = getRawDb()
      .prepare('SELECT payload FROM pending_approvals WHERE request_id = ?')
      .get('gate-long-command') as { payload: string } | undefined;
    expect(JSON.parse(pending!.payload).command).toBe(command);
  });

  it("keeps the card body inside Slack's 3000-unit section limit, footer and command tail included", async () => {
    mocks.deliver.mockResolvedValue('slack-msg-budget');
    const summary = `Rebuild 🧪 model\n\n> ${'🚨'.repeat(600)}`;
    const command = `psql -c "select '${'🔥'.repeat(900)}'" --set ON_ERROR_STOP=1 --dbname production`;

    await runDestructiveGate('Emoji-heavy gate', 'gate-budget', command, summary);

    const { question } = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { question: string };
    expect(question.length).toBeLessThanOrEqual(3000);
    expect(question).toContain('--dbname production');
    expect(question).toMatch(/cancels the destructive command\._$/);
    expect(hasLoneSurrogate(question)).toBe(false);
  });

  it("fits a Discord card, title included, in the Discord adapter's 1900-unit message", async () => {
    getRawDb()
      .prepare("UPDATE messaging_groups SET channel_type = 'discord', platform_id = 'discord:G1:C1' WHERE id = 'mg-1'")
      .run();
    mocks.deliver.mockResolvedValue('discord-msg-budget');
    const command = `psql -c "delete from t where id in (${'1,'.repeat(1050)}1)" --dbname production`;

    await runDestructiveGate('Delete rows', 'gate-discord-budget', command);

    const { title, question } = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as {
      title: string;
      question: string;
    };
    expect(`**${title}**\n\n${question}`.length).toBeLessThanOrEqual(1900);
    expect(question).toContain('--dbname production');
    expect(question).toMatch(/cancels the destructive command\._$/);
  });

  it('keeps the command tail and the resolution line when the card is edited after a decision', async () => {
    const command = `terraform apply -var='opening=${'a'.repeat(4000)}' -auto-approve --target=module.production`;
    for (const [platform, limit] of [
      ['slack:C123', 2800],
      ['discord:G1:C1', 1900],
    ] as const) {
      getRawDb().prepare('UPDATE messaging_groups SET platform_id = ? WHERE id = ?').run(platform, 'mg-1');
      mocks.deliver.mockReset();
      mocks.deliver.mockResolvedValue(`msg-${platform}`);
      const requestId = `gate-edit-${platform}`;

      await runDestructiveGate('Terraform apply', requestId, command);
      const pending = await getPendingApprovalByRequestId(requestId);
      await editApprovalCardResolution(pending!, 'approve', '');

      const edit = JSON.parse(mocks.deliver.mock.calls.at(-1)![4] as string) as { operation: string; text: string };
      expect(edit.operation).toBe('edit');
      expect(edit.text.length).toBeLessThanOrEqual(limit);
      expect(edit.text).toContain('--target=module.production');
      expect(edit.text).toMatch(/cancels the destructive command\._\n\n\S/);
    }
  });

  it('keeps the approver line, clipped, when a long display name approves a full-budget card', async () => {
    const command = `terraform apply -var='opening=${'a'.repeat(4000)}' -auto-approve --target=module.production`;
    const longName = '𝐀𝐥𝐞𝐱𝐚𝐧𝐝𝐫𝐚 '.repeat(30);
    await upsertUser({ id: 'slack:U-LONG', kind: 'slack', display_name: longName, created_at: now() });
    for (const [platform, limit] of [
      ['slack:C123', 2800],
      ['discord:G1:C1', 1900],
    ] as const) {
      getRawDb().prepare('UPDATE messaging_groups SET platform_id = ? WHERE id = ?').run(platform, 'mg-1');
      mocks.deliver.mockReset();
      mocks.deliver.mockResolvedValue(`msg-long-${platform}`);
      const requestId = `gate-long-name-${platform}`;

      await runDestructiveGate('Terraform apply', requestId, command);
      const pending = await getPendingApprovalByRequestId(requestId);
      await editApprovalCardResolution(pending!, 'approve', 'slack:U-LONG');

      const edit = JSON.parse(mocks.deliver.mock.calls.at(-1)![4] as string) as { text: string };
      expect(edit.text.length).toBeLessThanOrEqual(limit);
      expect(edit.text).toContain('--target=module.production');
      expect(edit.text).toMatch(/cancels the destructive command\._\n\n.+ — 𝐀𝐥𝐞𝐱𝐚𝐧𝐝𝐫𝐚 .*…$/u);
      expect(hasLoneSurrogate(edit.text)).toBe(false);
    }
  });

  it('does not split an emoji where the command tail is cut', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-tail');
    const command = `echo ${'🔥'.repeat(1500)} --tail-marker`;

    for (const summary of ['s', 'ss']) {
      mocks.deliver.mockClear();
      await runDestructiveGate('Emoji tail', `gate-tail-${summary}`, command, summary);
      const { question } = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { question: string };
      expect(question).toContain('--tail-marker');
      expect(hasLoneSurrogate(question)).toBe(false);
    }
  });

  it('gives a long summary the room a short command leaves', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-short');

    await runDestructiveGate('Short command', 'gate-short', 'rm -rf /tmp/x', 'y'.repeat(2400));

    const { question } = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { question: string };
    expect(question).toContain('y'.repeat(2400));
  });

  it('cuts an oversized summary before the command preview', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-summary');
    const command = `terraform destroy ${'-target=module.x '.repeat(40)}-target=module.production`;

    await runDestructiveGate('Long summary', 'gate-summary', command, 'x'.repeat(5000));

    const { question } = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { question: string };
    expect(question.length).toBeLessThanOrEqual(3000);
    expect(question).toContain('-target=module.production');
    expect(question).toMatch(/cancels the destructive command\._$/);
  });

  it('fails the gate ack immediately when approval-card delivery throws', async () => {
    mocks.deliver.mockRejectedValue(new Error('An API error occurred: invalid_blocks'));

    await runDestructiveGate(
      'Destructive Snowflake SQL detected (CREATE OR REPLACE) — CREATE OR REPLACE PROCEDURE HOOLI_PLATFORM.MASTER._VERY_LONG_PROCEDURE_NAME_FOR_APPROVAL_CARD_LIMIT_REGRESSION() RETURNS STRING LANGUAGE SQL AS $$',
      'gate-delivery-fail',
    );

    const pendingCount = (
      getRawDb()
        .prepare('SELECT COUNT(*) AS count FROM pending_approvals WHERE request_id = ?')
        .get('gate-delivery-fail') as { count: number }
    ).count;
    expect(pendingCount).toBe(0);

    const inDb = openInboundDb('ag-1', 'sess-1');
    try {
      const ack = inDb
        .prepare('SELECT status, error FROM delivered WHERE message_out_id = ?')
        .get('gate-delivery-fail') as { status: string; error: string } | undefined;
      expect(ack).toEqual({
        status: 'failed',
        error: 'destructive-gate delivery failed: approval request could not be posted.',
      });
    } finally {
      inDb.close();
    }
  });
});

describe('an email card for a send that runs alone', () => {
  const COMMAND = [
    'export GOOGLE_WORKSPACE_CLI_CREDENTIALS_FILE=/home/node/.config/gws/accounts/example-co.json',
    "BODY=$(cat <<'EOF'",
    'Hi Pat,',
    '',
    "Can you confirm the file works? It's the one in our folder.",
    'EOF',
    ')',
    'gws gmail +reply --message-id 18f0aa11bb22cc33 --cc "lee@example.com" --body "$BODY"',
  ].join('\n');
  const SUMMARY = [
    'From: example-co',
    'To: the original sender (or its Reply-To address)',
    'Cc: lee@example.com',
    'Subject: Re: the original subject',
    'In reply to: Gmail message `18f0aa11bb22cc33`, quoted under the reply',
    '',
    'Message:',
    '> Hi Pat,',
    '> ',
    "> Can you confirm the file works? It's the one in our folder.",
  ].join('\n');
  const FOOTER = '_Reject, or no answer within 60 min, cancels the command._';

  async function postEmailCard(action: string, requestId: string, extra: Record<string, unknown>): Promise<string> {
    mocks.deliver.mockReset();
    mocks.deliver.mockResolvedValue(`msg-${requestId}`);
    await getDeliveryAction(action)!(
      { requestId, label: 'Email reply', summary: SUMMARY, command: COMMAND, ...extra },
      (await getSession('sess-1'))!,
    );
    return (JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { question: string }).question;
  }

  it('a pure send shows the email and no command, and keeps the command on record', async () => {
    expect(await postEmailCard('request_bash_gate', 'gate-email-pure', { pureSend: true })).toBe(
      `${SUMMARY}\n\n${FOOTER}`,
    );
    const pending = getRawDb()
      .prepare('SELECT payload FROM pending_approvals WHERE request_id = ?')
      .get('gate-email-pure') as { payload: string };
    expect(JSON.parse(pending.payload).command).toBe(COMMAND);
  });

  it('shows the full command without the mark, with anything but true, or when the summary would not fit', async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ['no mark', {}],
      ['a string', { pureSend: 'true' }],
      ['a number', { pureSend: 1 }],
      ['a summary too long to stand alone', { pureSend: true, summary: `${SUMMARY}\n> ${'x'.repeat(2800)}` }],
    ];
    for (const action of ['request_bash_gate', 'request_send_gate']) {
      for (const [i, [name, extra]] of cases.entries()) {
        const question = await postEmailCard(action, `gate-email-${action}-${i}`, extra);
        expect([action, name, question.includes('```'), question.includes('gws gmail +reply')]).toEqual([
          action,
          name,
          true,
          true,
        ]);
      }
    }
  });

  it('a destructive card never leaves its command off, whatever the request carries', async () => {
    const question = await postEmailCard('request_destructive_gate', 'gate-destructive-pure', { pureSend: true });
    expect(question).toContain('```');
    expect(question).toContain('gws gmail +reply');
  });
});

describe('rejecting a gate', () => {
  function gateAck(requestId: string): unknown {
    const inDb = openInboundDb('ag-1', 'sess-1');
    try {
      return inDb.prepare('SELECT status, error FROM delivered WHERE message_out_id = ?').get(requestId);
    } finally {
      inDb.close();
    }
  }

  async function rejectGate(requestId: string): Promise<void> {
    const approval = await getPendingApprovalByRequestId(requestId);
    expect(approval).toBeDefined();
    expect(await resolveApprovalFromHost(approval!.approval_id, 'reject', 'slack:admin-1')).toEqual({ resolved: true });
  }

  it('keeps the session marked while a sibling gate is still open', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    await runDestructiveGate('Drop table', 'gate-a');
    await runDestructiveGate('Drop schema', 'gate-b');

    await rejectGate('gate-a');
    expect(gateAck('gate-a')).toEqual({ status: 'failed', error: 'Rejected by an approver.' });
    expect(sessionHasActiveGates('sess-1')).toBe(true);

    await rejectGate('gate-b');
    expect(sessionHasActiveGates('sess-1')).toBe(false);
  });

  it('leaves the timeout armed when the reject cannot be written, so the gate still fails', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.deliver.mockResolvedValue('pm-1');
      await runDestructiveGate('Drop table', 'gate-c');

      mocks.failedMailboxWrites = 1;
      await rejectGate('gate-c');
      expect(gateAck('gate-c')).toEqual({ status: 'pending', error: null });

      await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
      expect(gateAck('gate-c')).toEqual({ status: 'failed', error: 'Destructive gate timed out after 60 minutes.' });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a gate whose container restarted', () => {
  const MINUTE = 60 * 1000;
  const at = (minutesAgo: number): number => Date.now() - minutesAgo * MINUTE;
  const container = (startedMinutesAgo: number): string => `nanoclaw-v2-agent-${at(startedMinutesAgo)}`;
  const request = (askedMinutesAgo: number, tag: string): string => `gate-${at(askedMinutesAgo)}-${tag}`;

  function gateAck(requestId: string): unknown {
    const inDb = openInboundDb('ag-1', 'sess-1');
    try {
      return inDb.prepare('SELECT status, error FROM delivered WHERE message_out_id = ?').get(requestId);
    } finally {
      inDb.close();
    }
  }

  it('closes the dead container’s card when its replacement asks again, and counts only the live gate', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(40);
    const oldId = request(35, 'aa');
    await runDestructiveGate('Drop database', oldId);
    expect(await getPendingApprovalByRequestId(oldId)).toBeDefined();

    mocks.containerName = container(3);
    expect(await openGateDeadlineMs('sess-1')).toBeNull();
    const newId = request(1, 'bb');
    await runDestructiveGate('Drop database', newId);

    expect(await getPendingApprovalByRequestId(oldId)).toBeUndefined();
    expect(await getPendingApprovalByRequestId(newId)).toBeDefined();
    expect(await openGateDeadlineMs('sess-1')).toBe(Number(newId.split('-')[1]) + 62 * MINUTE);
  });

  it('an answer to the dead container’s card after its replacement asked again neither acks it nor tells the agent', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(40);
    const staleId = request(35, 'dd');
    await runDestructiveGate('Drop database', staleId);
    const stale = await getPendingApprovalByRequestId(staleId);
    mocks.containerName = container(3);
    await runDestructiveGate('Drop database', request(1, 'ee'));

    expect(await resolveApprovalFromHost(stale!.approval_id, 'approve', 'slack:admin-1')).toEqual({
      resolved: false,
      error: `No pending approval ${stale!.approval_id}`,
    });
    expect(gateAck(staleId)).toEqual({
      status: 'failed',
      error: 'Superseded: the agent restarted and asked again.',
    });
    const inDb = openInboundDb('ag-1', 'sess-1');
    try {
      expect(inDb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE content LIKE '%gate approved%'").get()).toEqual({
        n: 0,
      });
    } finally {
      inDb.close();
    }
  });

  it('refuses a request its container wrote before being replaced, without posting a card', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(3);
    const id = request(5, 'cc');
    await runDestructiveGate('Drop database', id);

    expect(await getPendingApprovalByRequestId(id)).toBeUndefined();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(gateAck(id)).toEqual({
      status: 'failed',
      error: 'The agent stopped before this approval request was posted.',
    });
    expect(await openGateDeadlineMs('sess-1')).toBeNull();
  });

  it('refuses a request drained after its container exited and before any replacement owns the session', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = null;
    const id = request(5, 'hh');
    await runDestructiveGate('Drop database', id);

    expect(await getPendingApprovalByRequestId(id)).toBeUndefined();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(gateAck(id)).toEqual({
      status: 'failed',
      error: 'The agent stopped before this approval request was posted.',
    });
  });

  it('times out a late-posted request when its own hour ends, not an hour after posting', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.deliver.mockResolvedValue('pm-1');
      mocks.containerName = container(90);
      const id = request(50, 'tt');
      await runDestructiveGate('Drop database', id);

      await vi.advanceTimersByTimeAsync(9 * MINUTE);
      expect(gateAck(id)).toEqual({ status: 'pending', error: null });
      await vi.advanceTimersByTimeAsync(MINUTE + 1000);
      expect(gateAck(id)).toEqual({ status: 'failed', error: 'Destructive gate timed out after 60 minutes.' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('never dates a gate’s deadline later than an hour past when the host posted it', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(3);
    const forged = `gate-${Date.now() + 365 * 24 * 60 * MINUTE}-ff`;
    await runDestructiveGate('Drop database', forged);
    const card = await getPendingApprovalByRequestId(forged);
    expect(await openGateDeadlineMs('sess-1')).toBe(Date.parse(card!.created_at) + 62 * MINUTE);
  });

  for (const [when, afterFiling] of [
    ['no container owns the session, or its replacement is still spawning', () => (mocks.containerName = null)],
    ['a replacement started but has not asked yet', () => (mocks.containerName = container(1))],
  ] as const) {
    it(`an approve clicked after the filing container stopped runs nothing and says so (${when})`, async () => {
      mocks.deliver.mockResolvedValue('pm-1');
      mocks.containerName = container(40);
      const id = request(35, 'kk');
      await runDestructiveGate('Rename schemas', id);
      const card = await getPendingApprovalByRequestId(id);
      afterFiling();

      expect(await resolveApprovalFromHost(card!.approval_id, 'approve', 'slack:admin-1')).toEqual({
        resolved: true,
        declined:
          '⏭️ The agent stopped before this was answered, so nothing ran. It will ask again if it still needs this.',
      });

      expect(gateAck(id)).toEqual({ status: 'failed', error: 'The agent stopped before this approval was answered.' });
      expect(await getPendingApprovalByRequestId(id)).toBeUndefined();
      expect(sessionHasActiveGates('sess-1')).toBe(false);
      const edit = JSON.parse(mocks.deliver.mock.calls.at(-1)![4] as string) as { operation: string; text: string };
      expect(edit.operation).toBe('edit');
      expect(edit.text).toContain('nothing ran');
      const inDb = openInboundDb('ag-1', 'sess-1');
      try {
        expect(inDb.prepare("SELECT COUNT(*) AS n FROM messages_in WHERE content LIKE '%approved%'").get()).toEqual({
          n: 0,
        });
      } finally {
        inDb.close();
      }
    });
  }

  it('still declines, and says nothing ran, when the stopped gate’s ack cannot be written', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(40);
    const id = request(35, 'mm');
    await runDestructiveGate('Rename schemas', id);
    const card = await getPendingApprovalByRequestId(id);
    mocks.containerName = null;
    mocks.failedMailboxWrites = 1;

    expect(await resolveApprovalFromHost(card!.approval_id, 'approve', 'slack:admin-1')).toEqual({
      resolved: true,
      declined:
        '⏭️ The agent stopped before this was answered, so nothing ran. It will ask again if it still needs this.',
    });

    expect(await getPendingApprovalByRequestId(id)).toBeUndefined();
    const edit = JSON.parse(mocks.deliver.mock.calls.at(-1)![4] as string) as { operation: string; text: string };
    expect(edit.text).toContain('nothing ran');
    expect(gateAck(id)).toEqual({ status: 'pending', error: null });
  });

  it('an approve while the filing container still waits is applied', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(40);
    const id = request(35, 'll');
    await runDestructiveGate('Rename schemas', id);
    const card = await getPendingApprovalByRequestId(id);

    expect(await resolveApprovalFromHost(card!.approval_id, 'approve', 'slack:admin-1')).toEqual({ resolved: true });
    expect(gateAck(id)).toEqual({ status: 'delivered', error: null });
  });

  it('posts and applies a gate from an adopted survivor whose name the runtime could not report', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = null;
    mocks.pendingAdoption = true;
    const id = request(5, 'nn');
    await runDestructiveGate('Rename schemas', id);
    const card = await getPendingApprovalByRequestId(id);
    expect(card).toBeDefined();

    expect(await resolveApprovalFromHost(card!.approval_id, 'approve', 'slack:admin-1')).toEqual({ resolved: true });
    expect(gateAck(id)).toEqual({ status: 'delivered', error: null });
  });

  it('expires a gate whose timer a host restart dropped, once its hour from the ask has passed', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    const orphaned = request(59, 'pp');
    await runDestructiveGate('Drop database', orphaned);
    _dropGateTimersForTesting();
    const armed = request(59, 'qq');
    await runDestructiveGate('Drop database', armed);

    expect(await expireOverdueGates()).toBe(0);
    expect(await expireOverdueGates(Date.now() + 2 * MINUTE)).toBe(1);

    expect(gateAck(orphaned)).toEqual({ status: 'failed', error: 'Destructive gate timed out after 60 minutes.' });
    expect(await getPendingApprovalByRequestId(orphaned)).toBeUndefined();
    const edit = JSON.parse(mocks.deliver.mock.calls.at(-1)![4] as string) as { operation: string; text: string };
    expect(edit.operation).toBe('edit');
    expect(edit.text).toContain('timed out');
    expect(await getPendingApprovalByRequestId(armed)).toBeDefined();
    expect(sessionHasActiveGates('sess-1')).toBe(true);
    _dropGateTimersForTesting();
  });

  it('an approve that lands while the gate is being timed out runs nothing', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    const id = request(59, 'rr');
    await runDestructiveGate('Drop database', id);
    const card = await getPendingApprovalByRequestId(id);
    expect(await transitionPendingApprovalStatus(card!.approval_id, 'pending', 'expired')).toBe(true);

    expect(await resolveApprovalFromHost(card!.approval_id, 'approve', 'slack:admin-1')).toEqual({
      resolved: false,
      error: `Approval ${card!.approval_id} was already answered by someone else.`,
    });
    expect(gateAck(id)).toEqual({ status: 'pending', error: null });
    _dropGateTimersForTesting();
  });

  it('a timer that fires after an approve claimed the gate writes no timeout over it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.deliver.mockResolvedValue('pm-1');
      const id = request(59, 'ss');
      await runDestructiveGate('Drop database', id);
      const card = await getPendingApprovalByRequestId(id);
      expect(await transitionPendingApprovalStatus(card!.approval_id, 'pending', 'approved')).toBe(true);

      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(gateAck(id)).toEqual({ status: 'pending', error: null });
    } finally {
      vi.useRealTimers();
    }
  });

  it('finishes an expiry whose ack write failed after the gate was claimed', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    const id = request(59, 'uu');
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await runDestructiveGate('Drop database', id);
      mocks.failedMailboxWrites = 1;
      await vi.advanceTimersByTimeAsync(2 * MINUTE);
    } finally {
      vi.useRealTimers();
    }
    expect((await getApprovalByRequestId(id, 'sess-1', 'destructive-gate'))?.status).toBe('expired');
    expect(gateAck(id)).toEqual({ status: 'pending', error: null });

    expect(await expireOverdueGates()).toBe(1);
    expect(gateAck(id)).toEqual({ status: 'failed', error: 'Destructive gate timed out after 60 minutes.' });
    expect(await getApprovalByRequestId(id, 'sess-1', 'destructive-gate')).toBeUndefined();
  });

  it('times out only its own gate when another approval reuses its request id', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.deliver.mockResolvedValue('pm-1');
      const id = request(59, 'vv');
      await createPendingApproval({
        approval_id: 'appr-other-kind',
        session_id: 'sess-1',
        request_id: id,
        action: 'some-other-action',
        payload: '{}',
        created_at: new Date().toISOString(),
        title: 'Other',
        options_json: '[]',
      });
      await runDestructiveGate('Drop database', id);
      await vi.advanceTimersByTimeAsync(2 * MINUTE);

      expect(gateAck(id)).toEqual({ status: 'failed', error: 'Destructive gate timed out after 60 minutes.' });
      expect(await getApprovalByRequestId(id, 'sess-1', 'destructive-gate')).toBeUndefined();
      expect((await getApprovalByRequestId(id, 'sess-1', 'some-other-action'))?.status).toBe('pending');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the expiry sweep writes no timeout over a gate approved while it was working', async () => {
    const b = request(59, 'wb');
    mocks.deliver.mockResolvedValue('pm-1');
    await runDestructiveGate('Drop database', request(59, 'wa'));
    await runDestructiveGate('Drop database', b);
    _dropGateTimersForTesting();
    const cardB = await getPendingApprovalByRequestId(b);
    let approvedB = false;
    mocks.deliver.mockImplementation(async () => {
      if (!approvedB) {
        approvedB = true;
        await resolveApprovalFromHost(cardB!.approval_id, 'approve', 'slack:admin-1');
      }
      return 'pm-1';
    });

    expect(await expireOverdueGates(Date.now() + 2 * MINUTE)).toBe(1);

    expect(gateAck(b)).toEqual({ status: 'delivered', error: null });
  });

  it('closes a gate whose answer a dead host claimed but never finished, once the hook has stopped waiting', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    const id = request(59, 'za');
    await runDestructiveGate('Drop database', id);
    _dropGateTimersForTesting();
    const card = await getPendingApprovalByRequestId(id);
    expect(await transitionPendingApprovalStatus(card!.approval_id, 'pending', 'approved')).toBe(true);

    expect(await expireOverdueGates(Date.now() + 2 * MINUTE)).toBe(0);
    expect(await expireOverdueGates(Date.now() + 4 * MINUTE)).toBe(1);

    expect(await getApprovalByRequestId(id, 'sess-1', 'destructive-gate')).toBeUndefined();
    expect(gateAck(id)).toEqual({ status: 'pending', error: null });
    const edit = JSON.parse(mocks.deliver.mock.calls.at(-1)![4] as string) as { operation: string; text: string };
    expect(edit.text).toContain('Check the agent');
  });

  it('a gate whose reject was claimed but never finished still fails at its timeout', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      mocks.deliver.mockResolvedValue('pm-1');
      const id = request(59, 'zr');
      await runDestructiveGate('Drop database', id);
      const card = await getPendingApprovalByRequestId(id);
      expect(await transitionPendingApprovalStatus(card!.approval_id, 'pending', 'rejected')).toBe(true);

      await vi.advanceTimersByTimeAsync(2 * MINUTE);
      expect(gateAck(id)).toEqual({ status: 'failed', error: 'Destructive gate timed out after 60 minutes.' });
      expect((await getApprovalByRequestId(id, 'sess-1', 'destructive-gate'))?.status).toBe('rejected');
    } finally {
      vi.useRealTimers();
    }
  });

  it('refuses a request whose hour ran out before the host posted it, and dates a late card from the request', async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    mocks.containerName = container(90);
    const expired = request(61, 'ff');
    await runDestructiveGate('Drop database', expired);
    expect(await getPendingApprovalByRequestId(expired)).toBeUndefined();
    expect(mocks.deliver).not.toHaveBeenCalled();
    expect(gateAck(expired)).toEqual({
      status: 'failed',
      error: 'The approval window ran out before this request was posted.',
    });

    const late = request(50, 'gg');
    await runDestructiveGate('Drop database', late);
    expect(await getPendingApprovalByRequestId(late)).toBeDefined();
    expect(await openGateDeadlineMs('sess-1')).toBe(Number(late.split('-')[1]) + 62 * MINUTE);
  });
});

describe('who may answer a gate card posted in the work thread', () => {
  function gateAck(requestId: string): unknown {
    const inDb = openInboundDb('ag-1', 'sess-1');
    try {
      return inDb.prepare('SELECT status, error FROM delivered WHERE message_out_id = ?').get(requestId);
    } finally {
      inDb.close();
    }
  }

  async function fileGate(action: string, requestId: string): Promise<void> {
    await getDeliveryAction(action)!(
      {
        requestId,
        label: 'Run a one-off job',
        summary: 'Runs a job on a service.',
        command: 'render jobs create srv-x',
      },
      (await getSession('sess-1'))!,
    );
  }

  async function clickApprove(requestId: string, user: string): Promise<void> {
    const card = await getPendingApprovalByRequestId(requestId);
    expect(card).toBeDefined();
    await handleApprovalsResponse({
      questionId: card!.approval_id,
      value: 'approve',
      userId: user,
      channelType: 'slack-example-labs',
      platformId: 'slack:C123',
      threadId: 'slack:C123:1790000000.000300',
      messageId: 'pm-1',
    });
  }

  beforeEach(async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    for (const id of ['member', 'admin']) {
      await upsertUser({ id: `slack-example-labs:${id}`, kind: 'slack', display_name: id, created_at: now() });
    }
    await grantRole({
      user_id: 'slack-example-labs:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
  });

  it('a production gate ignores a thread member without a role and runs on an admin click', async () => {
    await fileGate('request_prod_gate', 'gate-prod');

    await clickApprove('gate-prod', 'member');
    expect(gateAck('gate-prod')).toEqual({ status: 'pending', error: null });
    expect(await getPendingApprovalByRequestId('gate-prod')).toBeDefined();

    await clickApprove('gate-prod', 'admin');
    expect(gateAck('gate-prod')).toEqual({ status: 'delivered', error: null });
  });

  it('a gate that also holds dev deletes never calls its card production', async () => {
    mocks.deliver.mockResolvedValue('slack-msg-prod');
    await getDeliveryAction('request_prod_gate')!(
      { requestId: 'gate-dev-delete', command: 'render postgres delete dpg-example' },
      (await getSession('sess-1'))!,
    );

    const content = JSON.parse(mocks.deliver.mock.calls[0][4] as string) as { title: string; question: string };
    expect(content.question).toContain('cancels the change. Only an owner or admin of this agent can approve.');
    expect(`${content.title} ${content.question}`).not.toMatch(/production/i);
  });

  const MEMBER = 'slack-example-labs:member';
  const ADMIN = 'slack-example-labs:admin';

  async function withdrawCard(gateRequestId: string, sender: string) {
    const gate = await getApprovalByRequestId(gateRequestId, 'sess-1', 'prod-gate');
    return getApprovalByRequestId(`withdraw:${gate!.approval_id}:${sender}`, 'sess-1', 'gate-withdraw');
  }

  async function press(approvalId: string, user: string): Promise<void> {
    await handleApprovalsResponse({
      questionId: approvalId,
      value: 'approve',
      userId: user.split(':')[1],
      channelType: 'slack-example-labs',
      platformId: 'slack:C123',
      threadId: 'slack:C123:1790000000.000300',
      messageId: 'pm-1',
    });
  }

  it('a message from someone who can answer the gate leaves it open, and Approve then runs it', async () => {
    await fileGate('request_destructive_gate', 'gate-destructive');
    await offerGateWithdraw('sess-1', MEMBER);
    expect((await getPendingApprovalByRequestId('gate-destructive'))?.status).toBe('pending');
    await clickApprove('gate-destructive', 'member');
    expect(gateAck('gate-destructive')).toEqual({ status: 'delivered', error: null });

    await fileGate('request_prod_gate', 'gate-prod');
    await offerGateWithdraw('sess-1', ADMIN);
    expect((await getPendingApprovalByRequestId('gate-prod'))?.status).toBe('pending');
    await clickApprove('gate-prod', 'admin');
    expect(gateAck('gate-prod')).toEqual({ status: 'delivered', error: null });

    expect(await getPendingApprovalsByAction('gate-withdraw')).toEqual([]);
  });

  it('offers someone who cannot answer the gate one Withdraw only they can press, which ends the gate like Reject', async () => {
    await fileGate('request_prod_gate', 'gate-prod');

    await offerGateWithdraw('sess-1', MEMBER);
    await offerGateWithdraw('sess-1', MEMBER);

    const offers = await getPendingApprovalsByAction('gate-withdraw');
    expect(offers).toHaveLength(1);
    expect(offers[0].approver_user_id).toBe(MEMBER);
    await press(offers[0].approval_id, ADMIN);
    expect(gateAck('gate-prod')).toEqual({ status: 'pending', error: null });

    await press(offers[0].approval_id, MEMBER);
    expect(gateAck('gate-prod')).toEqual({ status: 'failed', error: 'Withdrawn by member.' });
    expect(await getPendingApprovalByRequestId('gate-prod')).toBeUndefined();
    expect(sessionHasActiveGates('sess-1')).toBe(false);
    const edits = mocks.deliver.mock.calls.map((c) => JSON.parse(c[4] as string) as { text?: string });
    expect(
      edits.some((e) => e.text?.includes('— withdrawn\n\nmember withdrew it before anyone answered. Nothing ran.')),
    ).toBe(true);
  });

  it.each([
    ['approved', async () => clickApprove('gate-prod', 'admin')],
    ['timed out', async () => expect(await expireOverdueGates(Date.now() + 61 * 60 * 1000)).toBe(1)],
  ])('closes the Withdraw card when its gate is %s instead', async (_how, settle) => {
    await fileGate('request_prod_gate', 'gate-prod');
    _dropGateTimersForTesting();
    await offerGateWithdraw('sess-1', MEMBER);
    expect(await getPendingApprovalsByAction('gate-withdraw')).toHaveLength(1);

    await settle();

    expect(await getPendingApprovalsByAction('gate-withdraw')).toEqual([]);
    const edits = mocks.deliver.mock.calls.map((c) => JSON.parse(c[4] as string) as { text?: string });
    expect(
      edits.some((e) => e.text?.includes('The card above is no longer waiting, so there is nothing to withdraw.')),
    ).toBe(true);
  });

  it('closes a Withdraw card whose gate was answered before the card was stored', async () => {
    await fileGate('request_prod_gate', 'gate-prod');
    const gate = await getPendingApprovalByRequestId('gate-prod');
    mocks.duringAdminCheck = () => {
      mocks.duringAdminCheck = null;
      getRawDb()
        .prepare("UPDATE pending_approvals SET status = 'approved' WHERE approval_id = ?")
        .run(gate!.approval_id);
    };

    await offerGateWithdraw('sess-1', MEMBER);

    expect(await getPendingApprovalsByAction('gate-withdraw')).toEqual([]);
  });

  it('two quick messages from one sender post one Withdraw card', async () => {
    await fileGate('request_prod_gate', 'gate-prod');
    await Promise.all([offerGateWithdraw('sess-1', MEMBER), offerGateWithdraw('sess-1', MEMBER)]);
    expect(await getPendingApprovalsByAction('gate-withdraw')).toHaveLength(1);
  });

  it('a Withdraw and an approve landing during it decide the gate once', async () => {
    await fileGate('request_prod_gate', 'gate-prod');
    await offerGateWithdraw('sess-1', MEMBER);
    const offer = await withdrawCard('gate-prod', MEMBER);
    const gate = await getPendingApprovalByRequestId('gate-prod');
    let approveResult: unknown;
    let clicked = false;
    mocks.deliver.mockImplementation(async () => {
      if (!clicked) {
        clicked = true;
        approveResult = await resolveApprovalFromHost(gate!.approval_id, 'approve', ADMIN);
      }
      return 'pm-1';
    });

    await press(offer!.approval_id, MEMBER);

    expect(gateAck('gate-prod')).toEqual({ status: 'failed', error: 'Withdrawn by member.' });
    expect(approveResult).toEqual({
      resolved: false,
      error: `Approval ${gate!.approval_id} was already answered by someone else.`,
    });
  });

  it('a Withdraw whose decision cannot be written leaves the gate to its timeout', async () => {
    const MINUTE = 60 * 1000;
    const id = `gate-${Date.now() - 59 * MINUTE}-yc`;
    await fileGate('request_prod_gate', id);
    _dropGateTimersForTesting();
    await offerGateWithdraw('sess-1', MEMBER);
    const offer = await withdrawCard(id, MEMBER);
    mocks.failedMailboxWrites = 1;

    await press(offer!.approval_id, MEMBER);
    expect((await getPendingApprovalByRequestId(id))?.status).toBe('pending');
    expect(sessionHasActiveGates('sess-1')).toBe(true);

    expect(await expireOverdueGates(Date.now() + 2 * MINUTE)).toBe(1);
    expect(gateAck(id)).toEqual({ status: 'failed', error: 'Owner-or-admin gate timed out after 60 minutes.' });
  });

  it('a destructive gate still runs on any thread member’s click', async () => {
    await fileGate('request_destructive_gate', 'gate-destructive');

    await clickApprove('gate-destructive', 'member');
    expect(gateAck('gate-destructive')).toEqual({ status: 'delivered', error: null });
  });
});

describe('a send gate after the approver already said "send"', () => {
  it('still posts the card: a send word never stands in for it', async () => {
    const thread = 'slack:C123:1790000000.000300';
    const draft = 'Numbers are in: bookings up 4% week over week.';
    await upsertUser({ id: 'slack-example-labs:admin', kind: 'slack', display_name: 'admin', created_at: now() });
    await grantRole({
      user_id: 'slack-example-labs:admin',
      role: 'admin',
      agent_group_id: 'ag-1',
      granted_by: null,
      granted_at: now(),
    });
    __resetArchiveConnectionForTest();
    for (const [id, role, text, second] of [
      ['arch-draft', 'assistant', draft, 1],
      ['arch-send', 'user', 'send', 2],
    ] as const) {
      archiveMessage(
        {
          id,
          agentGroupId: 'ag-1',
          messagingGroupId: 'mg-1',
          channelType: 'slack-example-labs',
          channelName: '#support',
          platformId: 'slack:C123',
          threadId: thread,
          role,
          senderId: role === 'user' ? 'slack-example-labs:admin' : 'ag-1',
          senderName: role === 'user' ? 'admin' : 'assistant',
          senderIsBot: role === 'user' ? false : undefined,
          text,
          sentAt: new Date(Date.UTC(2026, 0, 1, 12, 0, second)).toISOString(),
        },
        { workgroupId: null },
      );
    }
    mocks.deliver.mockResolvedValue('pm-1');

    await getDeliveryAction('request_send_gate')!(
      { requestId: 'gate-send', label: 'Slack post', summary: 'post', command: 'curl …', sendParts: [draft] },
      (await getSession('sess-1'))!,
    );

    expect(mocks.deliver).toHaveBeenCalledTimes(1);
    expect(await getPendingApprovalByRequestId('gate-send')).toBeTruthy();
    __resetArchiveConnectionForTest();
  });
});

describe('a gate filed by a session with no conversation', () => {
  const MINUTE = 60 * 1000;
  const request = (tag: string): string => `gate-${Date.now()}-${tag}`;
  const BRIEF = 'You are the work owner for topic lb-example-1.';

  function gateAck(requestId: string): unknown {
    const inDb = openInboundDb('ag-1', 'sess-bg');
    try {
      return inDb.prepare('SELECT status, error FROM delivered WHERE message_out_id = ?').get(requestId) ?? null;
    } finally {
      inDb.close();
    }
  }

  function sendsAs(userId: string | null): void {
    fs.mkdirSync(`${TEST_DIR}/groups/agent`, { recursive: true });
    fs.writeFileSync(
      `${TEST_DIR}/groups/agent/container.json`,
      JSON.stringify(userId ? { sends_as_user_id: userId } : {}),
    );
  }

  async function file(
    action: string,
    requestId: string,
    command = 'curl -d @- https://slack.com/api/chat.postMessage',
  ): Promise<void> {
    await getDeliveryAction(action)!(
      { requestId, label: 'Slack post', summary: 'Post to #general as Pat.', command, sendParts: ['Ship it Friday.'] },
      (await getSession('sess-bg'))!,
    );
  }

  async function click(requestId: string, user: string): Promise<void> {
    const card = await getPendingApprovalByRequestId(requestId);
    expect(card).toBeDefined();
    await handleApprovalsResponse({
      questionId: card!.approval_id,
      value: 'approve',
      userId: user,
      channelType: 'discord',
      platformId: 'discord:dm-pat',
      threadId: null,
      messageId: 'pm-1',
    });
  }

  beforeEach(async () => {
    mocks.deliver.mockResolvedValue('pm-1');
    await createSession({
      id: 'sess-bg',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: `system:tasks:dispatch-${'b'.repeat(64)}`,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now(),
      created_at: now(),
    });
    initSessionFolder('ag-1', 'sess-bg');
    const inDb = openInboundDb('ag-1', 'sess-bg');
    try {
      inDb
        .prepare(
          `INSERT INTO messages_in (id, seq, timestamp, status, tries, kind, content)
           VALUES ('task-1', 2, ?, 'completed', 0, 'task', ?)`,
        )
        .run(now(), JSON.stringify({ prompt: `${BRIEF}\nRead the playbook first.`, originSessionId: null }));
    } finally {
      inDb.close();
    }
    for (const [id, role] of [
      ['discord:pat', 'owner'],
      ['discord:sam', 'owner'],
      ['slack-example-labs:admin', 'admin'],
    ] as const) {
      await upsertUser({ id, kind: id.split(':')[0], display_name: id, created_at: now() });
      await grantRole({
        user_id: id,
        role,
        agent_group_id: role === 'admin' ? 'ag-1' : null,
        granted_by: null,
        granted_at: now(),
      });
    }
    await createMessagingGroup({
      id: 'mg-dm-pat',
      channel_type: 'discord',
      platform_id: 'discord:dm-pat',
      name: 'pat',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await upsertUserDm({
      user_id: 'discord:pat',
      channel_type: 'discord',
      messaging_group_id: 'mg-dm-pat',
      resolved_at: now(),
    });
    sendsAs('discord:pat');
  });

  afterEach(() => {
    _dropGateTimersForTesting();
  });

  it("puts a post's card in the DM of the person it posts as, with the task, the text and the full command", async () => {
    const id = request('dm');
    await file('request_send_gate', id);

    const card = await getPendingApprovalByRequestId(id);
    expect(card).toMatchObject({ platform_id: 'discord:dm-pat', approver_user_id: 'discord:pat' });
    expect(card!.question).toContain(BRIEF);
    expect(card!.question).toContain('Ship it Friday.');
    expect(card!.question).toContain('curl -d @- https://slack.com/api/chat.postMessage');
    expect(card!.question).not.toContain('Read the playbook first.');
    expect(gateAck(id)).toEqual({ status: 'pending', error: null });
  });

  it("runs on that person's click and on no other owner's or admin's", async () => {
    const id = request('who');
    await file('request_send_gate', id);

    await click(id, 'discord:sam');
    await click(id, 'slack-example-labs:admin');
    expect(gateAck(id)).toEqual({ status: 'pending', error: null });

    await click(id, 'discord:pat');
    expect(gateAck(id)).toEqual({ status: 'delivered', error: null });
  });

  it('holds the session awake until the card can no longer be answered, then times it out', async () => {
    const id = request('wait');
    await file('request_send_gate', id);
    const deadline = await openGateDeadlineMs('sess-bg');
    expect(deadline).toBeGreaterThan(Date.now() + 59 * MINUTE);

    _dropGateTimersForTesting();
    expect(await expireOverdueGates(Date.now() + 61 * MINUTE)).toBe(1);
    expect(gateAck(id)).toEqual({ status: 'failed', error: 'Send gate timed out after 60 minutes.' });
    expect(await openGateDeadlineMs('sess-bg')).toBeNull();
  });

  it.each([
    ['nobody is configured', null],
    ['the configured person holds no role here', 'discord:stranger'],
  ])('refuses a post when %s, saying nobody is watching', async (_label, sender) => {
    if (sender === 'discord:stranger') {
      await upsertUser({ id: sender, kind: 'discord', display_name: 'x', created_at: now() });
    }
    sendsAs(sender);
    const id = request('none');
    await file('request_send_gate', id);

    expect(await getPendingApprovalByRequestId(id)).toBeUndefined();
    expect(gateAck(id)).toMatchObject({ status: 'failed', error: expect.stringContaining('nobody is watching') });
  });

  it.each([
    ['its command', `curl -d '${'x'.repeat(2000)}' https://slack.com/api/chat.postMessage`, 'Ship it Friday.'],
    [
      'text the command does not carry',
      'curl -d @/workspace/draft.json https://slack.com/api/chat.postMessage',
      'y'.repeat(2000),
    ],
    [
      'a command carrying the text',
      `curl -d '{"text":"${'z'.repeat(2000)}"}' https://slack.com/api/chat.postMessage`,
      'z'.repeat(2000),
    ],
  ])('refuses a post when %s is too long to show in full, rather than cut it', async (_label, command, text) => {
    const id = request('long');
    await getDeliveryAction('request_send_gate')!(
      { requestId: id, label: 'Slack post', summary: 'Post to #general as Pat.', command, sendParts: [text] },
      (await getSession('sess-bg'))!,
    );

    expect(await getPendingApprovalByRequestId(id)).toBeUndefined();
    expect(gateAck(id)).toMatchObject({ status: 'failed', error: expect.stringContaining('too long to show in full') });
  });

  it('refuses a post whose text the hook could not read, since the card could not show it', async () => {
    const id = request('unread');
    await getDeliveryAction('request_send_gate')!(
      {
        requestId: id,
        label: 'Email',
        summary: 'Email to a client.',
        command: 'gws gmail send --body "$(cat draft.txt)"',
      },
      (await getSession('sess-bg'))!,
    );

    expect(await getPendingApprovalByRequestId(id)).toBeUndefined();
    expect(gateAck(id)).toMatchObject({ status: 'failed', error: expect.stringContaining('could not be read') });
  });

  const carried = 'w'.repeat(1000);
  const carrying = `curl -d '{"channel":"C1","text":"${carried}"}' https://slack.com/api/chat.postMessage`;
  async function fileLong(id: string): Promise<void> {
    await getDeliveryAction('request_send_gate')!(
      {
        requestId: id,
        label: 'Slack post',
        summary: 'Post to #general as Pat.',
        command: carrying,
        sendParts: [carried],
      },
      (await getSession('sess-bg'))!,
    );
  }

  it('shows only the full command when the text block would not fit and the command carries the text', async () => {
    const id = request('cmd-only');
    await fileLong(id);

    const card = await getPendingApprovalByRequestId(id);
    expect(card).toBeDefined();
    expect(card!.question).toContain(carrying);
    expect(card!.question).not.toContain('Text, exactly as it will post:');
  });

  it("sizes the card to the approver's own DM platform", async () => {
    await createMessagingGroup({
      id: 'mg-dm-admin',
      channel_type: 'slack-example-labs',
      platform_id: 'slack:D1',
      instance: 'slack-example-labs',
      name: 'admin',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await upsertUserDm({
      user_id: 'slack-example-labs:admin',
      channel_type: 'slack-example-labs',
      messaging_group_id: 'mg-dm-admin',
      resolved_at: now(),
    });
    sendsAs('slack-example-labs:admin');
    const id = request('slack-dm');
    await fileLong(id);

    const card = await getPendingApprovalByRequestId(id);
    expect(card).toMatchObject({ platform_id: 'slack:D1', approver_user_id: 'slack-example-labs:admin' });
    expect(card!.question).toContain('Text, exactly as it will post:');
    expect(card!.question).toContain(carrying);
  });

  it.each(['request_destructive_gate', 'request_prod_gate', 'request_bash_gate'])(
    '%s stays refused, and tells the agent nobody is watching so it hands the step on',
    async (action) => {
      const id = request('other');
      await file(action, id, 'render services delete srv-x');

      expect(await getPendingApprovalByRequestId(id)).toBeUndefined();
      expect(mocks.deliver).not.toHaveBeenCalled();
      expect(gateAck(id)).toMatchObject({
        status: 'failed',
        error: expect.stringContaining('Hand the step to a person'),
      });
    },
  );
});
