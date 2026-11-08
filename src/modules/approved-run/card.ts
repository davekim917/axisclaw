import { PLATFORM_TEXT_MAX } from '../approvals/card-budget.js';
import { APPROVAL_RESOLUTION_MAX_UNITS } from '../approvals/primitive.js';
import { sha256, type Classification } from './classify.js';
import type { RunResult } from './execute.js';
import type { SourceLink } from './snowflake-source.js';
import type { SnowflakeTarget } from './targets.js';

export const RUN_VALUE = 'run';
const DECLINE_VALUE = 'decline';
export const CARD_OPTIONS = [
  { label: 'Run it', value: RUN_VALUE, style: 'danger' as const },
  { label: 'Don’t run', value: DECLINE_VALUE, style: 'primary' as const },
];

const TITLE_MAX = 140;

/** The card body that fits every platform it lands on, beside its title and the resolution line added on answer. */
export function questionBudget(platforms: readonly string[]): number {
  const smallest = Math.min(...platforms.map((p) => PLATFORM_TEXT_MAX[p] ?? PLATFORM_TEXT_MAX.discord));
  return smallest - TITLE_MAX - 4 - APPROVAL_RESOLUTION_MAX_UNITS;
}

export const QUESTION_MAX = questionBudget(['discord']);
const NAMES_SHOWN = 4;
const NAME_MAX = 40;
/** Text a reader would not see as written: a code fence that ends the block early, or invisible and bidi controls. */
export const UNSHOWABLE =
  // eslint-disable-next-line no-control-regex -- matching control characters is the point
  /```|[\u0000-\u0008\u000B-\u001F\u007F\u00AD\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/;

function count(c: Classification, kinds: string[]): number {
  return c.statements.filter((s) => kinds.includes(s.kind)).length;
}

/** Every name list on the card goes through here, so no list can outgrow the budget. */
export function listOf(items: Array<string | null | undefined>, code = true, joiner = ', '): string {
  const all = [...new Set(items.filter((n): n is string => Boolean(n)))];
  const shown = all
    .slice(0, NAMES_SHOWN)
    .map((n) => (n.length > NAME_MAX ? `${n.slice(0, NAME_MAX - 1)}…` : n))
    .map((n) => (code ? `\`${n}\`` : n));
  return all.length > NAMES_SHOWN ? `${shown.join(', ')} and ${all.length - NAMES_SHOWN} more` : shown.join(joiner);
}

function names(c: Classification, kinds: string[], field: 'grantee' | 'object'): string {
  return listOf(c.statements.filter((s) => kinds.includes(s.kind)).map((s) => s[field]));
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

type Statement = Classification['statements'][number];

function onCard(c: Classification): Statement[] {
  return c.statements.filter((s) => s.tier === 'card');
}

function deletingMerges(c: Classification): Statement[] {
  return onCard(c).filter((s) => s.kind === 'merge' && s.actions?.includes('DELETE'));
}

function plainSentence(target: SnowflakeTarget, c: Classification): string {
  const access = count(c, ['grant', 'revoke', 'ownership']);
  const creates = count(c, ['create_role', 'create_user', 'create_warehouse', 'create_database', 'create_object']);
  const managed = count(c, ['alter']);
  const tables = count(c, ['create_table']);
  const views = count(c, ['create_view']);
  const dynamic = count(c, ['create_dynamic_table']);
  const merges = new Set(c.statements.filter((s) => s.kind === 'merge').map((s) => s.object)).size;
  const reads = count(c, ['select']);
  const parts: string[] = [];
  if (access) parts.push(`changes who can do what (${plural(access, 'grant')} or ownership moves)`);
  if (creates) parts.push(`creates ${plural(creates, 'object')}`);
  if (managed) parts.push(`switches ${plural(managed, 'schema')} to managed access`);
  if (tables) parts.push(`creates ${plural(tables, 'table')}`);
  if (views) parts.push(`creates or replaces ${plural(views, 'view')}`);
  if (dynamic) parts.push(`creates or replaces ${plural(dynamic, 'dynamic table')}`);
  if (merges) parts.push(`writes rows into ${plural(merges, 'table')} with MERGE`);
  if (reads) parts.push(`runs ${reads} read-only ${reads === 1 ? 'query' : 'queries'}`);
  if (parts.length === 0) parts.push(`reads metadata in ${plural(count(c, ['read_metadata']), 'statement')}`);
  const deletes = deletingMerges(c).length;
  const replaced = onCard(c).filter((s) => s.replaces).length;
  const ownership = count(c, ['ownership']);
  const dropped = c.statements.filter((s) => s.tier === 'card' && s.dropsGrants).length;
  const caveats = [
    ownership ? 'an ownership move can be undone only by the new owner or a role with MANAGE GRANTS' : '',
    dropped
      ? `${dropped === 1 ? 'one ownership move drops' : `${dropped} ownership moves drop`} the object's existing grants, which only re-granting by hand restores`
      : '',
    replaced
      ? `${replaced === 1 ? 'one statement replaces' : `${replaced} statements replace`} any existing view or dynamic table of the same name`
      : '',
  ].filter(Boolean);
  const deleted = deletes
    ? `${deletes === 1 ? 'one MERGE deletes' : `${deletes} MERGEs delete`} the rows its WHEN … THEN DELETE matches`
    : 'nothing is deleted';
  return `In ${target.label}, this ${parts.join(', ')}; ${deleted}${caveats.length ? `, but ${caveats.join(', and ')}` : ''}.`;
}

type Add = (n: number, text: string, kinds: string[], field: 'grantee' | 'object', joiner: string) => void;

/** What the data statements create and write; a by-reference entry already carries all of it, so that mode omits it. */
function dataLines(c: Classification, withNames: boolean, lines: string[], add: Add): void {
  for (const [kind, label] of [
    ['create_table', 'New tables'],
    ['create_view', 'Views created or replaced'],
    ['create_dynamic_table', 'Dynamic tables created or replaced'],
  ] as const) {
    add(count(c, [kind]), label, [kind], 'object', ': ');
  }
  const replaced = onCard(c).filter((s) => s.replaces);
  if (replaced.length) {
    const list = withNames ? `: ${listOf(replaced.map((s) => s.object))}` : '';
    lines.push(`• OR REPLACE, rebuilding any existing one: ${replaced.length}${list}`);
  }
  for (const s of onCard(c).filter((m) => m.kind === 'merge')) {
    const reads = s.sources?.length ? `; reads ${listOf(s.sources)}` : '';
    lines.push(`• MERGE into ${listOf([s.object])}: ${(s.actions ?? []).join(', ')}${reads}`);
  }
  add(count(c, ['select']), 'Read-only queries', ['select'], 'object', ': ');
}

/** Every hazard line always appears; under a tight budget only the names after its count are dropped. */
function summaryLines(c: Classification, withNames: boolean, reference: boolean): string[] {
  const lines: string[] = [];
  const add: Add = (n, text, kinds, field, joiner) => {
    if (n === 0) return;
    const list = withNames ? names(c, kinds, field) : '';
    lines.push(`• ${text}: ${n}${list ? `${joiner}${list}` : ''}`);
  };
  add(count(c, ['grant']), 'Grants', ['grant'], 'grantee', ', to ');
  add(count(c, ['revoke']), 'Revokes', ['revoke'], 'grantee', ', from ');
  add(count(c, ['ownership']), 'Ownership moves', ['ownership'], 'grantee', ', to ');
  for (const [kind, label] of [
    ['create_role', 'New roles'],
    ['create_user', 'New users'],
    ['create_warehouse', 'New warehouses'],
    ['create_database', 'New databases'],
    ['create_object', 'New schemas, database roles, stages or file formats'],
    ['alter', 'Schemas switched to managed access'],
  ] as const) {
    add(count(c, [kind]), label, [kind], 'object', ': ');
  }
  if (!reference) dataLines(c, withNames, lines, add);
  const lifted = c.statements.filter(
    (s) => s.tier === 'card' && s.kind === 'grant' && s.granted && s.granteeKind === 'role',
  );
  if (lifted.length) {
    const grantees = withNames ? `: ${listOf(lifted.map((s) => s.grantee))}` : '';
    lines.push(
      `• Role-to-role grants: ${lifted.length}. Each grantee may sit under other roles, and what it gains flows up to all of them${grantees}`,
    );
  }
  const roles = listOf(c.statements.map((s) => s.role));
  if (roles) lines.push(`• Runs as roles: ${roles}`);
  return lines;
}

function contextLine(s: Classification['statements'][number]): string {
  const role = `role ${s.role ?? '?'}`;
  const where = !s.database
    ? s.schema
      ? `default database, schema ${s.schema}`
      : 'default database'
    : s.schema
      ? `in ${s.database}.${s.schema}`
      : `in ${s.database}, default schema`;
  return `▸ ${role} · ${where}`;
}

const KIND_LABELS: Record<string, string> = {
  create_table: 'CREATE TABLE',
  create_view: 'CREATE VIEW',
  create_dynamic_table: 'CREATE DYNAMIC TABLE',
  merge: 'MERGE INTO',
  select: 'SELECT',
};
const FIRST_LINE_MAX = 80;

function inFull(s: Statement): string {
  const cuts = (s.collapsed ?? []).map(
    (v) =>
      `▸ VALUES list: ${v.rows} rows, first and last 3 shown · sha256 \`${v.sha256.slice(0, 12)}\` · every row at the source link`,
  );
  return [(s.display ?? s.text).trim(), ...cuts].join('\n');
}

/** A first line that says only the kind and object (plus IF NOT EXISTS, OR REPLACE, an alias or an opening paren). */
function restatesHead(first: string, s: Statement): boolean {
  if (!s.object) return false;
  const line = first
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(/ OR REPLACE\b/, '')
    .replace(/ IF NOT EXISTS\b/, '');
  const head = `${KIND_LABELS[s.kind]} ${s.object}`;
  return line.startsWith(head) && /^( ?\(| [A-Z_][A-Z0-9_]{0,29})?$/.test(line.slice(head.length));
}

/** A data statement as one entry: what it is, what it writes, how it starts, and its own hash to match at the link. */
function byReference(s: Statement): string {
  const lines = s.text.trim().split('\n');
  const first = (lines.find((l) => l.trim() && !l.trim().startsWith('--')) ?? lines[0]).trim();
  const head = `${KIND_LABELS[s.kind]}${s.object ? ` ${s.object}` : ''}${s.replaces ? ' (OR REPLACE)' : ''} · sha256 \`${sha256(s.text).slice(0, 12)}\``;
  return [
    head,
    ...(restatesHead(first, s)
      ? []
      : [`  ${first.length > FIRST_LINE_MAX ? `${first.slice(0, FIRST_LINE_MAX - 1)}…` : first}`]),
    ...(s.actions ? [`  WHEN: ${s.actions.join(', ')}`] : []),
    ...(s.sources?.length ? [`  READS: ${listOf(s.sources, false)}`] : []),
  ].join('\n');
}

function cardStatements(c: Classification, reference: boolean): string {
  const card = onCard(c);
  if (card.some((s) => UNSHOWABLE.test(s.text) || UNSHOWABLE.test(s.display ?? ''))) {
    throw new Error('a statement holds text a card cannot show as written (``` or an invisible character); remove it');
  }
  let context = '';
  const shown = card.map((s) => {
    const body = reference && s.kind in KIND_LABELS ? byReference(s) : inFull(s);
    const line = contextLine(s);
    if (line === context) return body;
    context = line;
    return `${line}\n${body}`;
  });
  return '```\n' + shown.join('\n\n') + '\n```';
}

export function cardTitle(target: { label: string }, reason: string): string {
  const title = `🗝️ ${target.label}: ${reason.replace(/\s+/g, ' ').trim()}`;
  return title.length <= TITLE_MAX ? title : `${title.slice(0, TITLE_MAX - 1).trimEnd()}…`;
}

function needsSource(target: SnowflakeTarget, why: string): Error {
  const where = target.repo
    ? `merged to develop or main in ${target.repo}`
    : 'merged to a repository this target names';
  return new Error(
    `${why}, so the card must link the file: propose it again with source { commit, path } for the file ${where}, or split it`,
  );
}

export function cardQuestion(
  target: SnowflakeTarget,
  c: Classification,
  fileSha: string,
  approverNames: string[],
  source: SourceLink | null,
  budget: number,
): string {
  const statements = c.statements.filter((s) => s.tier !== 'none').length;
  const returned = [count(c, ['read_metadata']) ? 'SHOW' : '', count(c, ['select']) ? 'SELECT' : ''].filter(Boolean);
  const onApproval = `the host runs it now as \`${target.execute.user}\`, one statement at a time, stopping at the first failure${returned.length ? `; what ${returned.join(' and ')} return${returned.length === 1 ? 's' : ''} goes to the agent` : ''}`;
  const meta = `${plural(statements, 'statement')} · sha256 \`${fileSha.slice(0, 12)}\` · on approval: ${onApproval}`;
  const link = source ? `Source (on ${source.branch}, same bytes): ${source.url}` : '';
  const foot = `_Only ${listOf(approverNames, false, ' or ')} can answer. Silence runs nothing._`;
  const referenced = onCard(c).filter((s) => s.kind in KIND_LABELS).length;
  const build = (withNames: boolean, reference: boolean) =>
    [
      reference ? `${plural(referenced, 'statement')} shown by reference; read them at the link.` : '',
      plainSentence(target, c),
      summaryLines(c, withNames, reference).join('\n'),
      meta,
      link,
      cardStatements(c, reference),
      foot,
    ]
      .filter(Boolean)
      .join('\n\n');
  const fits = (q: string) => q.length <= budget;
  let question = [build(true, false), build(false, false)].find(fits);
  if (!question && referenced && source) question = [build(true, true), build(false, true)].find(fits);
  if (!question) {
    if (referenced && !source)
      throw needsSource(target, 'the statements that need approval are too long to show in full on one card');
    throw new Error(
      'the statements that need approval are too long to show in full on one card; split the file into smaller proposals',
    );
  }
  if (!source && onCard(c).some((s) => s.collapsed)) throw needsSource(target, 'a long VALUES list is shown cut');
  return question;
}

const REPORT_LINES = 20;
const PREVIEW_MAX = 80;

function preview(text: string): string {
  const one = text.replace(/\s+/g, ' ').trim();
  return one.length > PREVIEW_MAX ? `${one.slice(0, PREVIEW_MAX - 1)}…` : one;
}

/** `ran` steps committed out of `total`, as a reader would say it. */
export function ranPhrase(ran: number, total: number): string {
  if (ran === 0) return `none of ${total === 1 ? 'its one step' : `its ${total} steps`} completed`;
  if (ran === total)
    return total === 1 ? 'its one step ran and is committed' : `all ${total} steps ran and are committed`;
  if (ran === 1) return `step 1 of ${total} ran and is committed`;
  return `steps 1–${ran} of ${total} ran and are committed`;
}

export function runReport(
  target: SnowflakeTarget,
  runId: string,
  fileSha: string,
  approvedBy: string | null,
  result: RunResult,
): string {
  const head = `Approved by ${approvedBy ?? 'a named approver'}. ${target.label} run \`${runId}\` (sha256 \`${fileSha.slice(0, 12)}\`)`;
  if (result.kind !== 'done') return `${head}: nothing ran. ${result.detail}`;
  const ran = result.steps.filter((s) => s.outcome.status === 'ok').length;
  const stopped = result.steps.find((s) => s.outcome.status !== 'ok');
  const lines = result.steps.map((s, i) => {
    const mark = s.outcome.status === 'ok' ? '✓' : s.outcome.status === 'failed' ? '✗' : '?';
    return `${mark} ${i + 1}. \`${preview(s.text)}\` as ${s.role}`;
  });
  const shown =
    lines.length > REPORT_LINES
      ? [...lines.slice(0, REPORT_LINES), `… and ${lines.length - REPORT_LINES} more`]
      : lines;
  let tail = '';
  if (stopped && stopped.outcome.status !== 'ok') {
    const n = result.steps.indexOf(stopped) + 1;
    tail =
      stopped.outcome.status === 'failed'
        ? `\nStep ${n} failed: ${stopped.outcome.detail}. Nothing after it ran.`
        : `\nStep ${n}: outcome unknown (${stopped.outcome.detail}). Check Snowflake query history for query tag \`approved-run ${runId} step ${n}\`. Nothing after it ran.`;
    if (n < result.total) tail += ` A retry is a new proposal for steps ${n}–${result.total}.`;
  }
  return `${head} as \`${target.execute.user}\`: ${ranPhrase(ran, result.total)}.\n${shown.join('\n')}${tail}`;
}

/** What read-only steps returned, for the agent only; the thread gets the outcome. */
export function rowsForAgent(result: RunResult): string {
  if (result.kind !== 'done') return '';
  const parts = result.steps.flatMap((s, i) =>
    s.outcome.status === 'ok' && s.outcome.rows && s.outcome.rows.length
      ? [
          `Step ${i + 1} returned (first ${s.outcome.rows.length} rows): ${JSON.stringify(s.outcome.rows).slice(0, 4000)}`,
        ]
      : [],
  );
  return parts.length ? `\n\n${parts.join('\n')}` : '';
}
