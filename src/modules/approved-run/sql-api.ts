/**
 * Snowflake SQL API over the OneCLI gateway, as one OneCLI agent. The host never holds the token: the gateway
 * injects `Authorization: Bearer <token>` for the agent the proxy URL names, so a request reaches Snowflake
 * authenticated only when that agent holds the secret.
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';

import { agentProxyUrl } from '../../onecli-agent-proxy.js';
import type { ExecuteConfig } from './targets.js';

export interface SqlApiResponse {
  status: number;
  body: Record<string, unknown>;
}

export type SqlApi = (
  method: 'GET' | 'POST',
  path: string,
  query: Record<string, string>,
  body?: Record<string, unknown>,
) => Promise<SqlApiResponse>;

const REQUEST_TIMEOUT_MS = 120_000;

export async function sqlApiFor(execute: ExecuteConfig): Promise<SqlApi> {
  const dispatcher = new ProxyAgent(await agentProxyUrl(execute.onecliAgent));
  const origin = `https://${execute.account}.snowflakecomputing.com`;
  return async (method, path, query, body) => {
    const url = new URL(path, origin);
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    const res = await undiciFetch(url, {
      method,
      dispatcher,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'User-Agent': 'nanoclaw-approved-run/1',
        'X-Snowflake-Authorization-Token-Type': 'PROGRAMMATIC_ACCESS_TOKEN',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : {};
      // eslint-disable-next-line no-catch-all/no-catch-all -- a non-JSON body (a proxy error page) is reported by status
    } catch {
      parsed = { message: text.slice(0, 200) };
    }
    return {
      status: res.status,
      body: parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {},
    };
  };
}
