import { log } from '../../log.js';
import { SWEEP_DUTY_INVENTORY, registerSweepDuty, registerSweepDutySource } from '../../host-sweep.js';
import { sweepOrphanedRepoIngressFences } from '../../repo-fence-recovery.js';
import type { Session } from '../../types.js';

const id = SWEEP_DUTY_INVENTORY;

async function scanForOrphanedRepoFences(sessions: Session[]): Promise<void> {
  try {
    await sweepOrphanedRepoIngressFences(sessions);
  } catch (err) {
    log.warn('Orphaned repository fence sweep step failed', { err });
  }
}

function registerSweepRepoFenceDuties(): void {
  registerSweepDuty({
    name: id.T22,
    phase: 'tick:post-session',
    order: 50,
    // Nothing else releases a fence whose publication is gone; a leaked fence
    // holds every inbound row and refuses every spawn for that session.
    // Not awaited: the scan opens every session's mailbox, which on a cold or busy
    // host outlasts the tick and takes every later duty and session down with it.
    run: (ctx) => {
      void scanForOrphanedRepoFences(ctx.sessions as Session[]);
    },
  });

  registerSweepDuty({
    name: id.T5,
    phase: 'tick:housekeeping',
    order: 10,
    run: async () => {
      try {
        const { sweepAwaitingReasonRejects } = await import('../approvals/index.js');
        await sweepAwaitingReasonRejects();
      } catch (err) {
        log.error('Reject-with-reason sweep failed', { err });
      }
    },
  });

  registerSweepDuty({
    name: id.FORK8,
    phase: 'tick:housekeeping',
    order: 12,
    run: async () => {
      try {
        const { expireOverdueGates } = await import('../bash-gate/index.js');
        await expireOverdueGates();
      } catch (err) {
        log.error('Gate expiry sweep failed', { err });
      }
    },
  });
}

registerSweepDutySource('sweep-repo-fence', registerSweepRepoFenceDuties);
