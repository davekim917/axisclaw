import {
  aiReasonKind,
  RECORDED_HOLD,
  type AcceptedDetail,
  type AiFinding,
  type GateOutcome,
  type HoldReason,
  type ReadWatch,
} from './gate.js';

export const NO_CHANGES_EXIT = 4;

/** A shorter quote matches unrelated text, so its record would hold unrelated commits; a person settles it instead. */
const MIN_HELD_TEXT = 8;

type SquashReason = 'scanner-or-gate-hold' | 'ai-hold-fixed-forward';

/** An AI flag kept across runs, so a later read can never pass what it held. */
export interface AiHoldRecord {
  /** Null when the held commit could not be resolved: its quotes cannot be proven, so it holds every commit. */
  originRev: string | null;
  findings: AiFinding[];
  /** Every finding's quotes, each proven on its finding's line in the held commit; null when any finding has none. */
  texts: string[] | null;
  /** Saved before the commit's AI read and replaced by its verdict, so a run that dies mid-read leaves a hold. */
  pending?: true;
}

function isQuote(text: unknown): boolean {
  return typeof text === 'string' && text.trim() === text && text.length >= MIN_HELD_TEXT && !/[\r\n]/.test(text);
}

/**
 * The quotes a finding's text may stand for: the whole text, and each part between its ellipses, since an AI that
 * shortens a line elides its middle and leaves no whole quote of it.
 */
function quoteParts(finding: unknown): { whole: string | null; parts: string[] } {
  const text = (finding as Partial<AiFinding> | null)?.text;
  if (typeof text !== 'string') return { whole: null, parts: [] };
  const trimmed = text.trim();
  const parts = trimmed.split(/\.\.\.|\u2026/).map((part) => part.trim());
  return {
    whole: isQuote(trimmed) ? trimmed : null,
    parts: parts.length > 1 ? [...new Set(parts.filter(isQuote))] : [],
  };
}

function quoteCandidates(finding: unknown): string[] {
  const { whole, parts } = quoteParts(finding);
  return whole === null ? parts : [whole, ...parts];
}

export function isAiHoldRecord(value: unknown): value is AiHoldRecord {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Partial<AiHoldRecord>;
  const resolved = typeof record.originRev === 'string' && /^[0-9a-f]{40}$/.test(record.originRev);
  if (!resolved && record.originRev !== null) return false;
  if (!Array.isArray(record.findings)) return false;
  if (record.pending !== undefined && record.pending !== true) return false;
  if (record.texts === null) return true;
  if (!resolved || record.pending) return false;
  if (!Array.isArray(record.texts) || record.findings.length === 0) return false;
  const texts: unknown[] = record.texts;
  const candidates = record.findings.map(quoteCandidates);
  return (
    texts.every((text) => candidates.some((quotes) => quotes.includes(text as string))) &&
    candidates.every((quotes) => quotes.some((quote) => texts.includes(quote)))
  );
}

export interface Status {
  status: 'ok' | 'held' | 'failed';
  at: string;
  workflow?: string;
  dryRun: boolean;
  lastPublished: string | null;
  lastPassing: string | null;
  held?: { sha: string; reasons: HoldReason[] };
  perCommitHold?: { sha: string; reasons: HoldReason[] };
  squashReason?: SquashReason;
  /** How many AI findings accepted entries dropped; counts only. */
  acceptedFindings?: number;
  error?: string;
}

export type StatusFields = Omit<Status, 'at' | 'dryRun'>;

type Workflow = 'export' | 'export_squash';

export interface ExportDeps {
  publicRemote: boolean;
  /** Strings that must never reach the status file, such as remote URLs. */
  redact: string[];
  writeStatus(fields: StatusFields): void;
  clearStatus(): void;
  writeHeldDetail(detail: { sha: string; aiFindings: AiFinding[] }): void;
  writeAcceptedDetail(accepted: AcceptedDetail[]): void;
  stagingHead(): string | null;
  resetStaging(sha: string | null): void;
  copybara(workflow: Workflow, initHistory: boolean): number;
  newCommits(base: string | null, head: string): string[];
  /** A regular file's content at a staging commit; null when it is missing, a symlink or not a file. */
  fileAt(sha: string, file: string): string | null;
  /** Whether one of `texts`, ignoring case, is in what a staging commit publishes or its AI read would see. */
  mentions(sha: string, texts: string[]): boolean;
  /** The `GitOrigin-RevId` of a staging commit; null when the commit or its trailer is missing. */
  originRev(sha: string): string | null;
  /** Whether private commit `rev` is `head` or one of its ancestors; false when either is unknown. */
  originContains(head: string, rev: string): boolean;
  /** Null when no store has been written yet. */
  loadAiHolds(): AiHoldRecord[] | null;
  saveAiHolds(records: AiHoldRecord[]): void;
  /** What `writeHeldDetail` last wrote, or null. */
  readHeldDetail(): { sha: string; aiFindings: AiFinding[] } | null;
  gate(shas: string[], watch: ReadWatch): Promise<GateOutcome>;
  remoteHead(): string | null;
  push(sha: string): void;
}

function trustedGatedHead(deps: Pick<ExportDeps, 'publicRemote' | 'remoteHead'>): string | null {
  return deps.publicRemote ? deps.remoteHead() : null;
}

export function redactText(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) if (secret) out = out.split(secret).join('<redacted>');
  return out.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1<redacted>@');
}

export function failedStatus(error: unknown, secrets: string[]): StatusFields {
  return {
    status: 'failed',
    lastPublished: null,
    lastPassing: null,
    error: redactText(error instanceof Error ? error.message : String(error), secrets),
  };
}

interface Exported {
  passing: string | null;
  held?: GateOutcome['held'];
  accepted?: AcceptedDetail[];
  refused?: true;
}

function requireOriginRev(deps: ExportDeps, sha: string): string {
  const rev = deps.originRev(sha);
  if (!rev) throw new Error(`staging commit ${sha} has no GitOrigin-RevId`);
  return rev;
}

/**
 * Each finding's quotes found on its own line of its own file: its whole text when that is there, else every
 * elided part that is. Null when any finding has none.
 */
function provableTexts(deps: ExportDeps, sha: string, findings: AiFinding[]): string[] | null {
  if (findings.length === 0) return null;
  const texts: string[] = [];
  for (const finding of findings as unknown[]) {
    if (typeof finding !== 'object' || finding === null) return null;
    const { file, line } = finding as AiFinding;
    if (typeof file !== 'string') return null;
    if (typeof line !== 'number' || !Number.isInteger(line) || line < 1) return null;
    let content: string | null;
    try {
      content = deps.fileAt(sha, file.replace(/^\.\//, ''));
    } catch {
      return null;
    }
    const named = content?.split('\n')[line - 1];
    if (named === undefined) return null;
    const { whole, parts } = quoteParts(finding);
    const found = whole !== null && named.includes(whole) ? [whole] : parts.filter((part) => named.includes(part));
    if (found.length === 0) return null;
    texts.push(...found);
  }
  return texts;
}

function aiReasons(held: NonNullable<GateOutcome['held']>): HoldReason[] {
  return held.reasons.filter((reason) => reason.source === 'ai');
}

function withRecord(
  deps: ExportDeps,
  records: AiHoldRecord[],
  held: NonNullable<GateOutcome['held']>,
  originRev: string,
): AiHoldRecord[] {
  const kinds = aiReasons(held).map((reason) => aiReasonKind(reason.category));
  if (!kinds.some((kind) => kind === 'flag' || kind === 'quoted-flag')) return records;
  if (records.some((record) => record.originRev === originRev)) return records;
  const texts = kinds.includes('flag') ? null : provableTexts(deps, held.sha, held.aiFindings);
  return [...records, { originRev, findings: held.aiFindings, texts }];
}

/**
 * The records the public head has not yet passed. A store not written yet starts from the last held detail, so a
 * hold made before records were kept is not read again.
 */
function liveRecords(deps: ExportDeps, stored: AiHoldRecord[] | null, trusted: string | null): AiHoldRecord[] {
  let records = stored ?? [];
  const last = stored === null ? deps.readHeldDetail() : null;
  if (last && last.aiFindings.length > 0) {
    const originRev = deps.originRev(last.sha);
    const texts = originRev ? provableTexts(deps, last.sha, last.aiFindings) : null;
    records = [{ originRev, findings: last.aiFindings, texts }];
  }
  const published = trusted && records.length > 0 ? deps.originRev(trusted) : null;
  return published
    ? records.filter((record) => record.originRev === null || !deps.originContains(published, record.originRev))
    : records;
}

/**
 * A commit a live AI flag holds: the flagged commit, any commit still carrying a flagged quote, and every commit
 * while a flag has no provable quote, since its text could be in any of them.
 */
function heldByRecord(deps: ExportDeps, records: AiHoldRecord[], sha: string): boolean {
  if (records.length === 0) return false;
  if (records.some((record) => record.texts === null)) return true;
  const rev = requireOriginRev(deps, sha);
  if (records.some((record) => record.originRev === rev)) return true;
  return deps.mentions(
    sha,
    records.flatMap((record) => record.texts ?? []),
  );
}

/** The live records, and the only way they change during a run. */
interface Ledger {
  records: AiHoldRecord[];
  /** Origins resolved before any read, so recording a verdict needs no further git call. */
  revs: Map<string, string>;
  watch: ReadWatch;
}

function recordedHold(records: AiHoldRecord[], sha: string): NonNullable<GateOutcome['held']> {
  const reason: HoldReason = { source: 'ai', where: 'earlier run', category: RECORDED_HOLD };
  return { sha, reasons: [reason], aiFindings: records.flatMap((record) => record.findings) };
}

async function gateUnlessRecorded(deps: ExportDeps, ledger: Ledger, shas: string[]): Promise<GateOutcome> {
  const records = ledger.records;
  const index = shas.findIndex((sha) => heldByRecord(deps, records, sha));
  if (index < 0) return deps.gate(shas, ledger.watch);
  const before: GateOutcome = index === 0 ? { lastPassing: null } : await deps.gate(shas.slice(0, index), ledger.watch);
  if (before.held) return before;
  return { ...before, held: recordedHold(records, shas[index]) };
}

async function exportAndGate(
  deps: ExportDeps,
  ledger: Ledger,
  base: string | null,
  workflow: Workflow,
  admit?: (head: string) => boolean,
): Promise<Exported> {
  const code = deps.copybara(workflow, base === null);
  if (code === NO_CHANGES_EXIT) return { passing: base };
  if (code !== 0) throw new Error(`copybara ${workflow} exited ${code}`);
  const head = deps.stagingHead();
  if (admit && !(head && admit(head))) {
    deps.resetStaging(base);
    return { passing: base, refused: true };
  }
  const shas = head ? deps.newCommits(base, head) : [];
  for (const sha of shas) ledger.revs.set(sha, requireOriginRev(deps, sha));
  const outcome = await gateUnlessRecorded(deps, ledger, shas);
  const passing = outcome.lastPassing ?? base;
  if (outcome.held) deps.resetStaging(passing);
  return { passing, held: outcome.held, accepted: outcome.accepted };
}

/** A flag found anywhere in a run also holds any commit of the passing prefix that carries it. */
function withoutFlaggedPrefix(
  deps: ExportDeps,
  records: AiHoldRecord[],
  trusted: string | null,
  result: Exported,
): Exported {
  const prefix = result.passing ? deps.newCommits(trusted, result.passing) : [];
  const cut = prefix.findIndex((sha) => heldByRecord(deps, records, sha));
  if (cut < 0) return result;
  const passing = cut === 0 ? trusted : prefix[cut - 1];
  deps.resetStaging(passing);
  return { ...result, passing, held: result.held ?? recordedHold(records, prefix[cut]) };
}

export async function runExport(deps: ExportDeps): Promise<number> {
  try {
    const trusted = trustedGatedHead(deps);
    if (deps.stagingHead() !== trusted) deps.resetStaging(trusted);
    let workflow: Workflow = trusted === null ? 'export_squash' : 'export';
    const stored = deps.loadAiHolds();
    // A dry run publishes nothing, so its flags stay out of the store the publishing run reads.
    const keep = (records: AiHoldRecord[]) => {
      ledger.records = records;
      if (deps.publicRemote) deps.saveAiHolds(records);
    };
    const revOf = (sha: string) => ledger.revs.get(sha) ?? requireOriginRev(deps, sha);
    const ledger: Ledger = {
      records: liveRecords(deps, stored, trusted),
      revs: new Map(),
      watch: {
        reserve: (sha) => {
          const originRev = revOf(sha);
          keep([...ledger.records, { originRev, findings: [], texts: null, pending: true }]);
        },
        settle: (sha, held) => {
          const originRev = revOf(sha);
          const settled = ledger.records.filter((record) => !(record.pending && record.originRev === originRev));
          keep(held ? withRecord(deps, settled, held, originRev) : settled);
        },
      },
    };
    if (stored === null || JSON.stringify(ledger.records) !== JSON.stringify(stored)) keep(ledger.records);
    const exported = await exportAndGate(deps, ledger, trusted, workflow);
    let result = withoutFlaggedPrefix(deps, ledger.records, trusted, exported);
    const accepted = [...(result.accepted ?? [])];
    let perCommitHold: Status['held'];
    let squashReason: SquashReason | undefined;
    const firstHeld = result.held;
    if (firstHeld) deps.writeHeldDetail({ sha: firstHeld.sha, aiFindings: firstHeld.aiFindings });
    if (firstHeld && workflow === 'export') {
      const aiHold = aiReasons(firstHeld).length > 0;
      const fixable =
        firstHeld.reasons.every((reason) => ['recorded', 'quoted-flag'].includes(aiReasonKind(reason.category))) &&
        ledger.records.every((record) => record.texts !== null);
      if (!aiHold || fixable) {
        const live = ledger.records;
        const squash = await exportAndGate(
          deps,
          ledger,
          result.passing,
          'export_squash',
          aiHold ? (head) => !heldByRecord(deps, live, head) : undefined,
        );
        if (!squash.refused) {
          perCommitHold = { sha: firstHeld.sha, reasons: firstHeld.reasons };
          squashReason = aiHold ? 'ai-hold-fixed-forward' : 'scanner-or-gate-hold';
          workflow = 'export_squash';
          result = squash;
          accepted.push(...(result.accepted ?? []));
          if (result.held) deps.writeHeldDetail({ sha: result.held.sha, aiFindings: result.held.aiFindings });
        }
      }
    }
    if (accepted.length > 0) deps.writeAcceptedDetail(accepted);
    result = withoutFlaggedPrefix(deps, ledger.records, trusted, result);

    let published: string | null = null;
    if (deps.publicRemote) {
      published = trusted;
      if (result.passing && result.passing !== trusted) {
        deps.push(result.passing);
        published = result.passing;
      }
    }
    deps.writeStatus({
      status: result.held ? 'held' : 'ok',
      workflow,
      lastPublished: published,
      lastPassing: result.passing,
      held: result.held ? { sha: result.held.sha, reasons: result.held.reasons } : undefined,
      ...(perCommitHold ? { perCommitHold, squashReason } : {}),
      ...(accepted.length > 0 ? { acceptedFindings: accepted.length } : {}),
    });
    return result.held ? 2 : 0;
  } catch (error) {
    try {
      deps.writeStatus(failedStatus(error, deps.redact));
    } catch {
      deps.clearStatus();
    }
    return 1;
  }
}
