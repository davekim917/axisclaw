import { afterEach, describe, expect, it, vi } from 'vitest';

const startLogin = vi.hoisted(() => vi.fn(async () => ({ name: 'x', authorizeUrl: 'https://auth.example.com' })));
const addClientCredentialsIntegration = vi.hoisted(() => vi.fn(async () => ({ name: 'x' })));

vi.mock('../../modules/mcp-oauth/service.js', () => ({
  startLogin,
  addClientCredentialsIntegration,
  completeLogin: vi.fn(),
  refreshExpiringMcpOAuthIntegrations: vi.fn(),
  removeIntegration: vi.fn(),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(async (id: string) => ({ id, name: id })),
}));

import { commandGuardSpec } from '../guard.js';
import { lookup } from '../registry.js';
import './integrations.js';

describe('ncl integrations add-client', () => {
  const base = {
    name: 'example',
    group: 'ag-1',
    'api-url': 'https://api.example.com',
    'token-url': 'https://api.example.com/login',
    'client-id-env': 'EXAMPLE_CLIENT_ID',
    'client-secret-env': 'EXAMPLE_CLIENT_SECRET',
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    addClientCredentialsIntegration.mockClear();
  });

  it('takes the pair from the two host env vars it names', async () => {
    vi.stubEnv('EXAMPLE_CLIENT_ID', 'id-value');
    vi.stubEnv('EXAMPLE_CLIENT_SECRET', 'secret-value');
    const cmd = lookup('integrations-add-client');

    await cmd!.handler(cmd!.parseArgs(base), { caller: 'host' });

    expect(addClientCredentialsIntegration).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'id-value', clientSecret: 'secret-value' }),
    );
  });

  it.each([
    ['a value in place of a name', 'not-an-env-name', /must be an env var name/],
    ['an env var that is not set', 'EXAMPLE_UNSET_VARIABLE', /is not set/],
  ])('refuses %s', async (_name, clientIdEnv, reason) => {
    vi.stubEnv('EXAMPLE_CLIENT_SECRET', 'secret-value');
    const cmd = lookup('integrations-add-client');

    await expect(
      cmd!.handler(cmd!.parseArgs({ ...base, 'client-id-env': clientIdEnv }), { caller: 'host' }),
    ).rejects.toThrow(reason);
    expect(addClientCredentialsIntegration).not.toHaveBeenCalled();
  });

  it('is refused for a container caller, so an agent cannot send a host env var to a URL it picks', () => {
    const decision = commandGuardSpec(lookup('integrations-add-client')!).decide({
      actor: { kind: 'agent', agentGroupId: 'ag-1' },
      payload: base,
    } as never);
    expect(decision).toMatchObject({ effect: 'deny', reason: expect.stringContaining('operator-only') });
  });
});

describe('ncl integrations login --authorize-param', () => {
  const base = { name: 'example', url: 'https://mcp.example.com/mcp', group: 'ag-1' };

  it.each([
    [['a=1', 'b=2'], { a: '1', b: '2' }],
    [['a=1,b=2', 'c=3'], { a: '1', b: '2', c: '3' }],
    ['a=1,b=2', { a: '1', b: '2' }],
  ])('accepts %j as a repeatable flag', async (authorizeParam, expected) => {
    const cmd = lookup('integrations-login');
    expect(cmd?.listArgs).toContain('authorize_param');
    await cmd!.handler(cmd!.parseArgs({ ...base, 'authorize-param': authorizeParam }), { caller: 'host' });
    expect(startLogin).toHaveBeenLastCalledWith(expect.objectContaining({ extraAuthorizeParams: expected }));
  });
});
