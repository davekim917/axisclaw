/**
 * A Snowflake proposal may name where its file is merged: `source: { commit, path }`. The card links the file there
 * only after the host's own mirror of the target's repository shows that commit on develop or main holding exactly
 * the proposed bytes, so a reader who follows the link reads what runs.
 */
import { sha256 } from './classify.js';
import { repoReader } from './migrate-repo.js';
import { REL_PATH_RE, type SnowflakeTarget } from './targets.js';

export interface SourceLink {
  url: string;
  branch: 'develop' | 'main';
}

const COMMIT_RE = /^[0-9a-f]{40}$/;

export async function verifySource(
  target: SnowflakeTarget,
  raw: unknown,
  sql: string,
): Promise<SourceLink | null | { error: string }> {
  if (raw === undefined || raw === null) return null;
  const { commit, path } = (typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (typeof commit !== 'string' || !COMMIT_RE.test(commit) || typeof path !== 'string' || !REL_PATH_RE.test(path)) {
    return { error: 'source must be { commit: <full 40-character commit>, path: <file path in the repository> }' };
  }
  if (!target.repo) return { error: `${target.label} names no repository, so a source can't be checked` };
  const repo = repoReader(target.repo);
  await repo.refresh();
  const branch = await repo.branchOf(commit);
  if (!branch) return { error: `commit ${commit.slice(0, 12)} is not on develop or main of ${target.repo}` };
  const bytes = await repo.blob(commit, path);
  if (!bytes) return { error: `${target.repo} has no ${path} at ${commit.slice(0, 12)}` };
  if (sha256(bytes) !== sha256(sql)) {
    return { error: `${path} at ${commit.slice(0, 12)} differs from the proposed file; propose the file as merged` };
  }
  return { url: `https://github.com/${target.repo}/blob/${commit}/${path}`, branch };
}
