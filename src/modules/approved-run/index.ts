import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAction, reenterGuardedDeliveryAction, registerDeliveryAction } from '../../delivery.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { agentsHoldingSecret } from '../../onecli-secrets.js';
import type { Session } from '../../types.js';
import { registerChoiceHandler } from '../approvals/choices.js';
import { notifyAgent, requestApprovalOutcome } from '../approvals/primitive.js';
import { getUser } from '../permissions/db/users.js';
import { resolveUserChannelType } from '../permissions/user-dm.js';
import {
  CARD_OPTIONS,
  RUN_VALUE,
  cardQuestion,
  cardTitle,
  questionBudget,
  ranPhrase,
  rowsForAgent,
  runReport,
} from './card.js';
import { classify, sha256, type Classification } from './classify.js';
import { APPROVED_RUN_ACTION, approvedRunExecute } from './guard.js';
import {
  RunClaimedError,
  executeRun,
  interruptedRuns,
  markInterrupted,
  runResultLabel,
  tokenHolding,
  type RunMeta,
  type RunResult,
} from './execute.js';
import { deliverQueued, queueReport, type Leg, type Route } from './outbox.js';
import { sqlApiFor } from './sql-api.js';
import { renderApiFor } from './render-api.js';
import { renderCardQuestion, renderResponseForAgent, renderRunReport } from './render-card.js';
import { executeRenderRun, type RenderRunResult } from './render-execute.js';
import { maskKey, requestRef } from './render-mask.js';
import { classifyRenderRequest, requestSha, type RenderClassification } from './render-request.js';
import {
  migrateCardQuestion,
  migrateInterruptedText,
  migrateOutputForAgent,
  migrateRunReport,
} from './migrate-card.js';
import { baselineFor } from './migrate-drift.js';
import { executeMigrateRun, removeRunLeftovers, type MigrateRunResult } from './migrate-execute.js';
import { migrationFacts } from './migrate-facts.js';
import { repoReader } from './migrate-repo.js';
import {
  classifyMigration,
  proposalSha,
  type MigrateClassification,
  type MigrationEntry,
  type MigrationProposal,
} from './migrate-request.js';
import { stopLeftoverSandboxes } from './migrate-sandbox.js';
import { verifySource, type SourceLink } from './snowflake-source.js';
import {
  loadTarget,
  laneIdentities,
  type ApprovedRunTarget,
  type MigrateTarget,
  type RenderTarget,
} from './targets.js';
import './render-env-read.js';
import './token-guard.js';

const REQUEST_ACTION = 'request_approved_run';
const MAX_SQL_BYTES = 256 * 1024;
const MAX_REASON_CHARS = 300;
const REQUEST_ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const RUN_ID_RE = /^[A-Za-z0-9._-]{1,128}$/;

/** Why a "Run it" replay ran nothing, keyed by approval id, so the card's thread hears it too. */
const refusals = new Map<string, string>();
/** Payloads the choice handler built; only these may carry the replay's approval id, approver and route. */
const hostReplays = new WeakSet<object>();
/**
 * The target as the precheck read it, per request object. The card and the run read only this: reloading the config
 * at each step let one request mix two versions (one version's approvers on a card that binds another's hash).
 */
const snapshots = new WeakMap<object, ApprovedRunTarget>();
const REPLAY_FIELDS = ['approvalId', 'approvedBy', 'route'] as const;

function report(content: Record<string, unknown>, session: Session, text: string): void {
  // A refused "Run it" is reported by the choice handler, to the thread and the agent together, through the outbox.
  if (typeof content.approvalId === 'string') {
    refusals.set(content.approvalId, text);
    return;
  }
  void notifyAgent(session, `Approved run refused: ${text}`).catch((err) =>
    log.warn('Failed to tell the agent its approved run was refused', { err }),
  );
}

/** Queues a report, then tries to deliver it now; whatever does not land is retried by the sweep. */
function sendReport(id: string, legs: Leg[]): void {
  queueReport(id, legs);
  void deliverQueued([id]).catch((err) => log.warn('Approved-run report delivery failed', { id, err }));
}

async function sessionRoute(session: Session): Promise<Route | null> {
  const mg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  return mg
    ? {
        channelType: mg.channel_type,
        platformId: mg.platform_id,
        threadId: session.thread_id,
        instance: mg.instance ?? null,
      }
    : null;
}

async function precheck(content: Record<string, unknown>, session: Session): Promise<boolean> {
  if (!hostReplays.has(content)) for (const field of REPLAY_FIELDS) delete content[field];
  const { target: targetId, sql, reason, requestId } = content;
  if (typeof targetId !== 'string' || typeof reason !== 'string') {
    report(content, session, 'target and reason are required');
    return false;
  }
  if (
    typeof requestId !== 'string' ||
    !REQUEST_ID_RE.test(requestId) ||
    !RUN_ID_RE.test(`${session.agent_group_id}--${requestId}`)
  ) {
    report(content, session, 'the request id is missing or invalid');
    return false;
  }
  if (!reason.trim() || reason.length > MAX_REASON_CHARS) {
    report(content, session, `reason must be 1–${MAX_REASON_CHARS} characters`);
    return false;
  }
  const target = loadTarget(targetId);
  if ('error' in target) {
    report(content, session, target.error);
    return false;
  }
  if (!target.agentGroups.includes(session.agent_group_id)) {
    report(content, session, `this agent may not propose runs for ${target.label}`);
    return false;
  }
  if (typeof content.approvalId === 'string' && content.targetSha !== target.entrySha) {
    report(
      content,
      session,
      `${target.label}'s entry in the approved-run config changed after the card was posted (its connection, approvers, roles or classifier pin), so this approval no longer covers it. Propose it again for a fresh card.`,
    );
    return false;
  }
  if (target.kind === 'snowflake') {
    if (typeof sql !== 'string') {
      report(content, session, 'sql is required');
      return false;
    }
    if (!sql.trim()) {
      report(content, session, 'the file is empty');
      return false;
    }
    if (Buffer.byteLength(sql, 'utf8') > MAX_SQL_BYTES) {
      report(content, session, `the file is over ${MAX_SQL_BYTES / 1024} KB; split it`);
      return false;
    }
  }
  if (!hostReady.has(content) && !hostReplays.has(content)) {
    prepare(content, session, target);
    return false;
  }
  if (hostReady.has(content) && content.readyFor !== target.entrySha) {
    report(content, session, `${target.label}'s config changed while the request was being checked. Propose it again.`);
    return false;
  }
  if (target.kind === 'render') return precheckRender(content, session, target);
  if (target.kind === 'repo-migrate') return precheckMigrate(content, session, target);
  if (typeof sql !== 'string') return false;
  const fileSha = sha256(sql);
  if (typeof content.approvalId === 'string' && content.sha256 !== fileSha) {
    report(content, session, 'the stored file no longer matches the sha256 the card showed');
    return false;
  }
  const classification = await classify(target, sql);
  if ('error' in classification) {
    report(content, session, classification.error);
    return false;
  }
  snapshots.set(content, target);
  content.sha256 = fileSha;
  content.targetSha = target.entrySha;
  content.classification = classification;
  content.reason = reason.trim();
  return true;
}

function precheckRender(content: Record<string, unknown>, session: Session, target: RenderTarget): boolean {
  const classification = classifyRenderRequest(target, content.request);
  const sha = classification.request
    ? requestSha(classification.request)
    : sha256(JSON.stringify(content.request ?? null));
  if (typeof content.approvalId === 'string' && content.sha256 !== sha) {
    report(content, session, 'the stored request no longer matches the sha256 the card showed');
    return false;
  }
  snapshots.set(content, target);
  content.sha256 = sha;
  content.targetSha = target.entrySha;
  content.classification = classification;
  content.reason = (content.reason as string).trim();
  return true;
}

/** Requests the host prepared in the background; agent content is never in here. */
const hostReady = new WeakSet<object>();
/** One request per target at a time: each reads every agent's grants, and a migration also starts a sandbox. */
const preparing = new Map<string, Promise<unknown>>();

async function classifyRequest(target: MigrateTarget, migration: unknown): Promise<MigrateClassification> {
  const repo = repoReader(target.repo);
  return classifyMigration(target, migration, repo, (p) => migrationFacts(target, repo, p));
}

function identitiesFor(target: ApprovedRunTarget, content: Record<string, unknown>) {
  if (target.kind !== 'repo-migrate') return laneIdentities(target);
  const files = (content.migration as { files?: unknown } | null | undefined)?.files;
  return laneIdentities(
    target,
    Array.isArray(files) ? files.map((f) => (f as { database?: unknown } | null)?.database) : [],
  );
}

/** A card for a target whose key is not stored would look runnable, so none is posted until each key is in place. */
async function notReady(target: ApprovedRunTarget, content: Record<string, unknown>): Promise<string | null> {
  for (const { secret, onecliAgent } of identitiesFor(target, content)) {
    const problem = await tokenHolding(agentsHoldingSecret, secret, onecliAgent);
    if (!problem) continue;
    return problem.unreadable
      ? `the host couldn't check whether ${target.label} is set up (${problem.problem}), so nothing was proposed. Try again later.`
      : `${target.label} isn't set up yet (${problem.problem}), so nothing was proposed.`;
  }
  return null;
}

/**
 * Reading every agent's grants takes seconds, and a migration's repository checks take minutes, while delivery awaits
 * a precheck. So a fresh request is prepared in the background and re-enters the action; an approved replay comes from
 * a card answer, not the delivery loop, and is checked in place.
 */
function prepare(content: Record<string, unknown>, session: Session, target: ApprovedRunTarget): void {
  const prior = preparing.get(target.id) ?? Promise.resolve();
  const next = prior
    .then(async () => {
      const refusal = await notReady(target, content);
      if (refusal) return report(content, session, refusal);
      const classification =
        target.kind === 'repo-migrate' ? { classification: await classifyRequest(target, content.migration) } : {};
      let sourceLink: SourceLink | null = null;
      if (target.kind === 'snowflake') {
        const link = await verifySource(target, content.source, content.sql as string);
        if (link && 'error' in link) return report(content, session, link.error);
        sourceLink = link;
      }
      const payload = { ...content, ...classification, sourceLink, readyFor: target.entrySha };
      hostReady.add(payload);
      await getDeliveryAction(REQUEST_ACTION)!(payload, session);
    })
    .catch((err: unknown) =>
      report(content, session, err instanceof Error ? err.message.slice(0, 300) : 'the request could not be checked'),
    );
  preparing.set(target.id, next);
}

export async function __approvedRunPreparedForTest(): Promise<void> {
  for (;;) {
    const pending = [...preparing.values()];
    await Promise.all(pending);
    if ([...preparing.values()].every((p) => pending.includes(p))) return;
  }
}

async function precheckMigrate(
  content: Record<string, unknown>,
  session: Session,
  target: MigrateTarget,
): Promise<boolean> {
  const classification = hostReady.has(content)
    ? (content.classification as MigrateClassification)
    : await classifyRequest(target, content.migration);
  const sha = classification.proposal
    ? proposalSha(classification.proposal)
    : sha256(JSON.stringify(content.migration ?? null));
  if (typeof content.approvalId === 'string' && content.sha256 !== sha) {
    report(content, session, 'the stored proposal no longer matches the sha256 the card showed');
    return false;
  }
  snapshots.set(content, target);
  content.sha256 = sha;
  content.targetSha = target.entrySha;
  content.classification = classification;
  content.reason = (content.reason as string).trim();
  return true;
}

/** The card's budget: the thread's platform, and each approver's, since a DM copy reaches them on their own. */
async function landsOn(session: Session, approvers: string[]): Promise<number> {
  const thread = (await sessionRoute(session))?.channelType ?? 'unknown';
  const theirs = await Promise.all(approvers.map(async (id) => (await resolveUserChannelType(id)) ?? 'unknown'));
  return questionBudget([thread, ...theirs]);
}

async function approverNames(ids: string[]): Promise<string[]> {
  return Promise.all(ids.map(async (id) => (await getUser(id))?.display_name || id));
}

async function requestHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const target = snapshots.get(content);
  if (!target) return report(content, session, 'the host lost track of this request; propose it again');
  const fileSha = content.sha256 as string;
  let question: string;
  try {
    const names = await approverNames(target.approvers);
    question =
      target.kind === 'render'
        ? renderCardQuestion(target, content.classification as RenderClassification, fileSha, names, maskKey(target.id))
        : target.kind === 'repo-migrate'
          ? migrateCardQuestion(target, content.classification as MigrateClassification, names, baselineFor(target))
          : cardQuestion(
              target,
              content.classification as Classification,
              fileSha,
              names,
              (content.sourceLink as SourceLink | null | undefined) ?? null,
              await landsOn(session, target.approvers),
            );
  } catch (err) {
    return report(content, session, err instanceof Error ? err.message : 'the card could not be built');
  }
  const outcome = await requestApprovalOutcome({
    session,
    agentName: session.agent_group_id,
    action: APPROVED_RUN_ACTION,
    requestId: content.requestId as string,
    payload: {
      target: target.id,
      ...(target.kind === 'render'
        ? { request: content.request }
        : target.kind === 'repo-migrate'
          ? { migration: content.migration }
          : { sql: content.sql }),
      sha256: fileSha,
      targetSha: content.targetSha,
      reason: content.reason,
      requestId: content.requestId,
      classification: content.classification,
      approvers: target.approvers,
    },
    title: cardTitle(target, content.reason as string),
    question,
    deliveryTarget: 'thread',
    options: CARD_OPTIONS,
  });
  if (outcome !== 'posted') return;
  // A throw here would make delivery retry the action and post a second card.
  await notifyAgent(
    session,
    `Approved run for ${target.label} is waiting on a named approver's card (${target.kind === 'render' ? `request ${requestRef(fileSha, maskKey(target.id))}` : `sha256 ${fileSha.slice(0, 12)}`}). Nothing has run.`,
  ).catch((err) => log.warn('Failed to tell the agent its card is up', { err }));
}

async function execute(content: Record<string, unknown>, session: Session): Promise<void> {
  const target = snapshots.get(content);
  if (!target) return report(content, session, 'the host lost track of this request; propose it again');
  const fileSha = content.sha256 as string;
  // Keyed on the request, not the card: a retried delivery can post a second card, and only one may run.
  const runId = `${session.agent_group_id}--${content.requestId as string}`;
  const meta = {
    runId,
    target: target.id,
    sha256: fileSha,
    reason: content.reason as string,
    agentGroupId: session.agent_group_id,
    sessionId: session.id,
    approvedBy: (content.approvedBy as string | undefined) ?? null,
    decidedAt: new Date().toISOString(),
  };
  const route = (content.route as Route | undefined) ?? (await sessionRoute(session));
  if (target.kind === 'render') return executeRender(target, content, session, { ...meta, route });
  if (target.kind === 'repo-migrate') return executeMigrate(target, content, session, { ...meta, route });
  const classification = content.classification as Classification;
  const api = await sqlApiFor(target.execute);
  let running: Promise<RunResult>;
  try {
    running = executeRun(
      target.execute,
      classification,
      { ...meta, route },
      {
        api,
        holders: agentsHoldingSecret,
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        settled: (settledResult) => {
          const text = runReport(target, runId, fileSha, meta.approvedBy, settledResult);
          queueReport(`run-${runId}`, [
            ...(route ? [{ to: 'thread' as const, route, text }] : []),
            { to: 'agent', sessionId: session.id, text: `${text}${rowsForAgent(settledResult)}` },
          ]);
        },
      },
    );
  } catch (err) {
    if (err instanceof RunClaimedError) return report(content, session, `run ${runId} already ran`);
    throw err;
  }
  afterClaim(running, runId, (result) =>
    log.info('Approved run executed', { runId, target: target.id, sha256: fileSha, result: runResultLabel(result) }),
  );
}

// Not awaited: the approver's card shows the answer only once the handler returns, and a run lasts as long as its
// statements.
function afterClaim<T>(running: Promise<T>, runId: string, done: (result: T) => void): void {
  void running.then(
    async (result) => {
      await deliverQueued([`run-${runId}`]).catch((err) =>
        log.warn('Approved-run report delivery failed', { runId, err }),
      );
      done(result);
    },
    (err: unknown) => {
      log.error('Approved run stopped with an error after it was claimed', { runId, err });
      // The code, not the message: a filesystem error's message carries host paths, and this text is posted to the thread.
      const code = (err as NodeJS.ErrnoException | null)?.code ?? (err instanceof Error ? err.name : 'unknown');
      closeInterrupted(`An error (${code}) stopped`, runId);
    },
  );
}

async function executeRender(
  target: RenderTarget,
  content: Record<string, unknown>,
  session: Session,
  meta: RunMeta,
): Promise<void> {
  const classification = content.classification as RenderClassification;
  const route = meta.route as Route | null;
  let key: Buffer;
  let running: Promise<RenderRunResult>;
  try {
    key = maskKey(target.id);
    running = executeRenderRun(target, classification, meta, {
      api: await renderApiFor(target.execute.onecliAgent),
      holders: agentsHoldingSecret,
      maskKey: key,
      settled: (settledResult) => {
        const text = renderRunReport(
          target,
          meta.runId,
          meta.sha256,
          meta.approvedBy,
          classification,
          settledResult,
          key,
        );
        queueReport(`run-${meta.runId}`, [
          ...(route ? [{ to: 'thread' as const, route, text }] : []),
          {
            to: 'agent',
            sessionId: session.id,
            text: `${text}${renderResponseForAgent(target, classification, settledResult, key)}`,
          },
        ]);
      },
    });
  } catch (err) {
    if (err instanceof RunClaimedError) return report(content, session, `run ${meta.runId} already ran`);
    throw err;
  }
  afterClaim(running, meta.runId, (result) =>
    log.info('Approved Render run executed', { runId: meta.runId, target: target.id, result: result.kind }),
  );
}

async function executeMigrate(
  target: MigrateTarget,
  content: Record<string, unknown>,
  session: Session,
  meta: RunMeta,
): Promise<void> {
  const classification = content.classification as MigrateClassification;
  const proposal = classification.proposal as MigrationProposal;
  const route = meta.route as Route | null;
  let running: Promise<MigrateRunResult>;
  try {
    running = executeMigrateRun(target, proposal, classification.executor ?? {}, meta, {
      repo: repoReader(target.repo),
      holders: agentsHoldingSecret,
      settled: (settledResult) => {
        const text = migrateRunReport(target, meta.runId, proposal, meta.approvedBy, settledResult);
        queueReport(`run-${meta.runId}`, [
          ...(route ? [{ to: 'thread' as const, route, text }] : []),
          { to: 'agent', sessionId: session.id, text: `${text}${migrateOutputForAgent(settledResult)}` },
        ]);
      },
    });
  } catch (err) {
    if (err instanceof RunClaimedError) return report(content, session, `run ${meta.runId} already ran`);
    throw err;
  }
  afterClaim(running, meta.runId, (result) =>
    log.info('Approved migration executed', { runId: meta.runId, target: target.id, result: runResultLabel(result) }),
  );
}

registerDeliveryAction(REQUEST_ACTION, execute, {
  guardAction: approvedRunExecute,
  precheck,
  requestHold,
  onDeny: (content, session, reason) =>
    report(
      content,
      session,
      typeof content.approvalId === 'string'
        ? `this approval no longer covers the request (${reason}). Propose it again for a fresh card.`
        : reason,
    ),
});

registerChoiceHandler(APPROVED_RUN_ACTION, async ({ approval, requester, value, userId }) => {
  const session = requester ?? (approval.session_id ? await getSession(approval.session_id) : undefined);
  if (!session) throw new Error('the requesting session no longer exists');
  const name = (await getUser(userId))?.display_name || userId;
  if (value !== RUN_VALUE) {
    await notifyAgent(session, `${name} chose not to run "${approval.title}". Nothing ran.`);
    return session;
  }
  const route: Route | null = approval.platform_id
    ? {
        channelType: approval.channel_type ?? '',
        platformId: approval.platform_id,
        threadId: approval.thread_id,
        instance: approval.instance,
      }
    : null;
  const payload = {
    ...(JSON.parse(approval.payload) as Record<string, unknown>),
    approvalId: approval.approval_id,
    approvedBy: name,
    route,
  };
  hostReplays.add(payload);
  await reenterGuardedDeliveryAction(REQUEST_ACTION)({ session, payload, approval });
  const refused = refusals.get(approval.approval_id);
  if (refused) {
    refusals.delete(approval.approval_id);
    sendReport(`refused-${approval.approval_id}`, [
      ...(route ? [{ to: 'thread' as const, route, text: `Nothing ran: ${refused}` }] : []),
      { to: 'agent', sessionId: session.id, text: `${name} chose Run it, but nothing ran: ${refused}` },
    ]);
  }
  return session;
});

function snowflakeInterruptedText(
  lead: string,
  runId: string,
  ran: number,
  steps: number,
  open: number | null,
  logUnreadable: boolean,
): string {
  if (logUnreadable) {
    return `${lead} approved run \`${runId}\` and its step log cannot be read, so what ran is unknown; check Snowflake query history for query tags starting \`approved-run ${runId} step\`. A retry is a new proposal for whatever did not run.`;
  }
  const unknown = open
    ? ` Step ${open} was sent and its outcome is unknown; check Snowflake query history for query tag \`approved-run ${runId} step ${open}\`.`
    : '';
  return `${lead} approved run \`${runId}\`: ${ranPhrase(ran, steps)}.${unknown} Nothing after that ran; a retry is a new proposal for the rest.`;
}

function renderInterruptedText(
  lead: string,
  runId: string,
  ran: number,
  open: number | null,
  logUnreadable: boolean,
): string {
  const head = `${lead} approved Render run \`${runId}\``;
  if (logUnreadable || open) {
    return `${head}, and whether Render applied its request is unknown; check the resource in the Render dashboard before proposing it again.`;
  }
  return ran
    ? `${head} after Render accepted its request; it is done.`
    : `${head}; its request was not sent or Render refused it, so nothing changed, and a retry is a new proposal.`;
}

function closeInterrupted(lead: string, only?: string): void {
  let runs: ReturnType<typeof interruptedRuns>;
  try {
    runs = interruptedRuns().filter((r) => only === undefined || r.meta.runId === only);
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable runs directory must never stop the host booting
  } catch (err) {
    log.error('Could not read approved-run records', { only, err });
    return;
  }
  for (const { meta, ran, open, logUnreadable } of runs) {
    // Each record recovers on its own: one that throws anywhere must not stop the host booting or the others.
    try {
      const kind = (meta as { kind?: unknown }).kind;
      const text =
        kind === 'render'
          ? renderInterruptedText(lead, meta.runId, ran, open, logUnreadable === true)
          : kind === 'repo-migrate'
            ? migrateInterruptedText(
                lead,
                meta.runId,
                (meta as { files?: MigrationEntry[] }).files ?? [],
                ran,
                open,
                logUnreadable === true,
              )
            : snowflakeInterruptedText(lead, meta.runId, ran, meta.steps, open, logUnreadable === true);
      // Queued before the run is closed, so a boot that dies in between finds the run still open and queues it again.
      queueReport(`run-${meta.runId}`, [
        ...(meta.route ? [{ to: 'thread' as const, route: meta.route as Route, text }] : []),
        { to: 'agent', sessionId: meta.sessionId, text },
      ]);
      markInterrupted(meta.runId, text);
      // eslint-disable-next-line no-catch-all/no-catch-all -- one unreadable record must not stop the others being reported
    } catch (err) {
      log.error('Could not close an interrupted approved run', { runId: meta.runId, err });
    }
  }
  void deliverQueued(only === undefined ? undefined : [`run-${only}`]).catch((err) =>
    log.warn('Approved-run report delivery failed', { err }),
  );
}

onHostStart(async function approvedRunInterruptedHostStart() {
  await stopLeftoverSandboxes();
  removeRunLeftovers();
  closeInterrupted('The host restarted during');
});
