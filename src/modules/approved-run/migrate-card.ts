import path from 'node:path';

import { QUESTION_MAX, UNSHOWABLE, listOf } from './card.js';
import { changedFiles, type Baseline } from './migrate-drift.js';
import type { FileOutcome, MigrateRunResult } from './migrate-execute.js';
import type { MigrateClassification, MigrationEntry, MigrationProposal } from './migrate-request.js';
import type { MigrateTarget } from './targets.js';

const STATEMENT_MAX = 60;
const STATEMENTS_SHOWN = 3;
const THREAD_OUTPUT_LINES = 3;

/** Text from the repository, made safe for a card: no fences, invisible characters, mentions or links. */
function repoText(text: string, max: number): string {
  const one = text
    .replace(new RegExp(UNSHOWABLE.source, 'g'), ' ')
    .replace(/[`<>|[\]]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

const github = (target: MigrateTarget) => `https://github.com/${target.repo}`;
const applyName = (target: MigrateTarget) => path.posix.basename(target.layout.applyScript);

function driftLine(
  target: MigrateTarget,
  p: MigrationProposal,
  c: MigrateClassification,
  last: Baseline | null,
): string {
  if (!last) {
    return `⚠️ No earlier approved run to compare ${applyName(target)} and its imports with. They run with the database password: [read them at this commit](${github(target)}/tree/${p.commit}/${path.posix.dirname(target.layout.applyScript)}).`;
  }
  const changed = changedFiles(last, c.executor ?? {});
  const short = last.commit.slice(0, 12);
  if (!last.from) {
    if (changed.length === 0) return '';
    const names = changed.map((f) => f.split('/').pop() as string);
    return `⚠️ ${listOf(names)} changed since the last approved run (\`${short}\`). They run with the database password: [compare](${github(target)}/compare/${last.commit}...${p.commit}).`;
  }
  // Another target's run may sit on another branch, where a three-dot compare (from the merge base) can show nothing.
  const run = `the last approved run on \`${last.from}\` (\`${short}\`); this target has none of its own`;
  const diff = `${github(target)}/compare/${last.commit}..${p.commit}`;
  if (changed.length === 0) {
    return `${applyName(target)} and its imports match ${run}. They run with the database password: [read them at this commit](${github(target)}/tree/${p.commit}/${path.posix.dirname(target.layout.applyScript)}).`;
  }
  const names = changed.map((f) => f.split('/').pop() as string);
  return `⚠️ ${listOf(names)} changed relative to ${run}. They run with the database password: [compare](${diff}).`;
}

function fileLines(target: MigrateTarget, c: MigrateClassification, whyMax: number): string {
  const p = c.proposal as MigrationProposal;
  return p.files
    .map((f, i) => {
      const checked = c.checked?.[i];
      const facts = checked?.facts;
      const notes = [
        ...(facts?.classes ?? []).map((k) => `**${repoText(k.name, 40).toUpperCase()}**: ${repoText(k.why, whyMax)}`),
        ...(facts?.irreversible.length
          ? [
              `**irreversible**: ${facts.irreversible
                .slice(0, STATEMENTS_SHOWN)
                .map((s) => `\`${repoText(s, STATEMENT_MAX)}\``)
                .join(
                  ', ',
                )}${facts.irreversible.length > STATEMENTS_SHOWN ? ` +${facts.irreversible.length - STATEMENTS_SHOWN}` : ''}`,
            ]
          : []),
      ];
      const head = `${i + 1}. \`${f.database}\` [${f.migration}.sql](${github(target)}/blob/${p.commit}/${checked?.path}) · sha256 \`${f.sha256.slice(0, 12)}\``;
      return notes.length ? `${head}\n   ${notes.join('\n   ')}` : head;
    })
    .join('\n');
}

export function migrateCardQuestion(
  target: MigrateTarget,
  c: MigrateClassification,
  approverNames: string[],
  last: Baseline | null,
): string {
  const p = c.proposal as MigrationProposal;
  const many = p.files.length > 1;
  const sentence = many
    ? `Applies these ${p.files.length} migrations in this order. Each file is its own transaction, with its ledger row: if one fails, the files before it stay applied and the ones after it don't run. Undoing a file takes a new migration.`
    : `Applies this migration. It and its ledger row commit in one transaction, so it lands whole or not at all; undoing it takes a new migration.`;
  const meta = `commit \`${p.commit.slice(0, 12)}\` (on ${c.branch}) · [Go](${p.goLink})`;
  const identities = listOf([...new Set(p.files.map((f) => target.execute.agents[f.database].onecliAgent))]);
  const onApproval = `On approval: the host runs this commit's ${applyName(target)} in a sandbox, once per file, as ${identities}; one run per database at a time.`;
  const foot = `_Only ${listOf(approverNames, false, ' or ')} can answer. Silence runs nothing._`;
  const build = (whyMax: number) =>
    [sentence, fileLines(target, c, whyMax), driftLine(target, p, c, last), meta, onApproval, foot]
      .filter(Boolean)
      .join('\n\n');
  for (const whyMax of [300, 160, 80]) {
    const question = build(whyMax);
    if (question.length <= QUESTION_MAX) return question;
  }
  throw new Error('these migrations do not fit on one card; propose them as smaller lists');
}

function lastLines(output: string, n: number): string {
  return output.trim().split('\n').filter(Boolean).slice(-n).join('\n').replace(/```/g, "'''");
}

const MARK: Record<FileOutcome['status'], string> = { ok: '✓', failed: '✗', unknown: '?' };

function outcomeWords(o: FileOutcome): string {
  if (o.status === 'ok') return 'applied, with its ledger row';
  if (o.status === 'unknown') return `outcome unknown (${o.detail})`;
  return 'not applied: the apply script stopped before sending it';
}

export function migrateRunReport(
  target: MigrateTarget,
  runId: string,
  p: MigrationProposal,
  approvedBy: string | null,
  result: MigrateRunResult,
): string {
  const head = `Approved by ${approvedBy ?? 'a named approver'}. ${target.label} run \`${runId}\``;
  if (result.kind === 'refused') return `${head}: nothing ran. ${result.detail}`;
  const lines = p.files.map((f, i) => {
    const step = result.steps[i];
    const where = `${i + 1}. \`${f.migration}\` on \`${f.database}\``;
    return step ? `${MARK[step.outcome.status]} ${where}: ${outcomeWords(step.outcome)}` : `– ${where}: not run`;
  });
  const last = result.steps[result.steps.length - 1];
  const applied = result.steps.filter((s) => s.outcome.status === 'ok').length;
  let next = '';
  if (last && last.outcome.status !== 'ok') {
    const remaining = p.files.slice(result.steps.length - 1).map((f) => f.migration);
    next =
      last.outcome.status === 'unknown'
        ? `\nCheck the ledger for \`${last.file.migration}\` before anything else; a retry is a new proposal for ${listOf(remaining)}.`
        : `\nFix \`${last.file.migration}\`, then propose ${listOf(remaining)} again.`;
    if (last.outcome.output.trim()) next += `\n\`\`\`\n${lastLines(last.outcome.output, THREAD_OUTPUT_LINES)}\n\`\`\``;
  }
  return `${head}: ${applied} of ${p.files.length} applied.\n${lines.join('\n')}${next}`;
}

/** The apply script's whole output for each file that ran, already redacted, for the agent only. */
export function migrateOutputForAgent(result: MigrateRunResult): string {
  if (result.kind !== 'done') return '';
  const parts = result.steps
    .filter((s) => s.outcome.output.trim())
    .map((s) => `Apply script output for ${s.file.migration}:\n${s.outcome.output}`);
  return parts.length ? `\n\n${parts.join('\n\n')}` : '';
}

/** The account of a run a dead host cut off, file by file, from its step log. */
export function migrateInterruptedText(
  lead: string,
  runId: string,
  files: MigrationEntry[],
  ran: number,
  open: number | null,
  logUnreadable: boolean,
): string {
  const head = `${lead} approved migration run \`${runId}\``;
  if (logUnreadable) {
    return `${head} and its step log cannot be read, so which files landed is unknown. Check the ledger for ${listOf(files.map((f) => f.migration))} before proposing any of them again.`;
  }
  const lines = files.map((f, i) => {
    const where = `${i + 1}. \`${f.migration}\` on \`${f.database}\``;
    if (i < ran) return `✓ ${where}: applied`;
    if (open === i + 1) return `? ${where}: in flight when the host stopped, so check the ledger`;
    return `– ${where}: not run`;
  });
  return `${head}: ${ran} of ${files.length} applied.\n${lines.join('\n')}\nA retry is a new proposal for the files not marked ✓.`;
}
