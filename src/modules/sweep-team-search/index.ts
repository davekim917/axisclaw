import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';
import { log } from '../../log.js';

function registerTeamSearchSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.FORK12,
    phase: 'tick:housekeeping',
    order: 141,
    // main.ts loads the mobile module with the HTTP surface; a static import here would pull its graph, voice calls and
    // their host-start hook included, into everything that imports the modules barrel.
    run: () => {
      void import('../mobile/threads.js')
        .then(({ startChannelVisibilityRefresh }) => startChannelVisibilityRefresh())
        .catch((err: unknown) => log.warn('Mobile: channel visibility refresh failed to load', { err }));
    },
  });
}

registerSweepDutySource('sweep-team-search', registerTeamSearchSweepDuties);
