/**
 * Sweep duty: every reserved approved-run token stays injectable for its one agent only. The spawn path and
 * `ncl secrets grant` refuse to grant a reserved token elsewhere, but a grant made straight against the vault
 * bypasses both; this removes any such grant within one interval and tells the owner. It also reports a reserved
 * agent holding any secret other than its own token, which is what a token renamed out of the naming rule looks like.
 * Everything it checks is read fresh from the vault each pass. Each pass then retries the lane's undelivered reports
 * (outbox.ts), including the removed-grant alert, whose grant is gone by the next pass and so is never seen again.
 */
import { randomUUID } from 'node:crypto';

import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';
import { notifyOwner } from '../../notify-owner.js';
import { enforceReservedSecret, reservedAgentStrays, reservedVaultSecrets } from '../../onecli-secrets.js';
import { deliverQueued, queueReport } from './outbox.js';

const INTERVAL_MS = 10 * 60 * 1000;

export interface TokenGuardDeps {
  reserved: () => Promise<Array<{ secret: string; owner: string }>>;
  enforce: (
    secret: string,
    owner: string,
    beforeRevoke: (identifier: string) => void,
  ) => Promise<{ removed: string[]; unremovable: Array<{ identifier: string; via: string }> }>;
  strays: () => Promise<Array<{ agent: string; secret: string }>>;
  /** Resolves true only when the owner was actually told. */
  notify: (title: string, body: string) => Promise<boolean>;
  /** Queues a one-off alert for the owner: its event is not seen again, so it must survive a failed delivery. */
  alert: (title: string, body: string) => void;
  /**
   * The standing alert last delivered, per subject, so a condition that persists is reported once. In memory: a host
   * restart reports a still-standing condition once more, which is the safe direction.
   */
  sent: Map<string, string>;
}

/** Reports a standing condition once; a failed delivery is retried on the next pass. */
async function standing(deps: TokenGuardDeps, subject: string, alert: string | null, title: string, body: string) {
  if (alert === null) {
    deps.sent.delete(subject);
    return;
  }
  if (deps.sent.get(subject) === alert) return;
  if (await deps.notify(title, body)) deps.sent.set(subject, alert);
}

export async function guardReservedTokens(deps: TokenGuardDeps): Promise<void> {
  let reserved: Array<{ secret: string; owner: string }>;
  try {
    reserved = await deps.reserved();
    // eslint-disable-next-line no-catch-all/no-catch-all -- an unreadable vault is retried on the next pass
  } catch (err) {
    log.warn('Approved-run token guard could not list the vault', { err });
    return;
  }
  for (const { secret, owner } of reserved) {
    let result: Awaited<ReturnType<TokenGuardDeps['enforce']>>;
    try {
      // The alert is queued before the grant goes: once it is gone, no later pass can see that it existed.
      result = await deps.enforce(secret, owner, (identifier) =>
        deps.alert(
          'Approved-run token granted elsewhere',
          `"${secret}" is reserved to OneCLI agent ${owner}, but it is also granted to ${identifier}. The guard is removing that grant now; if this alert comes again, the removal failed. Something granted it straight against the vault; find out what, and rotate the token if that agent may have used it.`,
        ),
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- one unreadable token must not stop the others being checked
    } catch (err) {
      log.warn('Approved-run token guard could not check a reserved secret', { secret, err });
      continue;
    }
    const { removed, unremovable } = result;
    if (removed.length)
      log.error('Approved-run token was granted to other agents; grants removed', { secret, owner, removed });
    const who = unremovable.map((u) => `${u.identifier} (via ${u.via})`).join(', ');
    if (unremovable.length) {
      log.error('Approved-run token is injectable for another agent through a rule this guard cannot remove', {
        secret,
        unremovable,
      });
    }
    await standing(
      deps,
      `unremovable:${secret}`,
      unremovable.length ? who : null,
      'Approved-run token reachable by another agent',
      `"${secret}" is reserved to OneCLI agent ${owner}, but ${who} can still be injected it, through a rule that is not a single-secret grant. Can't remove: delete or narrow that rule. Approved runs are refused until then.`,
    );
  }

  let strays: Array<{ agent: string; secret: string }>;
  try {
    strays = await deps.strays();
    // eslint-disable-next-line no-catch-all/no-catch-all -- retried on the next pass
  } catch (err) {
    log.warn('Approved-run token guard could not read what the lane agents hold', { err });
    return;
  }
  const byAgent = new Map<string, string[]>();
  for (const { agent, secret } of strays) byAgent.set(agent, [...(byAgent.get(agent) ?? []), secret]);
  for (const subject of [...deps.sent.keys()].filter((k) => k.startsWith('stray:'))) {
    if (!byAgent.has(subject.slice('stray:'.length))) deps.sent.delete(subject);
  }
  for (const [agent, secrets] of byAgent) {
    const list = secrets.map((s) => `"${s}"`).join(', ');
    await standing(
      deps,
      `stray:${agent}`,
      list,
      'Approved-run agent holds an unexpected secret',
      `OneCLI agent ${agent} can be injected ${list}, but the only secret it should hold is "${agent} token". If that is its token renamed, the reservation no longer covers it: rename it back. Otherwise remove the grant.`,
    );
  }
}

// The first pass waits one interval: a host restart is already a burst of vault listings, and this adds none to it.
let lastRunAt = Date.now();
let running = false;
const sent = new Map<string, string>();

function registerApprovedRunSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.FORK10,
    phase: 'tick:housekeeping',
    order: 138,
    run: () => {
      if (running || Date.now() - lastRunAt < INTERVAL_MS) return;
      running = true;
      lastRunAt = Date.now();
      // Detached: one vault listing plus a reflection read per agent must never hold the tick.
      void guardReservedTokens({
        reserved: reservedVaultSecrets,
        enforce: enforceReservedSecret,
        strays: reservedAgentStrays,
        notify: async (title, body) => (await notifyOwner({ title, body })).code === 0,
        alert: (title, body) => queueReport(`alert-${randomUUID()}`, [{ to: 'owner', title, text: body }]),
        sent,
      })
        .catch((err) => log.warn('Approved-run token guard failed', { err }))
        .then(() => deliverQueued())
        .catch((err) => log.warn('Approved-run report delivery failed', { err }))
        .finally(() => {
          running = false;
        });
    },
  });
}

registerSweepDutySource('approved-run-token-guard', registerApprovedRunSweepDuties);
