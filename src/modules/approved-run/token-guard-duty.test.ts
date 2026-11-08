import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sweep = vi.hoisted(() => ({ sources: [] as Array<() => void>, duties: [] as Array<{ run: () => void }> }));
const vault = vi.hoisted(() => ({
  reservedVaultSecrets: vi.fn(),
  enforceReservedSecret: vi.fn(),
  reservedAgentStrays: vi.fn(async () => [] as Array<{ agent: string; secret: string }>),
}));
const owner = vi.hoisted(() => ({ notifyOwner: vi.fn(async () => ({ code: 0 })) }));
const outbox = vi.hoisted(() => ({ deliverQueued: vi.fn(async () => undefined), queueReport: vi.fn() }));

vi.mock('../../host-sweep.js', () => ({
  SWEEP_DUTY_INVENTORY: { FORK10: 'approved-run-token-guard' },
  registerSweepDuty: (duty: { run: () => void }) => sweep.duties.push(duty),
  registerSweepDutySource: (_name: string, register: () => void) => sweep.sources.push(register),
}));
vi.mock('../../onecli-secrets.js', () => ({
  reservedVaultSecrets: vault.reservedVaultSecrets,
  enforceReservedSecret: vault.enforceReservedSecret,
  reservedAgentStrays: vault.reservedAgentStrays,
}));
vi.mock('../../notify-owner.js', () => owner);
vi.mock('./outbox.js', () => outbox);

const INTERVAL_MS = 10 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.resetModules();
  sweep.sources.length = 0;
  sweep.duties.length = 0;
  vault.reservedVaultSecrets.mockReset();
  outbox.deliverQueued.mockClear();
  outbox.queueReport.mockClear();
  outbox.deliverQueued.mockImplementation(async () => undefined);
  vault.reservedAgentStrays.mockImplementation(async () => []);
  owner.notifyOwner.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

async function duty(): Promise<{ run: () => void }> {
  await import('./token-guard.js');
  for (const register of sweep.sources) register();
  expect(sweep.duties).toHaveLength(1);
  return sweep.duties[0];
}

describe('approved-run token guard duty', () => {
  it('waits one interval after boot before its first vault listing, then runs once per interval', async () => {
    vault.reservedVaultSecrets.mockResolvedValue([]);
    const d = await duty();
    d.run();
    expect(vault.reservedVaultSecrets).not.toHaveBeenCalled();
    vi.advanceTimersByTime(INTERVAL_MS);
    d.run();
    d.run();
    expect(vault.reservedVaultSecrets).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    d.run();
    expect(vault.reservedVaultSecrets).toHaveBeenCalledTimes(2);
  });

  it('never starts a pass while the last one is still running', async () => {
    let finish: (v: never[]) => void = () => {};
    vault.reservedVaultSecrets.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const d = await duty();
    vi.advanceTimersByTime(INTERVAL_MS);
    d.run();
    vi.advanceTimersByTime(INTERVAL_MS);
    d.run();
    expect(vault.reservedVaultSecrets).toHaveBeenCalledTimes(1);
    finish([]);
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    d.run();
    expect(vault.reservedVaultSecrets).toHaveBeenCalledTimes(2);
  });

  it('retries undelivered reports after each pass, even one whose vault read failed', async () => {
    vault.reservedVaultSecrets.mockRejectedValue(new Error('OneCLI GET /v1/secrets failed'));
    const d = await duty();
    vi.advanceTimersByTime(INTERVAL_MS);
    d.run();
    await vi.waitFor(() => expect(outbox.deliverQueued).toHaveBeenCalledTimes(1));
    expect(outbox.deliverQueued).toHaveBeenCalledWith();
  });

  it('queues a removed-grant alert for the owner, then delivers the outbox in the same pass', async () => {
    vault.reservedVaultSecrets.mockResolvedValue([{ secret: 'approved-run-a token', owner: 'approved-run-a' }]);
    vault.enforceReservedSecret.mockImplementation(
      async (_s: string, _o: string, beforeRevoke: (id: string) => void) => {
        beforeRevoke('ag-stray');
        return { removed: ['ag-stray'], unremovable: [] };
      },
    );
    const d = await duty();
    vi.advanceTimersByTime(INTERVAL_MS);
    d.run();
    await vi.waitFor(() => expect(outbox.deliverQueued).toHaveBeenCalledTimes(1));
    expect(outbox.queueReport).toHaveBeenCalledWith(expect.stringMatching(/^alert-/), [
      { to: 'owner', title: 'Approved-run token granted elsewhere', text: expect.stringContaining('ag-stray') },
    ]);
  });

  it('keeps running after a pass whose owner DM throws and whose delivery fails', async () => {
    vault.reservedVaultSecrets.mockResolvedValue([]);
    vault.reservedAgentStrays.mockImplementation(async () => [{ agent: 'approved-run-a', secret: 'Other' }]);
    owner.notifyOwner.mockRejectedValueOnce(new Error('alert channel unreachable')).mockResolvedValue({ code: 0 });
    outbox.deliverQueued.mockRejectedValueOnce(new Error('disk full'));
    const d = await duty();
    vi.advanceTimersByTime(INTERVAL_MS);
    d.run();
    await vi.waitFor(() => expect(outbox.deliverQueued).toHaveBeenCalledTimes(1));
    await vi.advanceTimersByTimeAsync(INTERVAL_MS);
    d.run();
    await vi.waitFor(() => expect(outbox.deliverQueued).toHaveBeenCalledTimes(2));
    expect(owner.notifyOwner).toHaveBeenCalledTimes(2);
    expect(owner.notifyOwner).toHaveBeenLastCalledWith({
      title: 'Approved-run agent holds an unexpected secret',
      body: expect.stringContaining('"Other"'),
    });
  });
});
