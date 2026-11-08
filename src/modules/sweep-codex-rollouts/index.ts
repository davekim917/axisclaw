/**
 * Sweep duty: once a day, delete Codex session rollouts older than 30 days from every host fallback Codex home a group
 * can rotate to. In memory on purpose: a host restart only moves the next pass up to the first tick.
 */
import { codexRolloutPruneHomes, pruneCodexRollouts } from '../../codex-rollout-prune.js';
import { readContainerConfig } from '../../container-config.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';

const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

let nextRunAt = 0;
let running = false;

function registerCodexRolloutPruneDuty(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.FORK13,
    phase: 'tick:housekeeping',
    order: 142,
    run: () => {
      if (running || Date.now() < nextRunAt) return;
      running = true;
      nextRunAt = Date.now() + PRUNE_INTERVAL_MS;
      // Detached: walking thousands of rollouts must never hold the tick.
      void getAllAgentGroups()
        .then(async (groups) => {
          const selected = codexRolloutPruneHomes(groups, (folder) => readContainerConfig(folder).codexAuthFallbacks);
          const result = await pruneCodexRollouts(selected.homes);
          const errors = [...selected.errors, ...result.errors];
          if (result.deleted > 0 || errors.length > 0) {
            log.info('Codex rollouts older than 30 days pruned', {
              homes: selected.homes,
              deleted: result.deleted,
              bytes: result.bytes,
              errors,
            });
          }
        })
        .catch((err) => log.warn('Codex rollout prune failed', { err }))
        .finally(() => {
          running = false;
        });
    },
  });
}

registerSweepDutySource('codex-rollout-prune', registerCodexRolloutPruneDuty);
