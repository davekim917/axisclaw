/**
 * request_choice — a non-blocking button card backed by the approvals primitive.
 *
 * The card outlives the container: the pending_approvals row is central and
 * carries no expiry. An authorized click reaches relayChoice, which writes one
 * host-marked line into the session a typed reply in the card's thread would
 * reach, and wakes it.
 */
import type { OptionStyle, RawOption } from '../../channels/ask-question.js';
import { resolveThreadPolicy } from '../../channels/channel-defaults.js';
import { getChannelAdapter, getChannelDefaults } from '../../channels/channel-registry.js';
import { withCentralSync } from '../../db/central-lease.js';
import { getDb, hasTable } from '../../db/connection.js';
import {
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { getPendingApprovalByRequestId, getPendingApprovalsByAction } from '../../db/sessions.js';
import { registerDeliveryAction } from '../../delivery.js';
import { unguarded } from '../../guard/index.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { resolveSession, sessionMessageExists } from '../../session-manager.js';
import { isChannelVariant, type MessagingGroup, type PendingApproval, type Session } from '../../types.js';
import { cardOverrun } from '../approvals/card-budget.js';
import { registerChoiceHandler, retireChoice, type ChoiceHandlerContext } from '../approvals/choices.js';
import { notifyAgent, requestApprovalOutcome, type RequestApprovalOptions } from '../approvals/primitive.js';
import {
  cardReleaseScopeJson,
  parseReleaseShipScope,
  RELEASE_OPTIONS,
  warningOptions,
  type ReleaseShipScope,
  unscopedReleaseCard,
} from '../approvals/release-ship-scope.js';
import { hasAdminPrivilege } from '../permissions/db/user-roles.js';
import { getUser } from '../permissions/db/users.js';

export const REQUEST_CHOICE_ACTION = 'request_choice';
const MAX_CHOICE_OPTIONS = 10;
const MAX_CHOICE_APPROVERS = 20;
export const SUPERSEDED_LINE = '↩️ Superseded by a newer ask';
const OUT_OF_DATE_LINE =
  '⚠️ Closed: this release card is out of date and cannot approve anything. Ask for a fresh card.';
/** The host-only event tag on a relayed answer (notifyAgent); the agent acts on nothing else. */
const CHOICE_RESPONSE_EVENT = 'choice_response';
const ID_RE = /^[A-Za-z0-9._:-]{1,128}$/;
const USER_ID_RE = /^[^:\s]+:\S+$/;
const OPTION_STYLES = new Set<unknown>(['primary', 'danger', 'default']);
const HEX_RUN_RE = /[0-9a-f]{40}/i;
const DISPLAY_SAFE_RE =
  /^[\x20-\x7E\u00A3\u00B0\u00C0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u2192\u20AC]*$/;
const VISIBLE_RE = /[A-Za-z0-9\u00C0-\u00FF]/;
const EVIDENCE_RE = /^https:\/\/[^\s<>|]+$/;

/**
 * What the approver reads. A `warning` card exists only because agents recommend
 * not shipping; its Ship button names the risk the clicker accepts. A `release`
 * card is a scheduled production release and lists its warnings, or says it has none.
 */
type ReleaseDecision = WarningDecision | ScheduledReleaseDecision;

interface WarningDecision {
  kind: 'warning';
  headline: string;
  asked: string;
  does: string[];
  diverges?: string;
  risk: string;
  undo: string;
  holdingCosts: string;
  recommend: string;
  reviewers?: string;
  evidence: string;
  accept: string;
}

interface ScheduledReleaseDecision {
  kind: 'release';
  headline: string;
  warnings: string[];
  does: string[];
  undo: string;
  reviewers?: string;
  evidence: string;
}

interface FieldRule {
  max: number;
  /** Lines rendered as bullets; absent means one line. */
  maxLines?: number;
  optional?: boolean;
}

const DECISION_FIELDS: Record<ReleaseDecision['kind'], Record<string, FieldRule>> = {
  warning: {
    headline: { max: 200 },
    asked: { max: 300 },
    does: { max: 700, maxLines: 6 },
    diverges: { max: 300, optional: true },
    risk: { max: 300 },
    undo: { max: 300 },
    holdingCosts: { max: 300 },
    recommend: { max: 300 },
    reviewers: { max: 300, optional: true },
    evidence: { max: 500 },
    accept: { max: 50 },
  },
  release: {
    headline: { max: 200 },
    warnings: { max: 700, maxLines: 6 },
    does: { max: 700, maxLines: 6 },
    undo: { max: 300 },
    reviewers: { max: 300, optional: true },
    evidence: { max: 500 },
  },
};
const SILENCE_LINE = 'Silence = nothing ships: it stays held until someone clicks.';
const AGENT_WORDS_LINE = 'Everything above is the requesting agent’s words, not checked by the host.';

interface ChoiceRequest {
  choiceId: string;
  title: string;
  question: string;
  options: Array<{ label: string; value: string; style?: OptionStyle }>;
  /** Replace-never-stack key: a newer ask under the same key retires this one. */
  key?: string;
  /** Namespaced user ids allowed to answer; each must hold admin privilege on the group. */
  approvers?: string[];
  /** Routing the container resolved `to` into. Container-written, so re-authorized here. */
  target?: { name: string; channelType: string; platformId: string };
  /** Host-owned release authorization meaning; display/options are canonicalized below. */
  approvalScope?: ReleaseShipScope;
}

/** The host's own validation: the outbound row is container-written. */
function parseChoiceRequest(content: Record<string, unknown>): ChoiceRequest | { error: string } {
  const { choiceId, title, question, options, key, approvers, to, channelType, platformId, approvalScope, decision } =
    content;
  if (typeof choiceId !== 'string' || !ID_RE.test(choiceId)) return { error: 'choiceId is missing or malformed' };
  const scope = approvalScope === undefined ? undefined : parseReleaseShipScope(approvalScope);
  if (approvalScope !== undefined && !scope) return { error: 'approvalScope is malformed' };
  if (decision !== undefined && !scope) return { error: 'decision belongs only on an approvalScope release card' };
  const brief = decision === undefined ? undefined : parseReleaseDecision(decision);
  if (typeof brief === 'string') return { error: brief };
  if (scope && !brief) return { error: 'a release card needs its decision: an approver must see what ships' };
  if (brief?.kind === 'warning' && !scope?.holds?.length) {
    return { error: 'a warning card needs approvalScope.holds: the exact hold codes its Go accepts' };
  }
  const canonical = scope && brief ? canonicalReleaseChoice(scope, brief) : undefined;
  const genericTitle = typeof title === 'string' && title.trim() ? title : undefined;
  const genericQuestion = typeof question === 'string' && question.trim() ? question : undefined;
  if (!canonical && !genericTitle) return { error: 'title is required' };
  if (!canonical && !genericQuestion) return { error: 'question is required' };
  const parsed: ChoiceRequest['options'] = canonical?.options ?? [];
  if (!canonical) {
    if (!Array.isArray(options) || options.length < 1 || options.length > MAX_CHOICE_OPTIONS) {
      return { error: `options must hold 1 to ${MAX_CHOICE_OPTIONS} entries` };
    }
    const seen = new Set<string>();
    for (const raw of options as unknown[]) {
      const { label, value, style } = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
      if (typeof label !== 'string' || !label.trim()) return { error: 'every option needs a non-empty label' };
      if (typeof value !== 'string' || !value) return { error: `option "${label}" needs a non-empty value` };
      if (seen.has(value)) return { error: `option values must be unique ("${value}" repeats)` };
      if (style !== undefined && !OPTION_STYLES.has(style)) return { error: `option "${label}" has an unknown style` };
      seen.add(value);
      parsed.push({ label, value, ...(style !== undefined ? { style: style as OptionStyle } : {}) });
    }
  }
  if (key !== undefined && (typeof key !== 'string' || !ID_RE.test(key))) {
    return { error: 'key must be 1-128 characters of letters, digits and . _ : -' };
  }
  if (
    approvers !== undefined &&
    (!Array.isArray(approvers) ||
      approvers.length < 1 ||
      approvers.length > MAX_CHOICE_APPROVERS ||
      !approvers.every((a) => typeof a === 'string' && USER_ID_RE.test(a)))
  ) {
    return {
      error: `approvers must hold 1 to ${MAX_CHOICE_APPROVERS} namespaced user ids (<channel>:<user id>)`,
    };
  }
  let target: ChoiceRequest['target'];
  if (to !== undefined || channelType !== undefined || platformId !== undefined) {
    if (typeof to !== 'string' || !to || typeof channelType !== 'string' || typeof platformId !== 'string') {
      return { error: 'a destination needs to, channelType and platformId' };
    }
    target = { name: to, channelType, platformId };
  }
  return {
    choiceId,
    title: canonical?.title ?? genericTitle!,
    question: canonical?.question ?? genericQuestion!,
    options: parsed,
    ...(key !== undefined ? { key } : {}),
    ...(approvers !== undefined ? { approvers: [...new Set(approvers as string[])] } : {}),
    ...(target ? { target } : {}),
    ...(scope ? { approvalScope: scope } : {}),
  };
}

function parseReleaseDecision(value: unknown): ReleaseDecision | string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return 'decision must be an object with kind "warning" or "release"';
  }
  const record = value as Record<string, unknown>;
  const kind = record.kind;
  if (kind !== 'warning' && kind !== 'release') return 'decision.kind must be "warning" or "release"';
  const rules = DECISION_FIELDS[kind];
  const extra = Object.keys(record).find((k) => k !== 'kind' && !(k in rules));
  if (extra !== undefined) return `a ${kind} decision takes only kind, ${Object.keys(rules).join(', ')} (not ${extra})`;
  const out: Record<string, unknown> = { kind };
  for (const [name, rule] of Object.entries(rules)) {
    const parsed = parseDecisionField(name, record[name], rule);
    if (typeof parsed === 'string') return parsed;
    if (parsed !== undefined) out[name] = parsed.value;
  }
  const evidence = out.evidence as string;
  if (!EVIDENCE_RE.test(evidence) || !URL.canParse(evidence)) return 'decision.evidence must be one https link';
  return out as unknown as ReleaseDecision;
}

function parseDecisionField(
  name: string,
  raw: unknown,
  rule: FieldRule,
): { value: string | string[] } | string | undefined {
  const text = typeof raw === 'string' ? raw.normalize('NFKC') : undefined;
  if (text === undefined || !VISIBLE_RE.test(text)) {
    if (rule.optional && (raw === undefined || (typeof raw === 'string' && !raw.trim()))) return undefined;
    return `decision.${name} is required`;
  }
  if (text.length > rule.max) return `decision.${name} is over ${rule.max} characters`;
  const lines = rule.maxLines
    ? text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [text.trim()];
  if (rule.maxLines && lines.length > rule.maxLines) return `decision.${name} has over ${rule.maxLines} lines`;
  if (!lines.every(isDisplaySafe)) {
    return 'decision text must be plain text: ASCII, accented Latin letters, and ‘ ’ “ ” – — • … → £ € °';
  }
  if (lines.some((t) => HEX_RUN_RE.test(t))) return 'decision text must not hold a commit SHA: the host pins the head';
  if (lines.some((t) => t.includes('](')))
    return 'decision text must not hold markdown links: put the link in evidence';
  if (lines.some((t) => t.includes('||'))) return 'decision text must not hold || (Discord hides text between bars)';
  if (name === 'evidence') return { value: lines[0] };
  return { value: rule.maxLines ? lines.map(neutralize) : neutralize(lines[0]) };
}

function isDisplaySafe(normalized: string): boolean {
  return DISPLAY_SAFE_RE.test(normalized);
}

function neutralize(text: string): string {
  return text.replace(/</g, '‹').replace(/>/g, '›').replace(/~/g, '∼');
}

function canonicalReleaseChoice(
  scope: ReleaseShipScope,
  brief: ReleaseDecision,
): Pick<ChoiceRequest, 'title' | 'question' | 'options'> {
  const pin = `Pinned to ${scope.repository}#${scope.pullRequest} from ${scope.base} at ${scope.headSha}.`;
  const accepts = scope.holds?.length
    ? ['Ship accepts only these holds, at this head:', ...scope.holds.map((code) => `• \`${code}\``)]
    : ['Ship accepts no holds: any hold keeps it held.'];
  const bullets = (lines: string[]) => lines.map((line) => `• ${line}`);
  const optional = (label: string, text: string | undefined) => (text ? [`${label}: ${text}`] : []);
  if (brief.kind === 'release') {
    return {
      title: `Release: ${scope.repository}#${scope.pullRequest}`,
      question: [
        brief.headline,
        SILENCE_LINE,
        '',
        'Warnings:',
        ...bullets(brief.warnings),
        'What goes to production:',
        ...bullets(brief.does),
        `Undo: ${brief.undo}`,
        ...optional('Reviewers', brief.reviewers),
        `Evidence: ${brief.evidence}`,
        '',
        AGENT_WORDS_LINE,
        ...accepts,
        pin,
      ].join('\n'),
      options: RELEASE_OPTIONS,
    };
  }
  return {
    title: `Held for your call: ${scope.repository}#${scope.pullRequest}`,
    question: [
      brief.headline,
      SILENCE_LINE,
      '',
      `You asked: ${brief.asked}`,
      'This does:',
      ...bullets(brief.does),
      ...optional('Diverges', brief.diverges),
      `Risk you’d accept: ${brief.risk}`,
      `Undo: ${brief.undo}`,
      `Holding costs: ${brief.holdingCosts}`,
      `Agents recommend: ${brief.recommend}`,
      ...optional('Reviewers', brief.reviewers),
      `Evidence: ${brief.evidence}`,
      '',
      AGENT_WORDS_LINE,
      ...accepts,
      pin,
    ].join('\n'),
    options: warningOptions(brief.accept),
  };
}

async function handleRequestChoice(content: Record<string, unknown>, session: Session): Promise<void> {
  const request = parseChoiceRequest(content);
  if ('error' in request) {
    await notifyAgent(session, `request_choice failed: ${request.error}`);
    return;
  }

  // Refuse a choiceId reuse while the earlier card is live, globally: two cards
  // answering to one id can show a clicker the wrong card's text. This read is
  // only the FAST PATH — two sessions can race past it; the partial unique
  // index on request_id is the guarantee ('duplicate-request' below).
  if (await getPendingApprovalByRequestId(request.choiceId)) {
    log.warn('request_choice refused: choiceId already has a pending approval', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      choiceId: request.choiceId,
    });
    await notifyAgent(session, duplicateChoiceRefusal(request.choiceId));
    return;
  }

  // Narrow, never widen: every named approver must already be allowed to answer.
  if (request.approvers) {
    const outsider = await withCentralSync(
      () => request.approvers!.find((userId) => !hasAdminPrivilege(userId, session.agent_group_id)),
      'request_choice approvers',
    );
    if (outsider !== undefined) {
      await notifyAgent(
        session,
        `request_choice failed: approver "${outsider}" is not an owner or admin of this agent group.`,
      );
      return;
    }
  }

  let conversation: RequestApprovalOptions['conversation'];
  if (request.target) {
    const mg = await authorizedDestination(session, request.target.channelType, request.target.platformId);
    if (!mg) {
      log.warn('request_choice refused: not one of the agent group’s destinations', {
        sessionId: session.id,
        agentGroupId: session.agent_group_id,
        channelType: request.target.channelType,
        platformId: request.target.platformId,
      });
      await notifyAgent(session, `request_choice failed: "${request.target.name}" is not one of your destinations.`);
      return;
    }
    // Top-level in the destination: the card is the ask, and replies thread under it.
    conversation = { channelType: mg.channel_type, platformId: mg.platform_id, threadId: null, instance: mg.instance };
  }

  if (request.approvalScope) {
    const channelType =
      conversation?.channelType ??
      (session.messaging_group_id ? (await getMessagingGroup(session.messaging_group_id))?.channel_type : undefined);
    const over = cardOverrun(channelType, request.title, request.question);
    if (over > 0) {
      await notifyAgent(
        session,
        `request_choice failed: decision is too long for one card: shorten it by ${over} characters`,
      );
      return;
    }
  }

  const options: RawOption[] = request.options.map((o) => ({
    label: o.label,
    value: o.value,
    ...(o.style ? { style: o.style } : {}),
  }));
  // A lost reservation is not notified by requestApprovalOutcome, so it gets the fast path's refusal here.
  const outcome = await requestApprovalOutcome({
    session,
    agentName: session.agent_group_id,
    action: REQUEST_CHOICE_ACTION,
    requestId: request.choiceId,
    payload: {
      choiceId: request.choiceId,
      ...(request.key !== undefined ? { key: request.key } : {}),
      ...(request.approvers ? { approvers: request.approvers } : {}),
      ...(request.approvalScope ? { approvalScope: request.approvalScope } : {}),
    },
    title: request.title,
    question: request.question,
    deliveryTarget: 'thread',
    conversation,
    options,
  });

  if (outcome === 'duplicate-request') {
    log.warn('request_choice refused: choiceId lost the reservation to a concurrent ask', {
      sessionId: session.id,
      agentGroupId: session.agent_group_id,
      choiceId: request.choiceId,
    });
    await notifyAgent(session, duplicateChoiceRefusal(request.choiceId));
    return;
  }

  // Post first, then retire: an ask that failed to post leaves the old card live.
  if (outcome === 'posted' && request.key !== undefined) {
    const own = await getPendingApprovalByRequestId(request.choiceId);
    // Gone already means a newer same-key ask retired it: nothing older to retire.
    if (own) await supersedeOpenChoices(session.agent_group_id, request.key, own);
  }
}

function duplicateChoiceRefusal(choiceId: string): string {
  return `request_choice failed: choiceId "${choiceId}" already has a pending answer.`;
}

/**
 * The messaging group a container-resolved destination names, if this agent
 * group may post there — the same check delivery.ts gives an ordinary outbound message.
 */
async function authorizedDestination(
  session: Session,
  channelType: string,
  platformId: string,
): Promise<MessagingGroup | undefined> {
  const originMg = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  const mg =
    originMg && originMg.channel_type === channelType && originMg.platform_id === platformId
      ? originMg
      : await getMessagingGroupByPlatform(channelType, platformId);
  if (!mg) return undefined;
  if (session.messaging_group_id === mg.id || !(await hasTable(getDb(), 'agent_destinations'))) return mg;
  const row = await getDb().get(
    'SELECT 1 FROM agent_destinations WHERE agent_group_id = ? AND target_type = ? AND target_id = ? LIMIT 1',
    session.agent_group_id,
    'channel',
    mg.id,
  );
  return row ? mg : undefined;
}

/**
 * Replace, never stack: retire only cards under `key` created BEFORE `newest`.
 * Two same-key asks can be handled concurrently, and "everything but my own
 * row" would let each retire the other, leaving no card open.
 */
async function supersedeOpenChoices(agentGroupId: string, key: string, newest: PendingApproval): Promise<void> {
  for (const row of await getPendingApprovalsByAction(REQUEST_CHOICE_ACTION)) {
    if (row.status !== 'pending' || row.agent_group_id !== agentGroupId || !createdBefore(row, newest)) continue;
    if (payloadKey(row) !== key) continue;
    if (await retireChoice(row, SUPERSEDED_LINE)) {
      log.info('Choice superseded by a newer ask', { approvalId: row.approval_id, agentGroupId, key });
    }
  }
}

/** Strictly earlier: created_at (ISO, so string order is time order), then approval_id to break a tie. */
function createdBefore(row: PendingApproval, newest: PendingApproval): boolean {
  if (row.created_at !== newest.created_at) return row.created_at < newest.created_at;
  return row.approval_id < newest.approval_id;
}

function payloadKey(row: PendingApproval): string | undefined {
  try {
    const key = (JSON.parse(row.payload) as { key?: unknown }).key;
    return typeof key === 'string' ? key : undefined;
    // eslint-disable-next-line no-catch-all/no-catch-all -- a corrupt payload has no key to match
  } catch {
    return undefined;
  }
}

/**
 * The session a typed reply in the card's thread would reach, resolved as the
 * router does (creating it when absent). Undefined when the card's channel is
 * not wired to the agent group; the caller then falls back to the requester.
 */
async function cardConversationSession(
  approval: PendingApproval,
  requester: Session | undefined,
): Promise<Session | undefined> {
  const agentGroupId = approval.agent_group_id ?? requester?.agent_group_id;
  if (!agentGroupId || !approval.channel_type || !approval.platform_id) return undefined;
  const originMg = requester?.messaging_group_id ? await getMessagingGroup(requester.messaging_group_id) : undefined;
  const mg =
    originMg && originMg.channel_type === approval.channel_type && originMg.platform_id === approval.platform_id
      ? originMg
      : await getMessagingGroupByPlatform(approval.channel_type, approval.platform_id, approval.instance ?? undefined);
  if (!mg) return undefined;
  const wiring = await getMessagingGroupAgentByPair(mg.id, agentGroupId);
  if (!wiring) return undefined;

  const adapterKey = mg.instance ?? mg.channel_type;
  const threadsEnabled = resolveThreadPolicy(
    wiring.threads ?? null,
    getChannelDefaults(adapterKey, mg.channel_type),
    mg.is_group === 1,
    getChannelAdapter(adapterKey)?.supportsThreads === true,
  );
  let sessionMode = wiring.session_mode;
  if (threadsEnabled && sessionMode !== 'agent-shared' && mg.is_group !== 0) sessionMode = 'per-thread';
  const threadId = threadsEnabled ? (approval.thread_id ?? replyThreadId(mg, approval.platform_message_id)) : null;
  const { session } = await resolveSession(agentGroupId, mg.id, threadId, sessionMode);
  return session;
}

/**
 * Slack only: a thread id is `slack:<channel>:<ts>`, the messaging group stores
 * `slack:<channel>`, and a card's platform_message_id is its Slack ts.
 * Elsewhere: null, where a channel-root reply lands.
 */
function replyThreadId(mg: MessagingGroup, messageId: string | null): string | null {
  // Same predicate as isSlackChannelType in router.ts; router.ts imports module code, so not imported here.
  const slack = mg.channel_type === 'slack' || isChannelVariant(mg.channel_type, 'slack');
  if (!messageId || !slack || !mg.platform_id.startsWith('slack:')) return null;
  return `${mg.platform_id}:${messageId}`;
}

const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * The line the agent receives. Fixed key order, every value percent-encoded,
 * so it stays one line and survives the runner's XML escaping unchanged; lone
 * surrogates (which encodeURIComponent throws on) become U+FFFD. Anyone can type
 * this line, so the agent trusts it only inside a message marked origin="host"
 * AND event="choice_response". `approval_id` is the unique key `choice_receipts`
 * uses; `choice_id` is agent-chosen.
 */
export function formatChoiceResponse(fields: {
  choiceId: string;
  approvalId: string;
  value: string;
  label: string;
  userId: string;
  userName: string | null;
  /** Host-validated canonical JSON for a release_ship card; omitted for generic cards. */
  releaseScope?: string;
}): string {
  const pairs: Array<[string, string]> = [
    ['choice_id', fields.choiceId],
    ['approval_id', fields.approvalId],
    ['value', fields.value],
    ['label', fields.label],
    ['user_id', fields.userId],
    ['user_name', fields.userName ?? ''],
  ];
  // Keep the generic response byte-for-byte compatible for existing parsers.
  if (fields.releaseScope !== undefined) pairs.push(['release_scope', fields.releaseScope]);
  const encode = (v: string): string => encodeURIComponent(v.replace(LONE_SURROGATE_RE, '�'));
  return ['choice_response', ...pairs.map(([k, v]) => `${k}=${encode(v)}`)].join(' ');
}

async function relayChoice(ctx: ChoiceHandlerContext): Promise<Session | null> {
  const target = (await cardConversationSession(ctx.approval, ctx.requester)) ?? ctx.requester;
  if (!target) return null;
  // The click carries no display name, so it comes from the clicker's users row.
  const user = await getUser(ctx.userId);
  const id = `choice-answer-${ctx.approval.approval_id}`;
  try {
    await notifyAgent(
      target,
      formatChoiceResponse({
        choiceId: ctx.approval.request_id,
        approvalId: ctx.approval.approval_id,
        value: ctx.value,
        label: ctx.label,
        userId: ctx.userId,
        userName: user?.display_name ?? null,
        releaseScope: cardReleaseScopeJson(ctx.approval),
      }),
      { id, event: CHOICE_RESPONSE_EVENT },
    );
  } catch (err) {
    // A failure after notifyAgent's insert leaves a due row the sweep will
    // wake, so the answer is delivered; only an unrecorded one may reopen the card.
    if (await sessionMessageExists(target.agent_group_id, target.id, id)) {
      log.warn('Choice answer recorded but the wake failed — the sweep will wake the session', {
        approvalId: ctx.approval.approval_id,
        sessionId: target.id,
        err,
      });
      return target;
    }
    throw err;
  }
  return target;
}

registerDeliveryAction(
  REQUEST_CHOICE_ACTION,
  handleRequestChoice,
  unguarded(
    "posts a card into the session's own conversation or an agent_destinations channel re-checked here, as a chat message would; who may answer is enforced at click time (admin privilege, approvals/choices.ts)",
  ),
);
registerChoiceHandler(REQUEST_CHOICE_ACTION, relayChoice);

export async function retireUnscopedReleaseCards(): Promise<void> {
  for (const row of await getPendingApprovalsByAction(REQUEST_CHOICE_ACTION)) {
    if (row.status !== 'pending' || !unscopedReleaseCard(row)) continue;
    if (await retireChoice(row, OUT_OF_DATE_LINE)) {
      log.info('Out-of-date release card closed', { approvalId: row.approval_id, agentGroupId: row.agent_group_id });
    }
  }
}

onHostStart(function outOfDateReleaseCardsHostStart() {
  void retireUnscopedReleaseCards().catch((err: unknown) => {
    log.error('Closing out-of-date release cards failed', { err });
  });
});
