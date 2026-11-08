import { describe, expect, it, vi } from 'vitest';

import { guardReservedTokens, type TokenGuardDeps } from './token-guard.js';

const clean = { removed: [] as string[], unremovable: [] as Array<{ identifier: string; via: string }> };

type Spied = TokenGuardDeps & { notify: ReturnType<typeof vi.fn>; alert: ReturnType<typeof vi.fn> };

function deps(over: Partial<TokenGuardDeps> = {}): Spied {
  return {
    reserved: async () => [{ secret: 'approved-run-a token', owner: 'approved-run-a' }],
    enforce: async () => clean,
    strays: async () => [],
    sent: new Map(),
    ...over,
    notify: (over.notify as ReturnType<typeof vi.fn>) ?? vi.fn(async (_title: string, _body: string) => true),
    alert: (over.alert as ReturnType<typeof vi.fn>) ?? vi.fn((_title: string, _body: string) => undefined),
  } as Spied;
}

describe('guardReservedTokens', () => {
  it('tells the owner which agents lost a stray grant, and stays quiet when nothing drifted', async () => {
    const d = deps({
      reserved: async () => [
        { secret: 'approved-run-a token', owner: 'approved-run-a' },
        { secret: 'approved-run-b token', owner: 'approved-run-b' },
      ],
      enforce: async (secret, _owner, beforeRevoke) => {
        if (secret !== 'approved-run-a token') return clean;
        beforeRevoke('ag-stray');
        return { removed: ['ag-stray'], unremovable: [] };
      },
    });
    await guardReservedTokens(d);
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.alert.mock.calls).toEqual([
      [
        'Approved-run token granted elsewhere',
        expect.stringContaining(
          '"approved-run-a token" is reserved to OneCLI agent approved-run-a, but it is also granted to ag-stray',
        ),
      ],
    ]);
  });

  it('checks every token even when one cannot be read', async () => {
    const enforce = vi.fn(async (secret: string, _owner: string, beforeRevoke: (identifier: string) => void) => {
      if (secret === 'approved-run-b token') throw new Error('OneCLI GET /v1/agents failed');
      beforeRevoke('ag-stray');
      return { removed: ['ag-stray'], unremovable: [] };
    });
    const d = deps({
      reserved: async () => [
        { secret: 'approved-run-b token', owner: 'approved-run-b' },
        { secret: 'approved-run-c token', owner: 'approved-run-c' },
      ],
      enforce,
    });
    await guardReservedTokens(d);
    expect(enforce).toHaveBeenCalledTimes(2);
    expect(d.alert).toHaveBeenCalledTimes(1);
  });

  it('reports a rule it cannot remove once while it stands, and again only after it clears and returns', async () => {
    let result = { removed: [] as string[], unremovable: [{ identifier: 'ag-open', via: 'rule "All secrets"' }] };
    const d = deps({ enforce: async () => result });
    await guardReservedTokens(d);
    await guardReservedTokens(d);
    expect(d.notify.mock.calls).toEqual([
      [
        'Approved-run token reachable by another agent',
        expect.stringContaining(
          'ag-open (via rule "All secrets") can still be injected it, through a rule that is not a single-secret grant',
        ),
      ],
    ]);
    result = clean;
    await guardReservedTokens(d);
    result = { removed: [], unremovable: [{ identifier: 'ag-open', via: 'rule "All secrets"' }] };
    await guardReservedTokens(d);
    expect(d.notify).toHaveBeenCalledTimes(2);
  });

  it('retries a standing alert whose delivery failed, instead of counting it as sent', async () => {
    const notify = vi.fn(async (_title: string, _body: string) => false);
    const d = deps({
      enforce: async () => ({ removed: [], unremovable: [{ identifier: 'ag-open', via: 'rule "x"' }] }),
      notify,
    });
    await guardReservedTokens(d);
    notify.mockResolvedValue(true);
    await guardReservedTokens(d);
    await guardReservedTokens(d);
    expect(notify).toHaveBeenCalledTimes(2);
  });

  it('tells the owner once when a lane agent holds a secret other than its own token, as a renamed token would', async () => {
    const d = deps({ strays: async () => [{ agent: 'approved-run-a', secret: 'Snowflake old name' }] });
    await guardReservedTokens(d);
    await guardReservedTokens(d);
    expect(d.notify.mock.calls).toEqual([
      [
        'Approved-run agent holds an unexpected secret',
        expect.stringContaining(
          'approved-run-a can be injected "Snowflake old name", but the only secret it should hold is "approved-run-a token"',
        ),
      ],
    ]);
  });

  it('skips the pass quietly when the vault cannot be listed, and checks again next time', async () => {
    const enforce = vi.fn(async () => clean);
    const d = deps({
      reserved: async () => {
        throw new Error('OneCLI GET /v1/secrets failed');
      },
      enforce,
    });
    await expect(guardReservedTokens(d)).resolves.toBeUndefined();
    expect(enforce).not.toHaveBeenCalled();
    expect(d.notify).not.toHaveBeenCalled();
    expect(d.alert).not.toHaveBeenCalled();
  });

  it('still reports a token reachable elsewhere when what the lane agents hold cannot be read', async () => {
    const d = deps({
      enforce: async (_secret, _owner, beforeRevoke) => {
        beforeRevoke('ag-stray');
        return { removed: ['ag-stray'], unremovable: [] };
      },
      strays: async () => {
        throw new Error('OneCLI GET /v1/agents failed');
      },
    });
    await expect(guardReservedTokens(d)).resolves.toBeUndefined();
    expect(d.alert.mock.calls.map(([title]) => title)).toEqual(['Approved-run token granted elsewhere']);
  });

  it('reports a stray holding again after it was cleared and came back', async () => {
    let strays = [{ agent: 'approved-run-a', secret: 'Other' }];
    const d = deps({ strays: async () => strays });
    await guardReservedTokens(d);
    strays = [];
    await guardReservedTokens(d);
    strays = [{ agent: 'approved-run-a', secret: 'Other' }];
    await guardReservedTokens(d);
    expect(d.notify).toHaveBeenCalledTimes(2);
  });

  it('keeps the alert for a grant it removed even when the check after the removal fails', async () => {
    const d = deps({
      enforce: async (_secret, _owner, beforeRevoke) => {
        beforeRevoke('ag-stray');
        throw new Error('OneCLI GET /v1/agents/ag-stray/effective-credentials failed');
      },
    });
    await guardReservedTokens(d);
    expect(d.alert.mock.calls).toEqual([
      ['Approved-run token granted elsewhere', expect.stringContaining('also granted to ag-stray')],
    ]);
  });
});
