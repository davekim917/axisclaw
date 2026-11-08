/**
 * Test stub for claude.ts's email-gate-core delegation (loadEmailGateCore).
 *
 * The REAL core (email-gate-core.ts) lives in the bootstrap repo. This stub only
 * drives claude.ts's WIRING — that createEmailGateHook consumes the verdict
 * (allow vs gate + card) and runs its async ack round-trip on `gate`. Pointed at
 * via setGuardCorePathsForTest({ emailGate }).
 *
 * Sentinel-keyed so a test can prove the verdict came from THIS module (distinct
 * label text) rather than the inline fallback.
 */
export const STUB_DRAFT_BINDING = {
  draftId: 'r-stub-draft',
  messageId: 'm-shown',
  userId: 'me',
  credentialsFile: '/home/node/.config/gws/accounts/team-inbox.json',
};

/** What the stub's re-read answers, and every binding it was asked about. */
export const stubDraftCheck: { answer: string | null; throws: boolean; calls: unknown[] } = {
  answer: null,
  throws: false,
  calls: [],
};

export function evaluateEmailSend(
  command: string,
  env: { isScheduledTask: boolean },
): { action: 'allow' | 'gate'; label?: string; summary?: string; deny?: string; pureSend?: boolean; draft?: unknown } {
  if (env.isScheduledTask) return { action: 'allow' };
  const card = { action: 'gate' as const, label: 'STUB-CORE email label', summary: 'STUB-CORE email summary' };
  if (command.includes('STUB_PURE_SEND')) return { ...card, pureSend: true };
  if (command.includes('STUB_BUNDLE')) return { ...card, deny: 'STUB-CORE run the send alone' };
  if (command.includes('STUB_DRAFT_SEND')) return { ...card, draft: STUB_DRAFT_BINDING };
  if (command.includes('STUB_EMAIL_GATE')) {
    return { action: 'gate', label: 'STUB-CORE email label', summary: 'STUB-CORE email summary' };
  }
  return { action: 'allow' };
}

export function draftChangedSince(binding: unknown): string | null {
  stubDraftCheck.calls.push(binding);
  if (stubDraftCheck.throws) throw new Error('gws vanished');
  return stubDraftCheck.answer;
}
