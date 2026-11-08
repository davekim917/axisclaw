import { DENY, HOLD, defineGuardedAction, type GuardInput } from '../../guard/index.js';
import type { PendingApproval } from '../../types.js';

export const APPROVED_RUN_ACTION = 'approved-run';
/** Approvers are often away; the request is sha-bound, so a late answer still runs exactly what was shown. */
const CARD_TTL_MS = 24 * 60 * 60 * 1000;

function decide(input: GuardInput) {
  if (input.actor.kind !== 'agent') return DENY('approved runs are proposed by an agent');
  const c = input.payload.classification as { tier?: unknown; denyReasons?: string[] } | undefined;
  if (!c || typeof input.payload.sha256 !== 'string') return DENY('the host has not classified this file');
  if (c.tier !== 'card') return DENY(c.denyReasons?.join('; ') || 'denied by the classifier');
  return HOLD('a named approver decides this file');
}

function grantCoversRequest(grant: PendingApproval, input: GuardInput): boolean {
  let held: Record<string, unknown>;
  try {
    held = JSON.parse(grant.payload) as Record<string, unknown>;
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable grant covers nothing
  } catch {
    return false;
  }
  if (Date.now() - Date.parse(grant.created_at) > CARD_TTL_MS) return false;
  return (
    held.sha256 === input.payload.sha256 &&
    held.target === input.payload.target &&
    held.targetSha === input.payload.targetSha
  );
}

export const approvedRunExecute = defineGuardedAction({
  action: 'approved_run.execute',
  grantActionName: APPROVED_RUN_ACTION,
  decide,
  grantCoversRequest,
});
