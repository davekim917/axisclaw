import { log } from '../../log.js';
import {
  applyOnecliSecrets,
  assertNotReservedIdentity,
  ensureOnecliAgent,
  sharedHostSecrets,
} from '../../onecli-secrets.js';

const PREVIEW_PROXY_ENV = 'PREVIEW_HTTPS_PROXY';

/**
 * Docker env handing a live preview's backend its own gateway identity, `<group>-preview`, granted exactly
 * `declarations`. The agent's own identity holds live keys, and a preview link is a bearer credential to that
 * backend. Returns nothing when none are declared or the identity cannot be set up, so a misdeclared preview list
 * leaves backends stubbed instead of refusing the agent's spawn.
 */
export async function previewProxyEnv(input: {
  agentIdentifier: string;
  groupName: string;
  declarations: string[] | undefined;
  getContainerConfig: (options: { agent: string }) => Promise<{ env: Record<string, string> }>;
}): Promise<string[]> {
  const declarations = input.declarations ?? [];
  if (declarations.length === 0) return [];
  const identity = `${input.agentIdentifier}-preview`;
  try {
    const conflicts = await sharedHostSecrets(declarations);
    if (conflicts.length > 0) {
      log.warn('Preview secrets not granted: two of them inject on the same host', { identity, conflicts });
      return [];
    }
    assertNotReservedIdentity(identity);
    await ensureOnecliAgent({ name: `${input.groupName} (live preview backend)`, identifier: identity });
    await applyOnecliSecrets(identity, declarations);
    const proxy = (await input.getContainerConfig({ agent: identity })).env.HTTPS_PROXY;
    if (!proxy) {
      log.warn('Preview gateway identity has no proxy address', { identity });
      return [];
    }
    return ['-e', `${PREVIEW_PROXY_ENV}=${proxy}`];
    // eslint-disable-next-line no-catch-all/no-catch-all -- an optional preview identity must never block a spawn; no proxy is the fail-closed outcome.
  } catch (err) {
    log.warn('Preview gateway identity not applied; preview backends run without credentials', {
      identity,
      err: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}
