/**
 * What an agent may propose for a `repo-migrate` target: an ordered list of numbered migration files at one commit,
 * each named by database, stem and sha256, never free SQL. The commit must be on develop or main as just fetched, and
 * every file there must hash to its sha256; any entry that fails refuses the whole list. All of it is checked again
 * when an approver presses Run it.
 */
import { createHash } from 'node:crypto';

import type { MigrationFacts } from './migrate-facts.js';
import type { RepoReader } from './migrate-repo.js';
import type { MigrateTarget } from './targets.js';

/** A numbered migration file stem. */
const STEM_RE = /^[0-9]{3,}[_-][a-z0-9_-]+$/;
const COMMIT_RE = /^[0-9a-f]{40}$/;
const SHA_RE = /^[0-9a-f]{64}$/;
const GO_RE = /^https:\/\/[A-Za-z0-9.-]+(\/[A-Za-z0-9._~%#?=&+:@/-]{0,500})?$/;
/** One card must show every file; more than this does not fit. */
const MAX_FILES = 8;

export interface MigrationEntry {
  database: string;
  migration: string;
  sha256: string;
}

export interface MigrationProposal {
  commit: string;
  goLink: string;
  files: MigrationEntry[];
}

interface CheckedEntry {
  /** The file's path in the repository. */
  path: string;
  bytes: number;
  facts: MigrationFacts;
}

export interface MigrateClassification {
  tier: 'card' | 'deny';
  denyReasons: string[];
  proposal: MigrationProposal | null;
  branch?: 'develop' | 'main';
  /** One per proposed file, in order. */
  checked?: CheckedEntry[];
  /** Git blob ids of the executor files at the proposal's commit. */
  executor?: Record<string, string | null>;
}

export type FactsReader = (p: MigrationProposal) => Promise<MigrationFacts[] | { error: string }>;

export function migrationPath(target: MigrateTarget, e: MigrationEntry): string {
  return `${target.folders[e.database]}/${e.migration}.sql`;
}

/** The sha256 a card binds: of the proposal's fields in a fixed order. */
export function proposalSha(p: MigrationProposal): string {
  return createHash('sha256')
    .update(JSON.stringify([p.commit, p.goLink, p.files.map((f) => [f.database, f.migration, f.sha256])]))
    .digest('hex');
}

function entryOf(target: MigrateTarget, raw: unknown, n: number): MigrationEntry | string {
  const at = `file ${n}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return `${at} is not an object`;
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'database,migration,sha256') {
    return `${at} takes exactly database, migration and sha256`;
  }
  if (typeof r.database !== 'string' || !target.databases.includes(r.database)) {
    return `${at}: database must be one of ${target.databases.join(', ')}`;
  }
  if (typeof r.migration !== 'string' || !STEM_RE.test(r.migration)) {
    return `${at}: migration must be a numbered file stem such as 301_add_widgets, without .sql`;
  }
  if (typeof r.sha256 !== 'string' || !SHA_RE.test(r.sha256))
    return `${at}: sha256 must be 64 lowercase hex characters`;
  return { database: r.database, migration: r.migration, sha256: r.sha256 };
}

function shapeOf(target: MigrateTarget, raw: unknown): MigrationProposal | string {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'the migration proposal is missing';
  const r = raw as Record<string, unknown>;
  if (Object.keys(r).sort().join(',') !== 'commit,files,goLink') {
    return 'a migration proposal takes exactly commit, goLink and files';
  }
  if (typeof r.commit !== 'string' || !COMMIT_RE.test(r.commit)) return 'commit must be the full 40-character sha';
  if (typeof r.goLink !== 'string' || !GO_RE.test(r.goLink)) return 'goLink must be an https link to the Go';
  if (!Array.isArray(r.files) || r.files.length === 0 || r.files.length > MAX_FILES) {
    return `files must list 1–${MAX_FILES} migrations, in the order they run`;
  }
  const files: MigrationEntry[] = [];
  for (const [i, raw] of r.files.entries()) {
    const e = entryOf(target, raw, i + 1);
    if (typeof e === 'string') return e;
    if (files.some((f) => f.database === e.database && f.migration === e.migration)) {
      return `file ${i + 1}: ${e.migration} on ${e.database} is listed twice`;
    }
    files.push(e);
  }
  return { commit: r.commit, goLink: r.goLink, files };
}

function deny(reason: string, proposal: MigrationProposal | null = null): MigrateClassification {
  return { tier: 'deny', denyReasons: [reason], proposal };
}

export async function classifyMigration(
  target: MigrateTarget,
  raw: unknown,
  repo: RepoReader,
  readFacts: FactsReader,
): Promise<MigrateClassification> {
  const p = shapeOf(target, raw);
  if (typeof p === 'string') return deny(p);
  try {
    await repo.refresh();
    // eslint-disable-next-line no-catch-all/no-catch-all -- a fetch that fails refuses the proposal, with the reason
  } catch (err) {
    return deny(
      `the host could not fetch ${target.repo}: ${err instanceof Error ? err.message.slice(0, 200) : 'error'}`,
      p,
    );
  }
  const short = p.commit.slice(0, 12);
  const branch = await repo.branchOf(p.commit);
  if (!branch) return deny(`commit ${short} is not on develop or main`, p);
  const sizes: number[] = [];
  for (const e of p.files) {
    const path = migrationPath(target, e);
    const bytes = await repo.blob(p.commit, path);
    if (!bytes) return deny(`${path} does not exist at ${short}`, p);
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== e.sha256) return deny(`${path} at ${short} has sha256 ${actual}, not ${e.sha256}`, p);
    sizes.push(bytes.length);
  }
  const apply = target.layout.applyScript;
  if (!(await repo.blob(p.commit, apply))) return deny(`${apply} does not exist at ${short}`, p);
  const facts = await readFacts(p);
  if ('error' in facts) return deny(facts.error, p);
  for (const [i, f] of facts.entries()) {
    if (f.refuse) return deny(`${migrationPath(target, p.files[i])}: ${f.refuse}`, p);
  }
  const executor: Record<string, string | null> = {};
  for (const f of new Set([...target.layout.watched, ...target.layout.extract]))
    executor[f] = await repo.blobId(p.commit, f);
  const checked = p.files.map((e, i) => ({ path: migrationPath(target, e), bytes: sizes[i], facts: facts[i] }));
  return { tier: 'card', denyReasons: [], proposal: p, branch, checked, executor };
}
