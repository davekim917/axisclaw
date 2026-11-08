/**
 * Approved-run targets — installation config, never in the repo.
 *
 * `data/approved-run/targets.json` names each system an agent may propose a
 * privileged file for: who may propose it, who may approve it, the pinned
 * classifier that reads the file, and how an approved file runs. Read fresh on
 * every request; a missing or malformed file means no targets.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_DIR } from '../../config.js';
import { isReservedAgent, reservedTokenName } from '../../reserved-secrets.js';

export const APPROVED_RUN_DIR = path.join(DATA_DIR, 'approved-run');
const TARGETS_PATH = path.join(APPROVED_RUN_DIR, 'targets.json');

interface Common {
  id: string;
  label: string;
  agentGroups: string[];
  approvers: string[];
  /**
   * sha256 of this target's entry exactly as the file holds it. A card binds this, not the parsed target, so a host
   * deploy that changes how entries are parsed leaves open cards valid; editing the entry voids them.
   */
  entrySha: string;
}

interface TargetBase extends Common {
  kind: 'snowflake';
  /** Roles a file may switch to with USE ROLE; the classifier denies any other. */
  allowedRoles: string[];
  /** The role every step runs as until the file's own USE ROLE; no step falls back to the connection's role. */
  defaultRole: string;
  /** `snowRoot` is the snow install the classifier pins; it is passed to the classifier, never written into it. */
  classifier: { path: string; sha256: string; snowRoot: string };
  /** `DB.SCHEMA` names a file may create tables or views in, or merge into; none means no such statement. */
  schemas: string[];
  /** `owner/name` on GitHub where proposed files are merged; a file whose card links its source needs it. */
  repo: string | null;
}

export interface ExecuteConfig {
  /** Account identifier in the URL: `https://<account>.snowflakecomputing.com`. */
  account: string;
  /** The service user the token belongs to; every run first checks the session is this user. */
  user: string;
  /** Vault secret holding the user's role-restricted token: always `<onecliAgent> token`, which reserves it. */
  secret: string;
  /** An `approved-run-*` agent, the only one that may hold `secret`; the host makes every call as this agent. */
  onecliAgent: string;
  /** Warehouse for the identity check, when the account needs one; null leaves the user's default. */
  warehouse: string | null;
}

export type SnowflakeTarget = TargetBase & { mode: 'execute'; execute: ExecuteConfig };

export interface RenderResource {
  label: string;
  /** Env keys whose values may be shown in plaintext, on env reads and on env-write cards; every other value is masked. */
  plaintextEnv: string[];
}

export interface RenderExecuteConfig {
  /** Vault secret holding the Admin user's API key: always `<onecliAgent> token`, which reserves it. */
  secret: string;
  onecliAgent: string;
  /** The Render user (`usr-…`) the key must belong to; every run checks `GET /v1/users` against it first. */
  adminUserId: string;
}

/** The host sends one structured Render API request per approval, as the target's reserved Admin identity. */
export interface RenderTarget extends Common {
  kind: 'render';
  mode: 'execute';
  execute: RenderExecuteConfig;
  /** The only resource ids a request may name, keyed by id. */
  resources: Record<string, RenderResource>;
}

/** Where a repository keeps its migration tooling; every path is relative to the repository root. */
interface MigrateLayout {
  /** The apply script, run as `<applyScript> apply --target <database> --migration <stem> --file <path> --sha256 <hex>`. */
  applyScript: string;
  /** Extracted from the migrations' commit for the apply script to run: it and everything it imports. */
  extract: string[];
  /** Files whose change since the last approved run the card warns about, since they run with the database password. */
  watched: string[];
  /**
   * The module exporting `approvedRunFacts({ root, files, folders })`, which answers per file
   * `{ refuse: string | null, classes: [{ name, why }], irreversible: string[] }`. Extracted with `extract`.
   */
  factsModule: string;
}

/** The host runs numbered migration files with the repository's own apply script, both read from one verified commit. */
export interface MigrateTarget extends Common {
  kind: 'repo-migrate';
  mode: 'execute';
  /** `owner/name` on GitHub. */
  repo: string;
  layout: MigrateLayout;
  /** Apply-script targets a card may select: all production names or all `-dev` names, never a mix. */
  databases: string[];
  /** The folder each database's numbered files come from. */
  folders: Record<string, string>;
  /** Databases whose files the facts module applies the repository's own refusal rules to. */
  checked: string[];
  /** The Render Postgres instance each database is; the host fetches only its connection details. */
  postgresIds: Record<string, string>;
  /** Another migration target whose last approved run a card compares with while this one has none of its own. */
  compareWith?: string;
  /**
   * The reserved identity the host reads each database's connection details as. Each holds a Render key as
   * `<onecliAgent> token`; it never enters a sandbox.
   */
  execute: { agents: Record<string, { secret: string; onecliAgent: string }> };
}

export type ApprovedRunTarget = SnowflakeTarget | RenderTarget | MigrateTarget;

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const ROLE_RE = /^[A-Z][A-Z0-9_$]{0,254}$/;
const USER_ID_RE = /^[^:\s]+:\S+$/;
const ACCOUNT_RE = /^[a-z0-9][a-z0-9_-]{0,127}$/;
const RENDER_RESOURCE_RE = /^(srv|crn|dpg|red)-[a-z0-9]{16,32}(-a)?$/;
const RENDER_USER_RE = /^usr-[a-z0-9]{16,32}$/;
export const REL_PATH_RE = /^(?!.*(^|\/)\.\.?(\/|$))[A-Za-z0-9._-]+(\/[A-Za-z0-9._-]+)*$/;
const POSTGRES_ID_RE = /^dpg-[a-z0-9]{16,32}(-a)?$/;
const DATABASE_RE = /^[a-z][a-z0-9-]{0,31}$/;
const SCHEMA_RE = /^[A-Z_][A-Z0-9_$]{0,254}\.[A-Z_][A-Z0-9_$]{0,254}$/;
const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

function parseExecute(raw: unknown): ExecuteConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.account !== 'string' || !ACCOUNT_RE.test(e.account)) return null;
  if (typeof e.user !== 'string' || !ROLE_RE.test(e.user)) return null;
  if (typeof e.onecliAgent !== 'string' || !isReservedAgent(e.onecliAgent)) return null;
  const warehouse = e.warehouse ?? null;
  if (warehouse !== null && (typeof warehouse !== 'string' || !ROLE_RE.test(warehouse))) return null;
  return {
    account: e.account,
    user: e.user,
    secret: reservedTokenName(e.onecliAgent),
    onecliAgent: e.onecliAgent,
    warehouse,
  };
}

function stringList(value: unknown, re: RegExp): string[] | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.every((v) => typeof v === 'string' && re.test(v)) ? (value as string[]) : null;
}

function parseRender(common: Common, t: Record<string, unknown>): RenderTarget | { error: string } {
  const at = (field: string) => ({ error: `target ${common.id}: ${field} is invalid` });
  if (t.mode !== 'execute') return at('mode');
  const e = t.execute as Record<string, unknown> | undefined;
  if (!e || typeof e.onecliAgent !== 'string' || !isReservedAgent(e.onecliAgent)) return at('execute');
  if (typeof e.adminUserId !== 'string' || !RENDER_USER_RE.test(e.adminUserId)) return at('execute');
  const raw = t.resources;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length === 0) return at('resources');
  const resources: Record<string, RenderResource> = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const r = value as Record<string, unknown> | null;
    if (!RENDER_RESOURCE_RE.test(id) || !r || typeof r !== 'object') return at('resources');
    if (typeof r.label !== 'string' || !r.label.trim() || r.label.length > 60) return at('resources');
    const plaintextEnv =
      Array.isArray(r.plaintextEnv) && r.plaintextEnv.length === 0 ? [] : stringList(r.plaintextEnv, ENV_KEY_RE);
    if (!plaintextEnv) return at('resources');
    resources[id] = { label: r.label.trim(), plaintextEnv };
  }
  return {
    ...common,
    kind: 'render',
    mode: 'execute',
    execute: { secret: reservedTokenName(e.onecliAgent), onecliAgent: e.onecliAgent, adminUserId: e.adminUserId },
    resources,
  };
}

function relPaths(raw: unknown): string[] | null {
  return Array.isArray(raw) && raw.length > 0 && raw.every((p) => typeof p === 'string' && REL_PATH_RE.test(p))
    ? (raw as string[])
    : null;
}

function parseLayout(raw: unknown): MigrateLayout | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const l = raw as Record<string, unknown>;
  const one = (v: unknown) => (typeof v === 'string' && REL_PATH_RE.test(v) ? v : null);
  const applyScript = one(l.applyScript);
  const factsModule = one(l.factsModule);
  const extract = relPaths(l.extract);
  const watched = relPaths(l.watched);
  if (!applyScript || !factsModule || !extract || !watched) return null;
  return { applyScript, extract, watched, factsModule };
}

function parseMigrate(common: Common, t: Record<string, unknown>): MigrateTarget | { error: string } {
  const at = (field: string) => ({ error: `target ${common.id}: ${field} is invalid` });
  if (t.mode !== 'execute') return at('mode');
  if (typeof t.repo !== 'string' || !REPO_RE.test(t.repo)) return at('repo');
  const layout = parseLayout(t.layout);
  if (!layout) return at('layout');
  const raw = t.databases;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return at('databases');
  const databases = Object.keys(raw);
  if (databases.length === 0 || !databases.every((d) => DATABASE_RE.test(d))) return at('databases');
  const dev = databases.filter((d) => d.endsWith('-dev')).length;
  if (dev !== 0 && dev !== databases.length) return at('databases');
  if (
    t.compareWith !== undefined &&
    (typeof t.compareWith !== 'string' || !ID_RE.test(t.compareWith) || t.compareWith === common.id)
  ) {
    return at('compareWith');
  }
  const folders: Record<string, string> = {};
  const checked: string[] = [];
  const postgresIds: Record<string, string> = {};
  const agents: MigrateTarget['execute']['agents'] = {};
  for (const db of databases) {
    const d = (raw as Record<string, unknown>)[db] as Record<string, unknown> | null;
    if (!d || typeof d !== 'object' || Object.keys(d).sort().join(',') !== 'checked,folder,onecliAgent,postgresId') {
      return at(`databases.${db}`);
    }
    if (typeof d.folder !== 'string' || !REL_PATH_RE.test(d.folder) || typeof d.checked !== 'boolean') {
      return at(`databases.${db}`);
    }
    if (typeof d.onecliAgent !== 'string' || !isReservedAgent(d.onecliAgent)) return at(`databases.${db}`);
    if (typeof d.postgresId !== 'string' || !POSTGRES_ID_RE.test(d.postgresId)) return at(`databases.${db}`);
    folders[db] = d.folder;
    postgresIds[db] = d.postgresId;
    if (d.checked) checked.push(db);
    agents[db] = { secret: reservedTokenName(d.onecliAgent), onecliAgent: d.onecliAgent };
  }
  return {
    ...common,
    kind: 'repo-migrate',
    mode: 'execute',
    repo: t.repo,
    layout,
    databases,
    folders,
    checked,
    postgresIds,
    ...(typeof t.compareWith === 'string' ? { compareWith: t.compareWith } : {}),
    execute: { agents },
  };
}

function parseTarget(raw: unknown): ApprovedRunTarget | { error: string } {
  if (!raw || typeof raw !== 'object') return { error: 'target is not an object' };
  const t = raw as Record<string, unknown>;
  if (typeof t.id !== 'string' || !ID_RE.test(t.id)) return { error: 'target id is invalid' };
  const at = (field: string) => ({ error: `target ${t.id}: ${field} is invalid` });
  if (typeof t.label !== 'string' || !t.label.trim() || t.label.length > 60) return at('label');
  const agentGroups = stringList(t.agentGroups, /^\S{1,128}$/);
  if (!agentGroups) return at('agentGroups');
  const approvers = stringList(t.approvers, USER_ID_RE);
  if (!approvers) return at('approvers');
  const common: Common = {
    id: t.id,
    label: t.label.trim(),
    agentGroups,
    approvers,
    entrySha: createHash('sha256').update(JSON.stringify(raw)).digest('hex'),
  };
  if (t.kind === 'render') return parseRender(common, t);
  if (t.kind === 'repo-migrate') return parseMigrate(common, t);
  if (t.kind !== 'snowflake') return at('kind');
  const allowedRoles =
    Array.isArray(t.allowedRoles) && t.allowedRoles.length === 0 ? [] : stringList(t.allowedRoles, ROLE_RE);
  if (!allowedRoles) return at('allowedRoles');
  if (allowedRoles.some((r) => r === 'ACCOUNTADMIN' || r === 'ORGADMIN')) return at('allowedRoles');
  if (
    typeof t.defaultRole !== 'string' ||
    !ROLE_RE.test(t.defaultRole) ||
    t.defaultRole === 'ACCOUNTADMIN' ||
    t.defaultRole === 'ORGADMIN'
  ) {
    return at('defaultRole');
  }
  const c = t.classifier as Record<string, unknown> | undefined;
  if (
    !c ||
    typeof c.path !== 'string' ||
    !path.isAbsolute(c.path) ||
    typeof c.sha256 !== 'string' ||
    !SHA_RE.test(c.sha256) ||
    typeof c.snowRoot !== 'string' ||
    !path.isAbsolute(c.snowRoot)
  ) {
    return at('classifier');
  }
  const schemas = t.schemas === undefined ? [] : stringList(t.schemas, SCHEMA_RE);
  if (!schemas) return at('schemas');
  if (t.repo !== undefined && (typeof t.repo !== 'string' || !REPO_RE.test(t.repo))) return at('repo');
  const base: TargetBase = {
    ...common,
    kind: 'snowflake',
    allowedRoles,
    defaultRole: t.defaultRole,
    classifier: { path: c.path, sha256: c.sha256, snowRoot: c.snowRoot },
    schemas,
    repo: typeof t.repo === 'string' ? t.repo : null,
  };
  if (t.mode !== 'execute') return at('mode');
  const execute = parseExecute(t.execute);
  return execute ? { ...base, mode: 'execute', execute } : at('execute');
}

export function loadTarget(id: string, targetsPath: string = TARGETS_PATH): ApprovedRunTarget | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(targetsPath, 'utf8'));
    // eslint-disable-next-line no-catch-all/no-catch-all -- a missing or unreadable config means no targets, reported to the agent
  } catch {
    return { error: 'no approved-run targets are configured on this host' };
  }
  const list = (raw as { targets?: unknown } | null)?.targets;
  if (!Array.isArray(list)) return { error: 'approved-run targets config is malformed' };
  const match = list.find((t) => (t as { id?: unknown } | null)?.id === id);
  if (!match) return { error: `unknown approved-run target "${id}"` };
  return parseTarget(match);
}

/** Every valid target in the config; unreadable or invalid entries are skipped. */
function validTargets(targetsPath: string): ApprovedRunTarget[] {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(targetsPath, 'utf8'));
    // eslint-disable-next-line no-catch-all/no-catch-all -- a missing or unreadable config means no targets
  } catch {
    return [];
  }
  const list = (raw as { targets?: unknown } | null)?.targets;
  if (!Array.isArray(list)) return [];
  return list.map(parseTarget).filter((t): t is ApprovedRunTarget => !('error' in t));
}

/** Every Render target that lists this agent group. */
export function renderTargetsFor(agentGroupId: string, targetsPath: string = TARGETS_PATH): RenderTarget[] {
  return validTargets(targetsPath).filter(
    (t): t is RenderTarget => t.kind === 'render' && t.agentGroups.includes(agentGroupId),
  );
}

/**
 * The reserved identities a target runs as, each with the token it must hold alone. For a migration, `databases`
 * narrows it to the identities of those databases; a name the target doesn't configure contributes none.
 */
export function laneIdentities(
  target: ApprovedRunTarget,
  databases?: readonly unknown[],
): Array<{ secret: string; onecliAgent: string }> {
  if (target.kind !== 'repo-migrate')
    return [{ secret: target.execute.secret, onecliAgent: target.execute.onecliAgent }];
  const byAgent = new Map<string, { secret: string; onecliAgent: string }>();
  for (const db of databases ?? Object.keys(target.execute.agents)) {
    if (typeof db !== 'string' || !Object.hasOwn(target.execute.agents, db)) continue;
    const identity = target.execute.agents[db];
    byAgent.set(identity.onecliAgent, identity);
  }
  return [...byAgent.values()];
}

/** Every target that runs as this reserved identity. */
export function targetsUsing(agent: string, targetsPath: string = TARGETS_PATH): ApprovedRunTarget[] {
  return validTargets(targetsPath).filter((t) => laneIdentities(t).some((i) => i.onecliAgent === agent));
}
