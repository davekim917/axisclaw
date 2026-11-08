/**
 * Per-group OneCLI secret scoping: `container.json`'s `onecliSecrets` (names or UUIDs) is resolved and the agent's
 * grants reconciled to exactly that set on every spawn. Fail-closed: an unresolvable name throws.
 *
 * Uses the gateway API directly: the SDK has no list/grant operations, and the CLI's list output caps at 20 rows
 * with no pagination.
 */
import { execFile } from 'child_process';

import { ONECLI_API_BASE } from './config.js';
import { log } from './log.js';
import { isReservedAgent, reservedOwner, reservedTokenName } from './reserved-secrets.js';
import { onecliAuthConfigLine, sanitizeCurlFailure } from './onecli-curl.js';

interface OnecliAgent {
  id: string;
  identifier: string;
  name: string;
  secretMode?: string;
}

interface OnecliSecret {
  id: string;
  name: string;
  /** Where the gateway injects it; present on the list API's rows. */
  hostPattern?: string | null;
  pathPattern?: string | null;
}

interface OnecliAgentSecretGrant {
  secretId: string;
}

interface OnecliAgentGrants {
  agentId: string;
  mode: 'grants';
  connections: unknown[];
  secrets: OnecliAgentSecretGrant[];
}

export interface EnsureOnecliAgentInput {
  name: string;
  identifier: string;
}

export interface EnsureOnecliAgentResult extends EnsureOnecliAgentInput {
  created: boolean;
}

/** Agent identifier → UUID for the host's lifetime; a miss refreshes. */
const identifierToUuid = new Map<string, string>();

/** Anything not UUID-shaped is a secret NAME needing lookup. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CURL_TIMEOUT_ARGS = ['--connect-timeout', '2', '--max-time', '10'] as const;

function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * Promise-wrapped `execFile('curl', …)` so gateway round trips never block the event loop; `-f` keeps non-2xx a
 * rejection. Not `fetch`: host `fetch` must never traverse the OneCLI gateway proxy.
 *
 * Neither the API key nor execFile's error (whose message embeds the whole argv) may reach argv or a log: the key
 * goes on stdin as a curl config (`-K -`), and failures are rethrown as a sanitized `OnecliCurlError`. The cost is
 * that every non-2xx reads as curl exit 22, not its status.
 */
function curl(args: string[], label: string): Promise<string> {
  const auth = onecliAuthConfigLine();
  return new Promise((resolve, reject) => {
    const child = execFile('curl', auth ? ['-K', '-', ...args] : args, { encoding: 'utf-8' }, (error, stdout) => {
      if (error) {
        reject(sanitizeCurlFailure(label, error));
        return;
      }
      resolve(typeof stdout === 'string' ? stdout : String(stdout));
    });
    if (auth) {
      // An unhandled stream 'error' is an uncaught exception; the execFile callback reports the failure anyway.
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(auth);
    }
  });
}

/**
 * Vault secrets listing cache. A cached MISS is never final (`resolveSecretUuids` force-refreshes before
 * throwing). A cached HIT lasts the TTL: a renamed secret keeps resolving under its old name to the same UUID
 * until expiry. Nothing widens.
 */
const SECRETS_CACHE_TTL_MS = 60 * 1000;
let secretsCache: { at: number; secrets: OnecliSecret[] } | null = null;

/**
 * One shared in-flight listing per resource: a host restart wakes many groups with different identities at once,
 * and parallel `?limit=10000` listings can hit the curl timeout. A rejection fails every waiter and clears the
 * entry, so no caller proceeds on a listing that did not arrive.
 */
const inFlightListings = new Map<'agents' | 'secrets', Promise<unknown[]>>();

function listViaApiOnce(resource: 'agents' | 'secrets'): Promise<unknown[]> {
  const existing = inFlightListings.get(resource);
  if (existing) return existing;
  const tracked = listViaApi(resource).finally(() => {
    if (inFlightListings.get(resource) === tracked) inFlightListings.delete(resource);
  });
  inFlightListings.set(resource, tracked);
  return tracked;
}

/**
 * Serializes the read-modify-write grant reconcile per identity: two concurrent spawns with different
 * declarations could otherwise each write the union of both sets.
 */
const identityLocks = new Map<string, Promise<unknown>>();

async function withIdentityLock<T>(identity: string, fn: () => Promise<T>): Promise<T> {
  const previous = identityLocks.get(identity) ?? Promise.resolve();
  // Run whether the predecessor settled or threw, so one failure cannot wedge the next spawn.
  const run = previous.then(fn, fn);
  const guarded = run.then(
    () => undefined,
    () => undefined,
  );
  identityLocks.set(identity, guarded);
  try {
    return await run;
  } finally {
    // Drop only when nothing queued behind us.
    if (identityLocks.get(identity) === guarded) identityLocks.delete(identity);
  }
}

/** Full agents/secrets list from the gateway API (the CLI silently truncates at 20 rows, failing lookups closed). */
async function listViaApi(resource: 'agents' | 'secrets'): Promise<unknown[]> {
  const args = ['-fsS', ...CURL_TIMEOUT_ARGS, `${ONECLI_API_BASE}/v1/${resource}?limit=10000`];
  const out = await curl(args, `GET /v1/${resource}`);
  const parsed = JSON.parse(out) as unknown;
  if (Array.isArray(parsed)) return parsed;
  const data = (parsed as { data?: unknown }).data;
  return Array.isArray(data) ? data : [];
}

/** `curl -f`: every non-2xx rejects. Only UUIDs travel in URLs, never secret values. */
async function requestViaApi(method: 'GET' | 'PUT' | 'DELETE', path: string): Promise<unknown> {
  const args = ['-fsS', ...CURL_TIMEOUT_ARGS, '-X', method];
  args.push(`${ONECLI_API_BASE}/v1/${path.replace(/^\//, '')}`);
  const out = await curl(args, `${method} /v1/${path.replace(/^\//, '')}`);
  return out.trim() ? (JSON.parse(out) as unknown) : undefined;
}

/** Keeps the HTTP status so callers can tell a create-race 409 from every other failure. */
async function createAgentViaApi(input: EnsureOnecliAgentInput): Promise<{ status: number; body: unknown }> {
  const args = ['-sS', ...CURL_TIMEOUT_ARGS, '-X', 'POST', '-H', 'Content-Type: application/json'];
  args.push('--data-binary', JSON.stringify(input), '-w', '\n%{http_code}', `${ONECLI_API_BASE}/v1/agents`);

  const out = await curl(args, 'POST /v1/agents');
  const statusSeparator = out.lastIndexOf('\n');
  if (statusSeparator < 0) {
    throw new Error('Malformed OneCLI agent create response: missing HTTP status');
  }
  const status = Number(out.slice(statusSeparator + 1).trim());
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new Error('Malformed OneCLI agent create response: invalid HTTP status');
  }

  const bodyText = out.slice(0, statusSeparator).trim();
  let body: unknown;
  if (bodyText) {
    try {
      body = JSON.parse(bodyText) as unknown;
    } catch (error) {
      throw new Error(`Malformed OneCLI agent create response body (HTTP ${status})`, { cause: error });
    }
  }
  return { status, body };
}

async function getAgentGrants(agentUuid: string): Promise<OnecliAgentGrants> {
  const parsed = await requestViaApi('GET', `agents/${encodeURIComponent(agentUuid)}/grants`);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Malformed OneCLI grants response for agent ${agentUuid}`);
  }

  const grants = parsed as Partial<OnecliAgentGrants>;
  if (
    grants.agentId !== agentUuid ||
    grants.mode !== 'grants' ||
    !Array.isArray(grants.connections) ||
    !Array.isArray(grants.secrets) ||
    !grants.secrets.every(
      (secret) =>
        secret !== null &&
        typeof secret === 'object' &&
        typeof (secret as Partial<OnecliAgentSecretGrant>).secretId === 'string' &&
        isUuid((secret as OnecliAgentSecretGrant).secretId),
    )
  ) {
    throw new Error(`Malformed OneCLI grants response for agent ${agentUuid}`);
  }

  return grants as OnecliAgentGrants;
}

async function listAgents(force = false): Promise<OnecliAgent[]> {
  return (await (force ? listViaApi('agents') : listViaApiOnce('agents'))) as OnecliAgent[];
}

/** `fromCache` tells the caller whether a miss is worth re-checking before failing the spawn. */
async function loadSecrets(forceRefresh: boolean): Promise<{ secrets: OnecliSecret[]; fromCache: boolean }> {
  if (!forceRefresh && secretsCache && Date.now() - secretsCache.at < SECRETS_CACHE_TTL_MS) {
    return { secrets: secretsCache.secrets, fromCache: true };
  }
  // A forced refresh must NOT join an in-flight listing: one that began before the question could predate the
  // secret and manufacture the refusal this refresh exists to prevent.
  const secrets = (await (forceRefresh ? listViaApi('secrets') : listViaApiOnce('secrets'))) as OnecliSecret[];
  secretsCache = { at: Date.now(), secrets };
  return { secrets, fromCache: false };
}

/** `force` skips the shared listing: after a 409, only a listing that began after the create contains the agent. */
async function refreshAgentCache(options?: { force?: boolean }): Promise<void> {
  const agents = await listAgents(options?.force ?? false);
  const refreshed = new Map<string, string>();
  for (const agent of agents) {
    if (
      !agent ||
      typeof agent !== 'object' ||
      typeof agent.identifier !== 'string' ||
      !agent.identifier ||
      typeof agent.id !== 'string' ||
      !isUuid(agent.id)
    ) {
      throw new Error('Malformed OneCLI agents list response');
    }
    refreshed.set(agent.identifier, agent.id);
  }
  identifierToUuid.clear();
  for (const [identifier, uuid] of refreshed) identifierToUuid.set(identifier, uuid);
}

/** Refreshes on a miss; throws (fail-closed) when the identifier is still absent. */
async function resolveAgentUuid(identifier: string): Promise<string> {
  const cached = identifierToUuid.get(identifier);
  if (cached) return cached;

  // Replace the whole map so renamed/deleted agents are evicted.
  await refreshAgentCache();
  const refreshed = identifierToUuid.get(identifier);
  if (!refreshed) {
    throw new Error(
      `OneCLI agent with identifier "${identifier}" not found in vault — refusing to spawn without scoped credentials`,
    );
  }
  return refreshed;
}

/**
 * Create the agent only when a fresh list lacks it. A 409 counts as success only after a fresh list confirms the
 * agent; every other response fails closed. Serialized per identity.
 */
export function ensureOnecliAgent(input: EnsureOnecliAgentInput): Promise<EnsureOnecliAgentResult> {
  return withIdentityLock(input.identifier, () => ensureOnecliAgentLocked(input));
}

async function ensureOnecliAgentLocked(input: EnsureOnecliAgentInput): Promise<EnsureOnecliAgentResult> {
  if (identifierToUuid.has(input.identifier)) return { ...input, created: false };

  await refreshAgentCache();
  if (identifierToUuid.has(input.identifier)) return { ...input, created: false };

  const response = await createAgentViaApi(input);
  if (response.status === 409) {
    await refreshAgentCache({ force: true });
    if (!identifierToUuid.has(input.identifier)) {
      throw new Error(
        `OneCLI agent create returned HTTP 409 but identifier "${input.identifier}" was not found after refresh`,
      );
    }
    return { ...input, created: false };
  }
  if (response.status !== 201) {
    throw new Error(`OneCLI agent create failed with HTTP ${response.status}`);
  }

  const created = response.body as Partial<OnecliAgent> | undefined;
  if (!created || created.identifier !== input.identifier || typeof created.id !== 'string' || !isUuid(created.id)) {
    throw new Error(`Malformed OneCLI agent create response for identifier "${input.identifier}"`);
  }
  identifierToUuid.set(input.identifier, created.id);
  return { ...input, created: true };
}

/**
 * Identifiers of every agent the gateway would inject this secret for, read fresh. Throws (fail-closed) when the
 * secret is absent or any agent's grants are unreadable or in a mode other than explicit grants.
 */
export async function agentsHoldingSecret(secretName: string): Promise<string[]> {
  const ids = await secretIdsNamed(secretName);
  const holders: string[] = [];
  for (const agent of await listedAgents()) {
    if ((await effectiveSecrets(agent.id)).some((e) => ids.has(e.id))) holders.push(agent.identifier);
  }
  return holders;
}

/**
 * Every secret the gateway would inject for this agent, with the host it injects on, read fresh. One the vault no
 * longer lists comes back with no host; an agent OneCLI does not know holds nothing. Throws when the vault is unreadable.
 */
export async function secretsHeldBy(
  identifier: string,
): Promise<Array<{ id: string; name: string; hostPattern: string | null }>> {
  const agent = (await listedAgents()).find((a) => a.identifier === identifier);
  if (!agent) return [];
  const rows = (await loadSecrets(true)).secrets.filter((row) => typeof row === 'object' && row !== null);
  const ids = new Set((await effectiveSecrets(agent.id)).map((e) => e.id));
  return [...ids].map((id) => {
    const row = rows.find((r) => r.id === id);
    return { id, name: row?.name ?? '', hostPattern: typeof row?.hostPattern === 'string' ? row.hostPattern : null };
  });
}

/** Every vault UUID carrying `name`: a duplicate name must not leave one copy unwatched. Throws when there is none. */
async function secretIdsNamed(name: string): Promise<Set<string>> {
  const ids = new Set((await loadSecrets(true)).secrets.filter((s) => s.name === name).map((s) => s.id));
  if (ids.size === 0) throw new Error(`OneCLI secret(s) not found in vault: ${name}`);
  return ids;
}

async function listedAgents(): Promise<OnecliAgent[]> {
  const agents = await listAgents(true);
  for (const agent of agents) {
    if (!agent || typeof agent.identifier !== 'string' || typeof agent.id !== 'string' || !isUuid(agent.id)) {
      throw new Error('Malformed OneCLI agents list response');
    }
  }
  return agents;
}

/**
 * The secrets the gateway would inject for this agent, from the rule reflection that mirrors injection: every
 * enabled allow rule naming the agent, whatever its source, with pool rules expanded. `/grants` lists only one kind
 * of rule, so it cannot answer who holds a secret. Each entry carries the rules granting it.
 */
async function effectiveSecrets(agentUuid: string): Promise<Array<{ id: string; via: string }>> {
  const parsed = await requestViaApi('GET', `agents/${encodeURIComponent(agentUuid)}/effective-credentials`);
  const secrets = (parsed as { secrets?: unknown } | undefined)?.secrets;
  if (!Array.isArray(secrets))
    throw new Error(`Malformed OneCLI effective-credentials response for agent ${agentUuid}`);
  return secrets.map((raw) => {
    const e = raw as { id?: unknown; provenance?: unknown };
    if (typeof e?.id !== 'string') {
      throw new Error(`Malformed OneCLI effective-credentials response for agent ${agentUuid}`);
    }
    const rules = Array.isArray(e.provenance)
      ? e.provenance.map((p) => {
          const name = (p as { rule?: { name?: unknown } })?.rule?.name;
          return typeof name === 'string' ? `rule "${name}"` : 'an organization rule';
        })
      : [];
    return { id: e.id, via: rules.length ? rules.join(', ') : 'an unnamed rule' };
  });
}

/** Names (case-sensitive) or UUIDs (presence-checked) → UUIDs. Any unresolved declaration throws. */
export async function resolveSecretUuids(declarations: string[]): Promise<string[]> {
  if (declarations.length === 0) return [];

  const first = await loadSecrets(false);
  let match = matchDeclarations(first.secrets, declarations);

  // A miss against the cache may be a newly added secret: re-read before refusing.
  if (match.unresolved.length > 0 && first.fromCache) {
    const fresh = await loadSecrets(true);
    match = matchDeclarations(fresh.secrets, declarations);
  }

  if (match.unresolved.length > 0) {
    throw new Error(
      `OneCLI secret(s) not found in vault: ${match.unresolved.join(', ')} — ` +
        `check spelling, that the secret exists, and that 'onecli secrets list' returns it`,
    );
  }

  return match.resolved;
}

function matchDeclarations(
  secrets: OnecliSecret[],
  declarations: string[],
): { resolved: string[]; unresolved: string[] } {
  const nameToId = new Map(secrets.map((s) => [s.name, s.id] as const));
  const idSet = new Set(secrets.map((s) => s.id));

  const resolved: string[] = [];
  const unresolved: string[] = [];

  for (const decl of declarations) {
    if (isUuid(decl)) {
      if (idSet.has(decl)) {
        resolved.push(decl);
      } else {
        unresolved.push(decl);
      }
      continue;
    }
    const id = nameToId.get(decl);
    if (id) {
      resolved.push(id);
    } else {
      unresolved.push(decl);
    }
  }

  return { resolved, unresolved };
}

/**
 * Reconcile the agent's secret grants to `declarations` (no-op when empty). Spawn callers MUST await it (tripwire
 * in `onecli-secrets.test.ts`). Connection grants are left untouched.
 */
export function applyOnecliSecrets(agentIdentifier: string, declarations: string[] | undefined): Promise<void> {
  if (!declarations || declarations.length === 0) return Promise.resolve();
  return withIdentityLock(agentIdentifier, () => applyOnecliSecretsLocked(agentIdentifier, declarations));
}

/** Adds one secret grant to an agent and leaves every grant it already holds; a reserved token goes only to its agent. */
export function grantOnecliSecretToAgent(agentIdentifier: string, secret: { id: string; name: string }): Promise<void> {
  return withIdentityLock(agentIdentifier, async () => {
    assertSecretNotReserved(secret.name, agentIdentifier);
    const agentUuid = await resolveAgentUuid(agentIdentifier);
    const grants = await getAgentGrants(agentUuid);
    if (grants.secrets.some((granted) => granted.secretId === secret.id)) return;
    await requestViaApi(
      'PUT',
      `agents/${encodeURIComponent(agentUuid)}/grants/secrets/${encodeURIComponent(secret.id)}`,
    );
  });
}

/** Every vault UUID whose name reserves it, to the one agent it belongs to. */
async function reservedSecretOwners(): Promise<Map<string, { secret: string; owner: string }>> {
  const { secrets } = await loadSecrets(false);
  return new Map(
    secrets.flatMap((s) => {
      const owner = reservedOwner(s.name);
      return owner ? [[s.id, { secret: s.name, owner }] as const] : [];
    }),
  );
}

/** Throws when `secretName` is a reserved token and `agentIdentifier` is not its agent. */
export function assertSecretNotReserved(secretName: string, agentIdentifier: string | null): void {
  const owner = reservedOwner(secretName);
  if (owner && owner !== agentIdentifier) {
    throw new Error(`"${secretName}" is reserved to OneCLI agent ${owner} and cannot be granted elsewhere`);
  }
}

/** Throws when a container would run as a reserved agent, and so be injected its token. */
export function assertNotReservedIdentity(identifier: string | undefined): void {
  if (identifier && isReservedAgent(identifier)) {
    throw new Error(`OneCLI agent ${identifier} is reserved to the approved-run lane; no container may run as it`);
  }
}

/** Every reserved token in the vault, with its agent, read fresh. */
export async function reservedVaultSecrets(): Promise<Array<{ secret: string; owner: string }>> {
  const names = new Set((await loadSecrets(true)).secrets.map((s) => s.name));
  return [...names].flatMap((secret) => {
    const owner = reservedOwner(secret);
    return owner ? [{ secret, owner }] : [];
  });
}

/**
 * Secrets a reserved agent can be injected other than its own token, by name. Its token renamed out of the rule
 * shows up here, since the agent still holds it under a name the rule no longer covers.
 */
export async function reservedAgentStrays(): Promise<Array<{ agent: string; secret: string }>> {
  const byId = new Map((await loadSecrets(true)).secrets.map((s) => [s.id, s.name] as const));
  const strays: Array<{ agent: string; secret: string }> = [];
  for (const agent of await listedAgents()) {
    if (!isReservedAgent(agent.identifier)) continue;
    for (const e of await effectiveSecrets(agent.id)) {
      const name = byId.get(e.id) ?? e.id;
      if (name !== reservedTokenName(agent.identifier)) strays.push({ agent: agent.identifier, secret: name });
    }
  }
  return strays;
}

/**
 * Removes every grant of a reserved token but its owner's, then re-reads what the gateway would inject: a rule that
 * is not a single-secret grant (an equipment or custom rule, a whole-pool rule) cannot be removed here, so an agent
 * still holding it comes back as `unremovable`, with the rules that grant it. `beforeRevoke` hears each other holder
 * before its grant is deleted, and a throw from it leaves the grant in place, so an exposure is never removed without
 * first being recorded. Throws (fail-closed) when the vault cannot be read.
 */
export async function enforceReservedSecret(
  secretName: string,
  owner: string,
  beforeRevoke: (identifier: string) => void,
): Promise<{ removed: string[]; unremovable: Array<{ identifier: string; via: string }> }> {
  const ids = await secretIdsNamed(secretName);
  const removed: string[] = [];
  const unremovable: Array<{ identifier: string; via: string }> = [];
  for (const agent of await listedAgents()) {
    if (agent.identifier === owner) continue;
    if (!(await effectiveSecrets(agent.id)).some((e) => ids.has(e.id))) continue;
    const held = (await getAgentGrants(agent.id)).secrets.map((g) => g.secretId).filter((id) => ids.has(id));
    if (held.length) beforeRevoke(agent.identifier);
    for (const id of held) {
      await requestViaApi('DELETE', `agents/${encodeURIComponent(agent.id)}/grants/secrets/${encodeURIComponent(id)}`);
    }
    if (held.length) removed.push(agent.identifier);
    const still = (await effectiveSecrets(agent.id)).filter((e) => ids.has(e.id));
    if (still.length)
      unremovable.push({ identifier: agent.identifier, via: [...new Set(still.map((e) => e.via))].join(', ') });
  }
  return { removed, unremovable };
}

async function applyOnecliSecretsLocked(agentIdentifier: string, declarations: string[]): Promise<void> {
  const agentUuid = await resolveAgentUuid(agentIdentifier);
  const secretUuids = await resolveSecretUuids(declarations);
  const reserved = await reservedSecretOwners();
  for (const uuid of secretUuids) {
    const r = reserved.get(uuid);
    if (r && r.owner !== agentIdentifier) {
      throw new Error(
        `"${r.secret}" is reserved to OneCLI agent ${r.owner}; remove it from ${agentIdentifier}'s secrets`,
      );
    }
  }
  const grants = await getAgentGrants(agentUuid);
  const declaredSet = new Set(secretUuids);
  const grantedSet = new Set(grants.secrets.map((secret) => secret.secretId));
  const toRemove = [...grantedSet].filter((secretUuid) => !declaredSet.has(secretUuid));
  const toAdd = [...declaredSet].filter((secretUuid) => !grantedSet.has(secretUuid));

  // Remove before adding: a failed request aborts the spawn instead of leaving a broadened partial state.
  for (const secretUuid of toRemove) {
    await requestViaApi(
      'DELETE',
      `agents/${encodeURIComponent(agentUuid)}/grants/secrets/${encodeURIComponent(secretUuid)}`,
    );
  }
  for (const secretUuid of toAdd) {
    await requestViaApi(
      'PUT',
      `agents/${encodeURIComponent(agentUuid)}/grants/secrets/${encodeURIComponent(secretUuid)}`,
    );
  }

  log.info('OneCLI secrets applied', {
    agentIdentifier,
    agentUuid,
    declared: declarations.length,
    resolved: secretUuids.length,
    added: toAdd.length,
    removed: toRemove.length,
  });
}

/** Workgroup secrets first, then per-group additions. Union only: neither list can subtract from the other. */
export function mergeWorkgroupAndGroupSecrets(
  workgroupSecrets: string[] | undefined,
  groupSecrets: string[] | undefined,
): string[] {
  const set = new Set<string>();
  const ordered: string[] = [];
  for (const s of workgroupSecrets ?? []) {
    if (!set.has(s)) {
      set.add(s);
      ordered.push(s);
    }
  }
  for (const s of groupSecrets ?? []) {
    if (!set.has(s)) {
      set.add(s);
      ordered.push(s);
    }
  }
  return ordered;
}

/** The one host OpenCode's own providers (`opencode` Zen, `opencode-go` Go) are served from. */
const OPENCODE_SECRET_HOST = 'opencode.ai';

export interface SpawnSecrets {
  /** What the spawn grants: the union, holding at most one secret that injects on OPENCODE_SECRET_HOST. */
  secrets: string[];
  /** OpenCode secrets the union declared that lost to the one granted. */
  withheld: string[];
}

function findSecretRow(rows: readonly OnecliSecret[], declaration: string): OnecliSecret | undefined {
  return rows.find(
    (row) =>
      typeof row === 'object' &&
      row !== null &&
      (isUuid(declaration) ? row.id === declaration : row.name === declaration),
  );
}

function injectsOnOpenCode(row: OnecliSecret | undefined): boolean {
  return typeof row?.hostPattern === 'string' && row.hostPattern.trim().toLowerCase() === OPENCODE_SECRET_HOST;
}

/**
 * The workgroup ∪ group union, except that exactly one OpenCode secret survives: the group's own, else the
 * workgroup's, else `fleetOpenCodeSecret`. The gateway applies every granted secret whose host and path match, last
 * header write winning, over vault rows it reads in no defined order, so two would resolve arbitrarily. Within one
 * level the first declared wins, and a level that lists the fleet secret itself has not declared its own. A
 * declaration absent from the vault is left for `resolveSecretUuids` to refuse.
 */
export async function resolveSpawnSecrets(
  workgroupSecrets: string[] | undefined,
  groupSecrets: string[] | undefined,
  fleetOpenCodeSecret: string | undefined,
): Promise<SpawnSecrets> {
  const merged = mergeWorkgroupAndGroupSecrets(workgroupSecrets, groupSecrets);
  const configuredFleet = fleetOpenCodeSecret?.trim() || undefined;
  const declared = configuredFleet && !merged.includes(configuredFleet) ? [...merged, configuredFleet] : merged;
  // One group-level declaration cannot compete with another; a fleet default is always checked against the vault.
  if (configuredFleet === undefined && declared.length <= 1) return { secrets: declared, withheld: [] };

  const first = await loadSecrets(false);
  let rows = first.secrets;
  if (first.fromCache && declared.some((declaration) => findSecretRow(rows, declaration) === undefined)) {
    rows = (await loadSecrets(true)).secrets;
  }
  const isOpenCode = (declaration: string): boolean => injectsOnOpenCode(findSecretRow(rows, declaration));
  let fleet = configuredFleet;
  if (fleet !== undefined && !isOpenCode(fleet)) {
    log.error('NANOCLAW_OPENCODE_FLEET_SECRET is not a vault secret on opencode.ai; no fleet default granted', {
      fleetOpenCodeSecret: fleet,
    });
    fleet = undefined;
  }
  const fleetId = fleet === undefined ? undefined : (findSecretRow(rows, fleet)?.id ?? fleet);
  const isOwnOpenCode = (declaration: string): boolean =>
    isOpenCode(declaration) && declaration !== fleet && findSecretRow(rows, declaration)?.id !== fleetId;

  const openCodeSecret =
    (groupSecrets ?? []).find(isOwnOpenCode) ?? (workgroupSecrets ?? []).find(isOwnOpenCode) ?? fleet ?? null;
  const winnerId = openCodeSecret === null ? undefined : findSecretRow(rows, openCodeSecret)?.id;
  const loses = (declaration: string): boolean =>
    isOpenCode(declaration) && declaration !== openCodeSecret && findSecretRow(rows, declaration)?.id !== winnerId;

  const secrets = merged.filter((declaration) => !loses(declaration));
  if (openCodeSecret !== null && !secrets.includes(openCodeSecret)) secrets.push(openCodeSecret);
  return { secrets, withheld: merged.filter(loses) };
}

/**
 * Declarations that inject on the same host as another declaration, grouped by host. The gateway applies every
 * matching grant over rows it reads in no defined order, so two such grants resolve arbitrarily.
 */
export async function sharedHostSecrets(declarations: string[]): Promise<Array<{ host: string; secrets: string[] }>> {
  if (declarations.length < 2) return [];
  const first = await loadSecrets(false);
  let rows = first.secrets;
  if (first.fromCache && declarations.some((declaration) => findSecretRow(rows, declaration) === undefined)) {
    rows = (await loadSecrets(true)).secrets;
  }
  const byHost = new Map<string, Map<string, string>>();
  for (const declaration of declarations) {
    const row = findSecretRow(rows, declaration);
    const host = row?.hostPattern?.trim().toLowerCase();
    if (!row || !host) continue;
    const secrets = byHost.get(host) ?? new Map<string, string>();
    if (!secrets.has(row.id)) secrets.set(row.id, declaration);
    byHost.set(host, secrets);
  }
  return [...byHost]
    .filter(([, secrets]) => secrets.size > 1)
    .map(([host, secrets]) => ({ host, secrets: [...secrets.values()] }));
}

/**
 * The OneCLI secrets granting Slack USER-token access (the owner's DMs), withheld from sessions that are not
 * owner-safe (`isOwnerSafeSlackSession`). `explicitNames` is authoritative when given (case-insensitive
 * intersection); otherwise names containing both "slack" and "user", which excludes bot tokens. Returns names as
 * spelled in `secrets`.
 */
export function slackUserTokenSecrets(secrets: string[], explicitNames?: string[]): string[] {
  if (explicitNames && explicitNames.length > 0) {
    const wanted = new Set(explicitNames.map((n) => n.toLowerCase()));
    return secrets.filter((s) => wanted.has(s.toLowerCase()));
  }
  return secrets.filter((s) => {
    const lower = s.toLowerCase();
    return lower.includes('slack') && lower.includes('user');
  });
}

/**
 * Declared secrets injected into direct REST calls (not `mcp.*` hosts or `/mcp` paths), with the host they apply
 * to. Per-turn path, so it never blocks: reads the spawn cache and refreshes a stale one in the background; a cold
 * or failed cache yields [].
 */
export function gatewayRestHosts(declarations: string[]): Array<{ name: string; host: string }> {
  if (declarations.length === 0) return [];
  if (!secretsCache || Date.now() - secretsCache.at >= SECRETS_CACHE_TTL_MS) {
    void loadSecrets(false).catch(() => undefined);
  }
  // Cached rows are unvalidated; skip malformed ones rather than throw on the per-turn path.
  const secrets = (Array.isArray(secretsCache?.secrets) ? secretsCache.secrets : []).filter(
    (secret): secret is OnecliSecret =>
      typeof secret === 'object' && secret !== null && typeof secret.id === 'string' && typeof secret.name === 'string',
  );
  const byName = new Map(secrets.map((secret) => [secret.name, secret] as const));
  const byId = new Map(secrets.map((secret) => [secret.id, secret] as const));
  const out: Array<{ name: string; host: string }> = [];
  for (const decl of declarations) {
    const secret = isUuid(decl) ? byId.get(decl) : byName.get(decl);
    const host = typeof secret?.hostPattern === 'string' ? secret.hostPattern.trim() : '';
    if (!secret || !host) continue;
    const path = typeof secret.pathPattern === 'string' ? secret.pathPattern : '';
    if (/^mcp[.-]/i.test(host) || /(^|\/)mcp(\/|$)/i.test(path)) continue;
    out.push({ name: secret.name, host });
  }
  return out;
}

export function __setSecretsCacheForTest(secrets: OnecliSecret[]): void {
  secretsCache = { at: Date.now(), secrets };
}

export function __resetCachesForTest(): void {
  identifierToUuid.clear();
  secretsCache = null;
  identityLocks.clear();
  inFlightListings.clear();
}

export const __test = { isUuid, resolveAgentUuid };
