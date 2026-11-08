import { describe, expect, it } from 'vitest';

import { carriesAgentIdentity, hostReachableProxy } from './onecli-agent-proxy.js';

describe('carriesAgentIdentity', () => {
  // The gateway picks WHICH credentials to inject from the identity in the
  // proxy URL's userinfo. The host's own HTTPS_PROXY has none, so it resolves
  // to the Default Agent — which does not hold the workgroup-scoped Linear
  // secret. That is 686 consecutive 401s on one install.
  it('accepts the container-style URL that actually carries an identity', () => {
    expect(carriesAgentIdentity('http://x:aoc_deadbeef@host.docker.internal:10255')).toBe(true);
  });

  it('rejects the bare host proxy URL, which silently means Default Agent', () => {
    expect(carriesAgentIdentity('http://127.0.0.1:10255')).toBe(false);
  });

  it('is not fooled by an @ that appears after the host', () => {
    // Without anchoring the userinfo before the first slash, a path containing
    // @ would read as an identity and we would send an unauthenticated request
    // believing it was scoped.
    expect(carriesAgentIdentity('http://127.0.0.1:10255/path@notuserinfo')).toBe(false);
  });

  it('rejects empty input rather than throwing', () => {
    expect(carriesAgentIdentity('')).toBe(false);
  });
});

describe('hostReachableProxy', () => {
  // getContainerConfig answers with the URL a CONTAINER would use. Using it
  // verbatim on the host fails as a bare "fetch failed" with no mention of
  // proxies, which is a miserable thing to debug.
  const container = 'http://x:aoc_token@host.docker.internal:10255';

  it('keeps the agent identity but takes the address from the host proxy', () => {
    expect(hostReachableProxy(container, { HTTPS_PROXY: 'http://127.0.0.1:10255' })).toBe(
      'http://x:aoc_token@127.0.0.1:10255',
    );
  });

  it('does not inherit the host proxy identity, only its address', () => {
    // The host's own proxy resolves to the Default Agent. Carrying its
    // userinfo across would silently undo the whole fix.
    expect(hostReachableProxy(container, { HTTPS_PROXY: 'http://x:someothertoken@127.0.0.1:10255' })).toBe(
      'http://x:aoc_token@127.0.0.1:10255',
    );
  });

  it('leaves the URL alone when no host proxy is configured', () => {
    expect(hostReachableProxy(container, {})).toBe(container);
  });

  it('leaves an identity-less URL alone rather than inventing one', () => {
    expect(hostReachableProxy('http://host.docker.internal:10255', { HTTPS_PROXY: 'http://127.0.0.1:10255' })).toBe(
      'http://host.docker.internal:10255',
    );
  });
});
