/**
 * `post_as_owner` and `upload_as_owner`: an agent posts, edits or uploads in the owner's Slack name through the host,
 * never with the token itself. The host holds the exact request once, in the approval row, and sends that.
 *
 * Every request takes a card showing it in full: in the thread, or in the group's `sends_as_user_id` DM from a session
 * with no conversation.
 */
import crypto from 'crypto';

import { getAgentGroup } from '../../db/agent-groups.js';
import { getApprovalByRequestId } from '../../db/sessions.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { readContainerConfig } from '../../container-config.js';
import { reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';
import { log } from '../../log.js';
import { isReservedAgent } from '../../reserved-secrets.js';
import { readOutboxFiles, withExistingMailboxSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import {
  notifyAgent,
  registerApprovalHandler,
  registerApprovalResolvedHandler,
  requestApprovalOutcome,
} from '../approvals/primitive.js';
import { NOBODY_WATCHING, cardBodyBudget, chatlessCardBudget, chatlessSender, taskBrief } from '../bash-gate/index.js';
import { resolveUserChannelType } from '../permissions/user-dm.js';
import { sessionIsOwnerSafe } from '../permissions/task-slack-subject.js';
import { NO_ANSWER, slackUserApiFor, type SlackResult, type SlackUserApi } from '../../slack-user-api.js';

const REQUEST_ACTION = 'request_post_as_owner';
const POST_AS_OWNER_APPROVAL = 'post-as-owner';
const CARD_TTL_MS = 60 * 60 * 1000;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const CHANNEL_RE = /^[CDG][A-Z0-9]{6,}$/;
const TS_RE = /^\d{9,11}\.\d{6}$/;
const MAX_TEXT_CHARS = 4000;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const OPS = ['post', 'update', 'upload'] as const;
type Op = (typeof OPS)[number];
/** Facts only the host sets; an agent's request never carries them in. */
const HOST_FIELDS = ['fileSha256', 'fileSize', 'approvalId'] as const;

/**
 * The OneCLI agent holding a workspace's posting token. Containers get a read-only token, so this reserved agent,
 * which no container may run as, is the only holder of one that can write. A workgroup id the reserved pattern can't
 * hold verbatim names no agent: 51 characters can't encode every valid id, so any shortened form could hand one
 * workgroup another's token.
 */
function ownerPostAgent(workgroupId: string | null | undefined): string | null {
  const agent = `approved-run-slack-owner-${workgroupId}`;
  return workgroupId && isReservedAgent(agent) ? agent : null;
}

let apiFor: (onecliAgent: string) => Promise<SlackUserApi> = slackUserApiFor;
export function _setSlackOwnerApiForTest(fn: ((onecliAgent: string) => Promise<SlackUserApi>) | null): void {
  apiFor = fn ?? slackUserApiFor;
}

/** Payloads the approval handler built; only these may carry host fields into a replay. */
const hostReplays = new WeakSet<object>();
/** What Slack answered, by request id, so a request whose result failed to record is never sent twice. */
const finished = new Map<string, { ok: true; receipt: string } | { error: string }>();
/** Why an approved replay sent nothing, keyed by approval id, so the card's resolution says so. */
const refusals = new Map<string, string>();

interface Request {
  requestId: string;
  op: Op;
  channel: string;
  threadTs?: string;
  ts?: string;
  text: string;
  file?: string;
  title?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function parse(content: Record<string, unknown>): Request | string {
  const requestId = str(content.requestId);
  if (!requestId || !REQUEST_ID_RE.test(requestId)) return 'the request id is missing or invalid';
  const op = content.op as Op;
  if (!OPS.includes(op)) return 'op must be post, update or upload';
  const channel = str(content.channel);
  if (!channel || !CHANNEL_RE.test(channel))
    return 'channel must be a Slack channel or DM id (C…, G… or D…), not a name';
  const threadTs = str(content.threadTs);
  if (threadTs !== undefined && !TS_RE.test(threadTs))
    return 'thread_ts must be a Slack message ts such as 1712345678.123456';
  const ts = str(content.ts);
  if (op === 'update' && (!ts || !TS_RE.test(ts))) return 'editing a message needs its ts';
  if (op === 'update' && threadTs !== undefined) return 'an edit takes no thread_ts: the message stays where it is';
  const text = typeof content.text === 'string' ? content.text : '';
  if (op !== 'upload' && !text.trim()) return 'text is required';
  if (text.length > MAX_TEXT_CHARS) return `text is over ${MAX_TEXT_CHARS} characters; split it into shorter posts`;
  const file = str(content.file);
  if (op === 'upload' && !file) return 'an upload needs a file';
  return {
    requestId,
    op,
    channel,
    threadTs,
    ts: op === 'update' ? ts : undefined,
    text,
    file,
    title: str(content.title),
  };
}

/** The request exactly as it was held for the card; a replay must match it field for field. */
function held(req: Request, extra: { fileSha256?: string; fileSize?: number }): Record<string, unknown> {
  return { ...req, ...extra };
}

async function settle(session: Session, requestId: string, outcome: { ok: true; receipt: string } | { error: string }) {
  await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
    if ('ok' in outcome) mailbox.markDelivered(requestId, outcome.receipt);
    else mailbox.markDeliveryFailed(requestId, outcome.error);
  });
}

/** A refusal reaches the waiting tool call and, for a replay, the agent and the card too. */
async function refuse(content: Record<string, unknown>, session: Session, why: string): Promise<void> {
  const requestId = str(content.requestId);
  if (requestId && REQUEST_ID_RE.test(requestId)) {
    await settle(session, requestId, { error: why }).catch((err) =>
      log.warn('post_as_owner refusal could not be recorded', { requestId, err }),
    );
  }
  if (typeof content.approvalId === 'string') {
    refusals.set(content.approvalId, `Nothing was sent: ${why}`);
    await notifyAgent(session, `Post as the owner refused: ${why}`).catch((err) =>
      log.warn('Failed to tell the agent its post was refused', { err }),
    );
  }
}

function outboxFile(session: Session, req: Request): Buffer | string {
  const files = readOutboxFiles(session.agent_group_id, session.id, req.requestId, [req.file!]);
  const data = files?.[0]?.data;
  if (!data) return `the file ${req.file} was not handed to the host`;
  if (data.length === 0) return 'the file is empty';
  if (data.length > MAX_FILE_BYTES) return `the file is over ${MAX_FILE_BYTES / 1024 / 1024} MB`;
  return data;
}

async function precheck(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const done = typeof content.requestId === 'string' ? finished.get(content.requestId) : undefined;
  if (done) {
    // Already sent; only recording the result failed. Record it again rather than ask or send a second time.
    await settle(session, content.requestId as string, done);
    return false;
  }
  const replay = hostReplays.has(content);
  if (!replay) for (const field of HOST_FIELDS) delete content[field];
  if (!replay && typeof content.requestId === 'string') {
    // A card already went out for this request (a retry after its pending mark failed): never decide it again.
    const carded = await getApprovalByRequestId(content.requestId, session.id, POST_AS_OWNER_APPROVAL);
    if (carded) {
      if (carded.status === 'pending') {
        await withExistingMailboxSession(session.agent_group_id, session.id, (m) =>
          m.markPending(content.requestId as string),
        );
      }
      return false;
    }
  }
  const req = parse(content);
  if (typeof req === 'string') {
    await refuse(content, session, req);
    return false;
  }
  const group = await getAgentGroup(session.agent_group_id);
  const cfg = group ? readContainerConfig(group.folder) : undefined;
  if (!cfg?.post_as_owner) {
    await refuse(content, session, 'posting as the owner is not turned on for this agent');
    return false;
  }
  if (!group?.workgroup_id) {
    await refuse(content, session, 'posting as the owner needs this agent to belong to a workgroup');
    return false;
  }
  if (!ownerPostAgent(group.workgroup_id)) {
    await refuse(
      content,
      session,
      "posting as the owner needs a workgroup id of lowercase letters, digits and hyphens, at most 51 characters; this agent's workgroup id is not one",
    );
    return false;
  }
  if (!(await sessionIsOwnerSafe(session, cfg.slack_user_token?.also_allowed_in))) {
    await refuse(
      content,
      session,
      "this conversation is not one of the owner's own Slack contexts, so it cannot post as them",
    );
    return false;
  }
  if (req.op === 'upload') {
    const data = outboxFile(session, req);
    if (typeof data === 'string') {
      await refuse(content, session, data);
      return false;
    }
    content.fileSha256 = crypto.createHash('sha256').update(data).digest('hex');
    content.fileSize = data.length;
    return true;
  }
  return true;
}

function decide(input: GuardInput) {
  if (input.actor.kind !== 'agent') return DENY('posts as the owner are requested by an agent');
  return HOLD('the owner or an admin approves this exact post');
}

function grantCoversRequest(grant: PendingApproval, input: GuardInput): boolean {
  let was: Record<string, unknown>;
  try {
    was = JSON.parse(grant.payload) as Record<string, unknown>;
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable grant covers nothing
  } catch {
    return false;
  }
  if (Date.now() - Date.parse(grant.created_at) > CARD_TTL_MS) return false;
  const req = parse(input.payload);
  if (typeof req === 'string') return false;
  const now = held(req, {
    fileSha256: input.payload.fileSha256 as string | undefined,
    fileSize: input.payload.fileSize as number | undefined,
  });
  const keys = new Set([...Object.keys(was), ...Object.keys(now)]);
  return [...keys].every((k) => was[k] === now[k]);
}

const postAsOwnerExecute = defineGuardedAction({
  action: 'post_as_owner.execute',
  grantActionName: POST_AS_OWNER_APPROVAL,
  decide,
  grantCoversRequest,
});

/** Card text shows the exact characters; a triple backtick inside would close the fence, so it is shown spaced. */
/**
 * The card shows the exact characters. A triple backtick would close the fence, and the chat library turns
 * `{{emoji:name}}` into an emoji even inside one, so both are shown broken by a zero-width space.
 */
function fence(text: string): string {
  return '```\n' + text.replace(/```/g, '`\u200b`\u200b`').replace(/\{\{(?=emoji:)/gi, '{\u200b{') + '\n```';
}

function cardTitle(req: Request): string {
  if (req.op === 'update') return '✏️ Edit your message';
  if (req.op === 'upload') return '📎 Upload as you';
  return '✉️ Post as you';
}

function cardBody(req: Request, size: number | undefined, sha: string | undefined, head: string[], who: string) {
  const where = `<#${req.channel}>${req.threadTs ? `, in the thread of ${req.threadTs}` : ''}`;
  const parts = [...head];
  if (req.op === 'update') parts.push(`Edit your message ${req.ts} in ${where} to exactly:`, fence(req.text));
  else if (req.op === 'upload') {
    parts.push(
      `Upload \`${req.file}\` (${size} bytes, sha256 ${sha?.slice(0, 12)}) to ${where}${req.title ? `, titled "${req.title}"` : ''}.`,
    );
    if (req.text) parts.push('With this comment, exactly:', fence(req.text));
  } else parts.push(`Post to ${where}, exactly:`, fence(req.text));
  parts.push(`_${who} Reject, or no answer within ${CARD_TTL_MS / 60_000} min, sends nothing._`);
  return parts.join('\n\n');
}

async function requestHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const req = parse(content) as Request;
  const size = content.fileSize as number | undefined;
  const sha = content.fileSha256 as string | undefined;
  const title = cardTitle(req);
  let delivery: { deliveryTarget: 'thread' } | { deliveryTarget: 'admin'; approverUserId: string };
  let question: string;
  if (session.messaging_group_id) {
    const platformId = (await getMessagingGroup(session.messaging_group_id))?.platform_id;
    question = cardBody(req, size, sha, [], 'Only an owner or admin of this agent can approve.');
    if (question.length > cardBodyBudget(platformId, title)) {
      return refuse(content, session, 'it is too long to show in full on a card; split it into shorter posts');
    }
    delivery = { deliveryTarget: 'thread' };
  } else {
    const approverUserId = await chatlessSender(session);
    if (!approverUserId) {
      return refuse(
        content,
        session,
        `${NOBODY_WATCHING} No one is set to approve posts from background sessions here.`,
      );
    }
    const brief = taskBrief(session);
    const head = [`_Asked by a background task with no conversation${brief ? `: ${brief}` : ''}_`];
    question = cardBody(req, size, sha, head, 'Only you can approve.');
    if (question.length > chatlessCardBudget(await resolveUserChannelType(approverUserId), title)) {
      return refuse(content, session, `${NOBODY_WATCHING} It is too long to show in full on a card.`);
    }
    delivery = { deliveryTarget: 'admin', approverUserId };
  }
  const outcome = await requestApprovalOutcome({
    session,
    agentName: session.agent_group_id,
    action: POST_AS_OWNER_APPROVAL,
    requestId: req.requestId,
    payload: held(req, { fileSha256: sha, fileSize: size }),
    title,
    question,
    ...delivery,
  });
  if (outcome === 'posted') {
    await withExistingMailboxSession(session.agent_group_id, session.id, (m) => m.markPending(req.requestId));
    return;
  }
  await refuse(
    content,
    session,
    outcome === 'duplicate-request'
      ? 'this request is already waiting on a card'
      : 'the approval card could not be posted',
  );
}

async function send(api: SlackUserApi, session: Session, req: Request, sha: unknown): Promise<SlackResult> {
  if (req.op === 'update') return api.updateMessage(req.channel, req.ts!, req.text);
  if (req.op === 'post') return api.postMessage(req.channel, req.text, req.threadTs);
  // The bytes sent are the bytes hashed here, so a file rewritten after the guard read it is not what uploads.
  const data = outboxFile(session, req);
  if (typeof data === 'string') return { ok: false, error: data, local: true };
  if (crypto.createHash('sha256').update(data).digest('hex') !== sha) {
    return { ok: false, error: 'the file changed after it was approved', local: true };
  }
  return api.uploadFile(
    req.channel,
    { name: req.file!, bytes: data },
    { threadTs: req.threadTs, title: req.title, comment: req.text || undefined },
  );
}

/**
 * Records a sent request's result. On the "send" path a failure throws, so the delivery loop retries and `finished`
 * re-records it; an approved replay has no retry, so it logs and lets the agent's notice carry the result.
 */
async function settleOrSurface(
  session: Session,
  requestId: string,
  outcome: { ok: true; receipt: string } | { error: string },
  replay: boolean,
): Promise<void> {
  try {
    await settle(session, requestId, outcome);
  } catch (err) {
    if (!replay) throw err;
    log.warn('post_as_owner result could not be recorded; the agent is told directly', { requestId, err });
  }
}

async function execute(content: Record<string, unknown>, session: Session): Promise<{ deferAck: true }> {
  const req = parse(content) as Request;
  const replay = typeof content.approvalId === 'string';
  const agent = ownerPostAgent((await getAgentGroup(session.agent_group_id))?.workgroup_id);
  let result: SlackResult;
  try {
    result = agent
      ? await send(await apiFor(agent), session, req, content.fileSha256)
      : { ok: false, error: 'this agent no longer belongs to a workgroup that can post as the owner', local: true };
    // eslint-disable-next-line no-catch-all/no-catch-all -- every failure is reported to the requester, never retried
  } catch (err) {
    log.warn('post_as_owner send failed', { requestId: req.requestId, err });
    result = { ok: false, error: NO_ANSWER };
  }
  if (!result.ok) {
    const why =
      result.error === NO_ANSWER
        ? 'Slack did not answer, so it may or may not have gone out; check the channel before asking again'
        : result.local
          ? `${result.error}; nothing was sent`
          : `Slack refused it (${result.error}); nothing was sent`;
    finished.set(req.requestId, { error: why });
    if (replay) refusals.set(content.approvalId as string, why);
    // Before recording, which can throw: the waiting tool call may have stopped listening before Slack answered.
    await notifyAgent(session, `Post as the owner failed: ${why}. Request ${req.requestId}.`);
    await settleOrSurface(session, req.requestId, { error: why }, replay);
    return { deferAck: true };
  }
  const receipt = result.ts ?? result.fileId ?? '';
  finished.set(req.requestId, { ok: true, receipt });
  await settleOrSurface(session, req.requestId, { ok: true, receipt }, replay);
  log.info('Posted as the owner', { requestId: req.requestId, op: req.op, channel: req.channel, replay });
  if (replay) {
    const done =
      req.op === 'upload'
        ? `uploaded (file ${receipt})`
        : `${req.op === 'update' ? 'edited' : 'posted'} (ts ${receipt})`;
    await notifyAgent(session, `Approved and ${done} in ${req.channel}. Request ${req.requestId}.`);
  }
  return { deferAck: true };
}

registerDeliveryAction(REQUEST_ACTION, execute, {
  guardAction: postAsOwnerExecute,
  precheck,
  requestHold,
  ownsAck: true,
  onDeny: (content, session, reason) =>
    refuse(
      content,
      session,
      typeof content.approvalId === 'string'
        ? `the approval no longer covers this request (${reason}); ask again for a fresh card`
        : reason,
    ),
});

registerApprovalHandler(
  POST_AS_OWNER_APPROVAL,
  async (ctx) => {
    const payload = { ...ctx.payload, approvalId: ctx.approval.approval_id };
    hostReplays.add(payload);
    await reenterGuardedDeliveryAction(REQUEST_ACTION)({ session: ctx.session, payload, approval: ctx.approval });
    const refused = refusals.get(ctx.approval.approval_id);
    if (refused) {
      refusals.delete(ctx.approval.approval_id);
      return { declined: refused };
    }
  },
  { adminClickOnly: true },
);

/** A reject with a reason resolves twice (at the click and when the hold ends); the agent hears it once. */
const declined = new Set<string>();

registerApprovalResolvedHandler(async ({ approval, session, outcome }) => {
  if (outcome !== 'reject' || approval.action !== POST_AS_OWNER_APPROVAL) return;
  if (declined.has(approval.approval_id)) return;
  declined.add(approval.approval_id);
  await settle(session, approval.request_id, { error: 'Declined on the card; nothing was sent.' });
  await notifyAgent(session, `"${approval.title}" was declined. Nothing was sent. Request ${approval.request_id}.`);
});
