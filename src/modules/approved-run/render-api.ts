/**
 * Render's REST API over the OneCLI gateway, as one OneCLI agent. The host never holds the key: the gateway injects
 * it for the agent the proxy URL names. Each call is one request; nothing here resends, because a Render write is
 * not idempotent and a second send of an env-var change or a job is a second change.
 */
import { ProxyAgent, fetch as undiciFetch } from 'undici';

import { agentProxyUrl } from '../../onecli-agent-proxy.js';

export interface RenderApiResponse {
  status: number;
  body: unknown;
}

export type RenderApi = (method: string, path: string, body?: unknown) => Promise<RenderApiResponse>;

const ORIGIN = 'https://api.render.com';
const REQUEST_TIMEOUT_MS = 60_000;

export async function renderApiFor(onecliAgent: string): Promise<RenderApi> {
  const dispatcher = new ProxyAgent(await agentProxyUrl(onecliAgent));
  return async (method, path, body) => {
    const res = await undiciFetch(new URL(path, ORIGIN), {
      method,
      dispatcher,
      headers: {
        Accept: 'application/json',
        'User-Agent': 'nanoclaw-approved-run/1',
        ...(body === undefined || body === null ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      // A followed 307/308 would resend the write to a path the validator never judged.
      redirect: 'manual',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : null;
      // eslint-disable-next-line no-catch-all/no-catch-all -- a non-JSON body (a proxy error page) is reported by status
    } catch {
      parsed = { message: text.slice(0, 200) };
    }
    return { status: res.status, body: parsed };
  };
}
