import { beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));
vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: fetchMock,
}));
vi.mock('../../onecli-agent-proxy.js', () => ({
  agentProxyUrl: vi.fn(async (agent: string) => `http://x:token-of-${agent}@127.0.0.1:10255`),
}));

import { renderApiFor } from './render-api.js';

beforeEach(() => fetchMock.mockReset());

describe('renderApiFor', () => {
  it('sends one request to api.render.com through the agent proxy, leaving Authorization to the gateway', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ key: 'A', value: 'on' }), { status: 200 }));
    const api = await renderApiFor('approved-run-acme-render');
    const res = await api('PUT', '/v1/services/srv-a/env-vars/A', { value: 'on' });

    expect(res).toEqual({ status: 200, body: { key: 'A', value: 'on' } });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [
      URL,
      { method: string; headers: Record<string, string>; body: string; dispatcher: unknown },
    ];
    expect(String(url)).toBe('https://api.render.com/v1/services/srv-a/env-vars/A');
    expect(init.method).toBe('PUT');
    expect(init.headers['Content-Type']).toBe('application/json');
    expect(Object.keys(init.headers).map((h) => h.toLowerCase())).not.toContain('authorization');
    expect(JSON.parse(init.body)).toEqual({ value: 'on' });
    expect(init.dispatcher).toBeDefined();
    expect((init as { redirect?: string }).redirect).toBe('manual');
  });

  it('sends no body or content type for a bodiless request, and reports a non-JSON answer by status', async () => {
    fetchMock.mockResolvedValue(new Response('<html>proxy refused</html>', { status: 407 }));
    const api = await renderApiFor('approved-run-acme-render');
    expect(await api('DELETE', '/v1/services/srv-a/env-vars/A')).toEqual({
      status: 407,
      body: { message: '<html>proxy refused</html>' },
    });
    const [, init] = fetchMock.mock.calls[0] as [URL, { headers: Record<string, string>; body?: string }];
    expect(init.body).toBeUndefined();
    expect(init.headers['Content-Type']).toBeUndefined();
  });

  it('reads an empty answer as a null body', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    const api = await renderApiFor('approved-run-acme-render');
    expect(await api('DELETE', '/v1/services/srv-a/env-vars/A')).toEqual({ status: 204, body: null });
  });
});
