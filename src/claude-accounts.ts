/**
 * Claude OAuth accounts a container found at an account-wide limit, so the next spawn starts on a slot that still
 * has room instead of spending its first turn on a refusal. Keyed by a hash of the token: groups that share a token
 * share an account, and the value never sits in a map key.
 *
 * In memory on purpose, like the Codex account marks: a lost or wrong mark costs one refused turn, after which the
 * runner rotates on its own.
 */
import crypto from 'crypto';

export const CLAUDE_ACCOUNT_RETRY_MS = 60 * 60_000;
/** A reported reset further out than this is treated as this far: a window longer than a week is not one we know. */
export const CLAUDE_ACCOUNT_MARK_MAX_MS = 7 * 24 * 60 * 60_000;

const spentUntil = new Map<string, number>();

/** The runner reports this for the token it was refused on, so the report names a credential, not a slot. */
export function claudeTokenFingerprint(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function markClaudeAccountSpent(
  fingerprint: string,
  resetAt: string | null,
  nowMs: number = Date.now(),
): number {
  const reset = resetAt ? Date.parse(resetAt) : Number.NaN;
  const until =
    Number.isFinite(reset) && reset > nowMs
      ? Math.min(reset, nowMs + CLAUDE_ACCOUNT_MARK_MAX_MS)
      : nowMs + CLAUDE_ACCOUNT_RETRY_MS;
  spentUntil.set(fingerprint, until);
  return until;
}

export function isClaudeAccountSpent(token: string, nowMs: number = Date.now()): boolean {
  const key = claudeTokenFingerprint(token);
  const until = spentUntil.get(key);
  if (until === undefined) return false;
  if (until > nowMs) return true;
  spentUntil.delete(key);
  return false;
}

export interface ClaudeOauthSlot {
  name: string;
  value: string;
}

/** The ring a container builds from the forwarded tokens: primary first, then `_N` ascending, each value once. */
export function claudeOauthSlots(auth: {
  oauthPrimary?: string;
  oauthFallbacks: { index: number; value: string }[];
}): ClaudeOauthSlot[] {
  if (!auth.oauthPrimary) return [];
  const slots = [
    { name: 'CLAUDE_CODE_OAUTH_TOKEN', value: auth.oauthPrimary },
    ...[...auth.oauthFallbacks]
      .sort((a, b) => a.index - b.index)
      .map(({ index, value }) => ({ name: `CLAUDE_CODE_OAUTH_TOKEN_${index}`, value })),
  ];
  const seen = new Set<string>();
  return slots.filter((slot) => {
    if (!slot.value || seen.has(slot.value)) return false;
    seen.add(slot.value);
    return true;
  });
}

/**
 * The slots a container should not start on. With every slot marked none is withheld, and the runner's own rotation
 * decides as it did before the mark.
 */
export function spentClaudeSlots(slots: readonly ClaudeOauthSlot[], nowMs: number = Date.now()): string[] {
  const spent = slots.filter((slot) => isClaudeAccountSpent(slot.value, nowMs)).map((slot) => slot.name);
  return spent.length < slots.length ? spent : [];
}
