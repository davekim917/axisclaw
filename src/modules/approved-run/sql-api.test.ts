import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: fetchMock,
}));
vi.mock('../../onecli-agent-proxy.js', () => ({
  agentProxyUrl: vi.fn(async (agent: string) => `http://x:token-of-${agent}@127.0.0.1:10255`),
}));

import { sqlApiFor } from './sql-api.js';

const EXECUTE = {
  account: 'acme-xy12345',
  user: 'APPROVED_RUN_ACME',
  secret: 'approved-run-acme token',
  onecliAgent: 'approved-run-acme',
  warehouse: null,
};

beforeEach(() => fetchMock.mockReset());

describe('sqlApiFor', () => {
  it('posts to the account through the agent proxy, naming the token type and leaving Authorization to the gateway', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ statementHandle: 'h' }), { status: 200 }));
    const api = await sqlApiFor(EXECUTE);
    const res = await api('POST', '/api/v2/statements', { requestId: 'r-1' }, { statement: 'CREATE ROLE AR_A;' });

    expect(res).toEqual({ status: 200, body: { statementHandle: 'h' } });
    const [url, init] = fetchMock.mock.calls[0] as [
      URL,
      { headers: Record<string, string>; body: string; dispatcher: unknown },
    ];
    expect(String(url)).toBe('https://acme-xy12345.snowflakecomputing.com/api/v2/statements?requestId=r-1');
    expect(init.headers['X-Snowflake-Authorization-Token-Type']).toBe('PROGRAMMATIC_ACCESS_TOKEN');
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(JSON.parse(init.body)).toEqual({ statement: 'CREATE ROLE AR_A;' });
    expect(init.dispatcher).toBeDefined();
  });

  it('reports a body that is not JSON by its status and first bytes', async () => {
    fetchMock.mockResolvedValue(new Response('<html>proxy refused</html>', { status: 407 }));
    const api = await sqlApiFor(EXECUTE);
    expect(await api('GET', '/api/v2/statements/h', {})).toEqual({
      status: 407,
      body: { message: '<html>proxy refused</html>' },
    });
  });
});
