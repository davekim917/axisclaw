import { OneCLI } from '@onecli-sh/sdk';

import { ONECLI_API_KEY, ONECLI_URL } from './config.js';

/** A URL without userinfo resolves to the Default Agent at the gateway, which holds no group-scoped credentials. */
export function carriesAgentIdentity(proxyUrl: string): boolean {
  return /^\w+:\/\/[^@/]+@/.test(proxyUrl);
}

/**
 * Keep the agent identity, swap in the host's own proxy address: `getContainerConfig` returns the container's
 * (`host.docker.internal`), which does not resolve from the host.
 */
export function hostReachableProxy(containerProxyUrl: string, env: NodeJS.ProcessEnv = process.env): string {
  const userinfo = /^\w+:\/\/([^@/]+)@/.exec(containerProxyUrl)?.[1];
  if (!userinfo) return containerProxyUrl;
  const hostProxy = env['HTTPS_PROXY'] || env['https_proxy'] || env['HTTP_PROXY'] || env['http_proxy'] || '';
  const hostPart = /^(\w+):\/\/(?:[^@/]+@)?([^/]+)/.exec(hostProxy);
  // Better to try the container URL than silently drop to the Default Agent.
  if (!hostPart) return containerProxyUrl;
  return `${hostPart[1]}://${userinfo}@${hostPart[2]}`;
}

/**
 * The gateway proxy URL, reachable from the host, that makes a host request as this OneCLI agent, so the gateway
 * injects only that agent's credentials. Throws when the gateway gives no identity-carrying URL.
 */
export async function agentProxyUrl(identifier: string): Promise<string> {
  const cfg = await new OneCLI({ url: ONECLI_URL, apiKey: ONECLI_API_KEY, timeout: 30_000 }).getContainerConfig({
    agent: identifier,
  });
  const url = cfg.env['HTTPS_PROXY'] || cfg.env['https_proxy'] || '';
  if (!url || !carriesAgentIdentity(url)) throw new Error(`OneCLI gave no proxy identity for agent ${identifier}`);
  return hostReachableProxy(url);
}
