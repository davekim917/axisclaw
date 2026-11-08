import fs from 'node:fs';

import type { HoldReason } from './gate.js';
import type { Status } from './export-flow.js';

export interface AlertDeps {
  recordFile: string;
  heldDetailLabel: string;
  /** The private commit a staging commit came from, or null when it cannot be resolved. */
  origin(stagingSha: string): { rev: string; subject: string } | null;
  /** The held findings' quotes; may throw. */
  quotes(): string[];
  /** Whether the private-identifier scanner passes `text`; may throw. */
  isClean(text: string): boolean;
  notify(title: string, body: string): Promise<{ code: number; message: string }>;
}

export type AlertOutcome = 'skipped' | 'cleared' | 'quiet' | 'sent' | 'undelivered';

interface Message {
  key: string;
  title: string;
  body: string;
}

function readRecord(file: string): string | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { key?: unknown };
    return typeof parsed.key === 'string' ? parsed.key : null;
  } catch {
    return null;
  }
}

function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of [...secrets].map((s) => s.trim()).sort((a, b) => b.length - a.length)) {
    if (!secret) continue;
    out = out.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<redacted>');
  }
  return out;
}

function reasonLines(reasons: HoldReason[]): string[] {
  return reasons.map((reason) => `• ${reason.where} — ${reason.source}: ${reason.category}`);
}

function heldMessage(status: Status, deps: AlertDeps, quotes: string[] | null): Message {
  const held = status.held!;
  // A squash retry holds on a commit made from private HEAD; the commit that first held is the one to fix.
  const first = status.perCommitHold ?? held;
  const origin = deps.origin(first.sha);
  const subject = origin ? shareable(origin.subject, deps, quotes) : null;
  const commit = !origin
    ? `\`${first.sha.slice(0, 10)}\` (private commit unresolved)`
    : `\`${first.sha.slice(0, 10)}\` (private \`${origin.rev.slice(0, 10)}\`: ${subject ?? '<subject withheld>'})`;
  const lines = [
    `Held on ${commit}. The public mirror stays at \`${(status.lastPublished ?? 'nothing').slice(0, 10)}\`.`,
    '',
    'Reasons:',
    ...reasonLines(first.reasons),
  ];
  if (status.perCommitHold) lines.push('', 'The squash retry also held:', ...reasonLines(held.reasons));
  lines.push(
    '',
    `Detail: \`${deps.heldDetailLabel}\` on the host.`,
    'Fix it with a change in the private repo; the next run publishes the fix. Add an accepted-finding entry only after a person confirms a false positive.',
  );
  const squash = status.perCommitHold
    ? `|squash:${held.reasons.map((reason) => `${reason.where}:${reason.category}`.replace(/\d+/g, '#')).join(',')}`
    : '';
  return { key: `held:${origin?.rev ?? first.sha}${squash}`, title: 'Public export held', body: lines.join('\n') };
}

function failedMessage(status: Status | null, deps: AlertDeps, quotes: string[] | null): Message {
  const raw = status?.error ?? 'the run could not write its status file';
  const error = shareable(raw, deps, quotes) ?? '<error text withheld; see the status file>';
  return {
    key: `failed:${raw.replace(/\b[0-9a-f]{7,40}\b/g, '<sha>')}`,
    title: 'Public export failed',
    body: `The nightly public export failed: ${error}\n\nStatus: \`logs/public-export-status.json\` on the host.`,
  };
}

/** Private text with its quotes redacted, or null unless the scanner passes it. */
function shareable(text: string, deps: AlertDeps, quotes: string[] | null): string | null {
  if (quotes === null) return null;
  // An AI quote is a whole line, so the name it flagged can appear elsewhere without the rest of the line.
  const tokens = quotes.flatMap((quote) => quote.match(/[\p{L}\p{N}]{4,}/gu) ?? []);
  const redacted = redact(text, [...quotes, ...tokens]);
  try {
    return deps.isClean(redacted) ? redacted : null;
  } catch {
    return null;
  }
}

export async function alertOwner(status: Status | null, dryRun: boolean, deps: AlertDeps): Promise<AlertOutcome> {
  if (dryRun || status?.dryRun) return 'skipped';
  if (status?.status === 'ok') {
    fs.rmSync(deps.recordFile, { force: true });
    return 'cleared';
  }
  let quotes: string[] | null;
  try {
    quotes = deps.quotes();
  } catch {
    quotes = null;
  }
  const message =
    status?.status === 'held' && status.held ? heldMessage(status, deps, quotes) : failedMessage(status, deps, quotes);
  if (readRecord(deps.recordFile) === message.key) return 'quiet';
  const result = await deps.notify(message.title, redact(message.body, quotes ?? []));
  if (result.code !== 0) return 'undelivered';
  fs.writeFileSync(deps.recordFile, JSON.stringify({ key: message.key, at: new Date().toISOString() }, null, 2) + '\n');
  return 'sent';
}
