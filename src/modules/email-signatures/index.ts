import { registerSweepDuty, registerSweepDutySource, SWEEP_DUTY_INVENTORY } from '../../host-sweep.js';

function registerEmailSignatureSweepDuties(): void {
  registerSweepDuty({
    name: SWEEP_DUTY_INVENTORY.FORK14,
    phase: 'tick:housekeeping',
    order: 143,
    run: async () => {
      const { refreshEmailSignaturesIfDue } = await import('./refresh.js');
      void refreshEmailSignaturesIfDue();
    },
  });
}

registerSweepDutySource('email-signatures', registerEmailSignatureSweepDuties);
