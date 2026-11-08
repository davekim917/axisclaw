/**
 * Approved-run classification: facts from the target's pinned classifier,
 * tier from the one table below.
 *
 * The classifier is installation code, so the host verifies its sha256 before
 * every run and refuses on mismatch. It splits the file exactly as the run
 * will, and reports what each statement is and the session context it runs in;
 * this file decides what that means, so every target is tiered by the same
 * rules. The run executes the classifier's statements, never the raw file.
 */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

import { APPROVED_RUN_DIR, type SnowflakeTarget } from './targets.js';

const execFileAsync = promisify(execFile);
const CLASSIFIER_TIMEOUT_MS = 60_000;

type Tier = 'card' | 'deny';

export interface StatementFact {
  /** The exact statement as it will run: one request of the run. */
  text: string;
  kind: string;
  /** `dev` when every object it names resolves inside the target's dev database. */
  scope?: 'dev' | 'other' | 'none';
  /** Session context the statement runs in, from the file's USE statements; null leaves the connection's default. */
  role?: string | null;
  database?: string | null;
  schema?: string | null;
  warehouse?: string | null;
  /** Set by the classifier for a statement no approval may run. */
  deny?: string;
  grantee?: string | null;
  /** For a role grant: the role granted, and whether the grantee is a role, database role or user. */
  granted?: string | null;
  granteeKind?: string | null;
  object?: string | null;
  /** An ownership move with REVOKE CURRENT GRANTS: the object's existing grants are dropped. */
  dropsGrants?: boolean;
  /** CREATE OR REPLACE of a view or dynamic table: an existing object of that name is rebuilt. */
  replaces?: boolean;
  /** For a MERGE: what each WHEN clause does to the target's rows, e.g. `INSERT`, `UPDATE 2 columns`, `DELETE`. */
  actions?: string[];
  /** For a MERGE: every table it reads. A MERGE that reads a stream advances it, so each must be in a listed schema. */
  sources?: string[];
  /** The statement as a card shows it when a long literal VALUES list was cut; `text` still runs, byte for byte. */
  display?: string;
  /** Each VALUES list cut from `display`: its row count and the sha256 of its exact text in `text`. */
  collapsed?: Array<{ rows: number; sha256: string }>;
}

export interface Classification {
  tier: Tier;
  statements: Array<StatementFact & { tier: Tier | 'none'; why?: string }>;
  denyReasons: string[];
  classifierSha256: string;
}

/** The statement shapes the classifier fully parses; the card's summary is written for exactly these. */
const CARD_KINDS = [
  'read_metadata',
  'create_role',
  'create_user',
  'create_warehouse',
  'create_database',
  'create_object',
  'alter',
  'grant',
  'revoke',
  'ownership',
  'create_table',
  'create_view',
  'create_dynamic_table',
  'merge',
  'select',
] as const;
const CARD = new Set<string>(CARD_KINDS);
/** Kinds that create or write a table or view; each must land in a schema the target lists. */
const DATA_WRITE_KINDS: ReadonlySet<string> = new Set(['create_table', 'create_view', 'create_dynamic_table', 'merge']);

function tierOf(s: StatementFact): { tier: Tier | 'none'; why?: string } {
  if (s.deny) return { tier: 'deny', why: s.deny };
  if (s.kind === 'context') return { tier: 'none' };
  if (CARD.has(s.kind)) return { tier: 'card' };
  return { tier: 'deny', why: `statement kind "${s.kind}" has no tier` };
}

/** The `DB.SCHEMA` an object's three-part name sits in. */
function schemaOf(object: string | null | undefined): string | null {
  const parts = (object ?? '').split('.');
  return parts.length === 3 && parts.every(Boolean) ? `${parts[0]}.${parts[1]}` : null;
}

export function classifyFacts(
  facts: StatementFact[],
  classifierSha256: string,
  roles: ReadonlySet<string>,
  schemas: ReadonlySet<string>,
): Classification {
  const statements = facts.map((s) => {
    const tiered = { ...s, ...tierOf(s) };
    if (tiered.tier !== 'card') return tiered;
    if (!s.text.trim())
      return { ...tiered, tier: 'deny' as const, why: 'the classifier gave a statement to run with no text' };
    if (!s.role || !roles.has(s.role)) {
      return { ...tiered, tier: 'deny' as const, why: `a statement would run as ${s.role ?? 'no named role'}` };
    }
    if (DATA_WRITE_KINDS.has(s.kind)) {
      const schema = schemaOf(s.object);
      if (!schema || !schemas.has(schema)) {
        return {
          ...tiered,
          tier: 'deny' as const,
          why: `a statement writes ${s.object ?? 'an unnamed object'}, outside the schemas this target lists`,
        };
      }
      const outside = (s.sources ?? []).find((src) => !schemas.has(schemaOf(src) ?? ''));
      if (outside) {
        return {
          ...tiered,
          tier: 'deny' as const,
          why: `a MERGE reads ${outside}, outside the schemas this target lists (a MERGE consumes a stream it reads)`,
        };
      }
    }
    return tiered;
  });
  const denyReasons = statements.filter((s) => s.tier === 'deny').map((s) => s.why ?? 'denied');
  const ran = statements.filter((s) => s.tier !== 'none');
  const tier: Tier = ran.length === 0 || denyReasons.length > 0 ? 'deny' : 'card';
  if (ran.length === 0) denyReasons.push('the file runs no statements');
  return { tier, statements, denyReasons, classifierSha256 };
}

export function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Context values become SQL API request fields, so only plain identifiers are accepted. */
const PLAIN_NAME = /^[A-Za-z_][A-Za-z0-9_$]{0,254}$/;

function contextName(value: unknown): string | null | undefined {
  if (value === null || value === undefined) return null;
  return typeof value === 'string' && PLAIN_NAME.test(value) ? value : undefined;
}

const ACTION_RE = /^(INSERT|DELETE|UPDATE [1-9][0-9]{0,3} columns?)$/;

function parseActions(raw: unknown): string[] | undefined | null {
  if (raw === undefined) return undefined;
  return Array.isArray(raw) && raw.length > 0 && raw.every((a) => typeof a === 'string' && ACTION_RE.test(a))
    ? (raw as string[])
    : null;
}

function parseCollapsed(raw: unknown): StatementFact['collapsed'] | null {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) return null;
  const out: NonNullable<StatementFact['collapsed']> = [];
  for (const c of raw) {
    const { rows, sha256: hash } = (c ?? {}) as Record<string, unknown>;
    if (!Number.isInteger(rows) || (rows as number) < 1 || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))
      return null;
    out.push({ rows: rows as number, sha256: hash });
  }
  return out;
}

function parseFacts(stdout: string): StatementFact[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
    // eslint-disable-next-line no-catch-all/no-catch-all -- unreadable classifier output is a refusal, reported by the caller
  } catch {
    return null;
  }
  const { statements: list } = (parsed ?? {}) as Record<string, unknown>;
  if (!Array.isArray(list)) return null;
  const facts: StatementFact[] = [];
  for (const raw of list) {
    const s = raw as Record<string, unknown>;
    if (typeof s?.text !== 'string' || typeof s.kind !== 'string') return null;
    const context = [s.role, s.database, s.schema, s.warehouse].map(contextName);
    if (context.includes(undefined)) return null;
    const [role, database, schema, warehouse] = context as Array<string | null>;
    const actions = parseActions(s.actions);
    const collapsed = parseCollapsed(s.collapsed);
    const sources = s.sources === undefined ? undefined : s.sources;
    if (sources !== undefined && (!Array.isArray(sources) || !sources.every((x) => typeof x === 'string'))) return null;
    if (actions === null || collapsed === null || (s.kind === 'merge' && (!actions || !sources))) return null;
    if (
      (s.display === undefined) !== (collapsed === undefined) ||
      (s.display !== undefined && typeof s.display !== 'string')
    )
      return null;
    facts.push({
      text: s.text,
      kind: s.kind,
      scope: s.scope === 'dev' || s.scope === 'other' || s.scope === 'none' ? s.scope : undefined,
      role,
      database,
      schema,
      warehouse,
      deny: typeof s.deny === 'string' && s.deny ? s.deny : undefined,
      grantee: typeof s.grantee === 'string' ? s.grantee : null,
      object: typeof s.object === 'string' ? s.object : null,
      granted: typeof s.granted === 'string' ? s.granted : null,
      granteeKind: typeof s.grantee_kind === 'string' ? s.grantee_kind : null,
      dropsGrants: s.drops_grants === true,
      replaces: s.replaces === true,
      ...(actions ? { actions } : {}),
      ...(sources ? { sources: sources as string[] } : {}),
      ...(collapsed ? { display: s.display as string, collapsed } : {}),
    });
  }
  return facts;
}

export async function classify(target: SnowflakeTarget, sql: string): Promise<Classification | { error: string }> {
  let classifierBytes: Buffer;
  try {
    classifierBytes = fs.readFileSync(target.classifier.path);
    // eslint-disable-next-line no-catch-all/no-catch-all -- a missing classifier refuses the request
  } catch {
    return { error: `the ${target.label} classifier is not installed on this host` };
  }
  const classifierSha = sha256(classifierBytes);
  if (classifierSha !== target.classifier.sha256) {
    return { error: `the ${target.label} classifier does not match its pinned sha256; nothing was classified` };
  }
  const tmpDir = path.join(APPROVED_RUN_DIR, 'tmp');
  fs.mkdirSync(tmpDir, { recursive: true, mode: 0o700 });
  const file = path.join(tmpDir, `${randomUUID()}.sql`);
  // Run the bytes that were hashed, not the path, which can change after the check.
  const script = path.join(tmpDir, `${randomUUID()}.py`);
  fs.writeFileSync(file, sql, { mode: 0o600 });
  fs.writeFileSync(script, classifierBytes, { mode: 0o600 });
  try {
    const { stdout } = await execFileAsync(
      'python3',
      [
        '-I',
        script,
        '--facts',
        '--allowed-roles',
        target.allowedRoles.join(','),
        '--default-role',
        target.defaultRole,
        '--snow-root',
        target.classifier.snowRoot,
        file,
      ],
      { timeout: CLASSIFIER_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
    );
    const facts = parseFacts(stdout);
    if (!facts) return { error: `the ${target.label} classifier returned output the host can't read` };
    return classifyFacts(
      facts,
      classifierSha,
      new Set([...target.allowedRoles, target.defaultRole]),
      new Set(target.schemas),
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- a crashed or timed-out classifier refuses the request
  } catch (err) {
    return {
      error: `the ${target.label} classifier failed: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}`,
    };
  } finally {
    fs.rmSync(file, { force: true });
    fs.rmSync(script, { force: true });
  }
}
