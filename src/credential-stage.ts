import fs from 'fs';
import path from 'path';

import YAML from 'yaml';

import { log } from './log.js';

export const DBT_CONTAINER_DIR = '/home/node/.dbt';

export function copySecretFile(src: string, dest: string): void {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  fs.chmodSync(dest, 0o600);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

interface StagedProfile {
  outputs: Record<string, unknown>;
  keys: Array<{ src: string; rel: string }>;
}

interface Refusal {
  refused: string;
  at: string;
}

function collectInlineKeys(v: unknown, out: Set<unknown>): Set<unknown> {
  if (Array.isArray(v)) {
    for (const item of v) collectInlineKeys(item, out);
  } else if (isRecord(v)) {
    for (const [k, item] of Object.entries(v)) {
      if (k === 'private_key' && item != null && item !== '') out.add(item);
      collectInlineKeys(item, out);
    }
  }
  return out;
}

function findInlineKey(v: unknown, at: string, inlineKeys: Set<unknown>): string | null {
  if (inlineKeys.has(v) || (typeof v === 'string' && v.includes('PRIVATE KEY-----'))) return at;
  if (Array.isArray(v)) {
    for (const [i, item] of v.entries()) {
      const hit = findInlineKey(item, `${at}[${i}]`, inlineKeys);
      if (hit) return hit;
    }
  } else if (isRecord(v)) {
    for (const [k, item] of Object.entries(v)) {
      if (k === 'private_key') return `${at}.${k}`;
      const hit = findInlineKey(item, `${at}.${k}`, inlineKeys);
      if (hit) return hit;
    }
  }
  return null;
}

function resolveKeyPath(keyPath: unknown, home: string): { src: string; rel: string } | string {
  if (typeof keyPath !== 'string') return 'private_key_path is not a string';
  if (!path.isAbsolute(keyPath) && !keyPath.startsWith('~/')) return 'private_key_path is not absolute';
  let src: string;
  try {
    src = fs.realpathSync(path.resolve(home, keyPath.startsWith('~/') ? keyPath.slice(2) : keyPath));
  } catch {
    return 'private_key_path does not exist';
  }
  const rel = path.relative(fs.realpathSync(home), src);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel))
    return 'private_key_path is outside the home directory';
  if (!fs.statSync(src).isFile()) return 'private_key_path is not a file';
  return { src, rel };
}

function stageProfileOutputs(
  outputs: Record<string, unknown>,
  home: string,
  queryTag: string,
): StagedProfile | Refusal {
  const staged: Record<string, unknown> = {};
  const keys: StagedProfile['keys'] = [];
  for (const [name, raw] of Object.entries(outputs)) {
    const output =
      isRecord(raw) && raw.type === 'snowflake' && !('query_tag' in raw) ? { ...raw, query_tag: queryTag } : raw;
    if (!isRecord(output) || output.private_key_path == null || output.private_key_path === '') {
      staged[name] = output;
      continue;
    }
    const key = resolveKeyPath(output.private_key_path, home);
    if (typeof key === 'string') return { refused: key, at: `outputs.${name}.private_key_path` };
    keys.push(key);
    staged[name] = { ...output, private_key_path: path.posix.join(DBT_CONTAINER_DIR, 'keys', key.rel) };
  }
  return { outputs: staged, keys };
}

/** Inline `private_key` refuses the whole profile: agents print the staged profiles.yml into transcripts. */
export function stageDbtProfiles(opts: {
  profilesPath: string;
  home: string;
  dest: string;
  allowedProfiles: string[] | null;
  agent: string;
  queryTag: string;
}): void {
  const parsed: unknown = YAML.parse(fs.readFileSync(opts.profilesPath, 'utf-8'), { merge: true }) ?? {};
  if (!isRecord(parsed)) throw new Error('profiles.yml is not a mapping');

  const inlineKeys = collectInlineKeys(parsed, new Set());
  const refuse = (profile: string, r: Refusal): void =>
    log.warn('dbt profile not staged (fail closed)', { agent: opts.agent, profile, at: r.at, reason: r.refused });

  const staged: Record<string, unknown> = {};
  for (const [name, profile] of Object.entries(parsed)) {
    if (opts.allowedProfiles && !opts.allowedProfiles.includes(name)) continue;
    const inline = name === 'private_key' ? name : findInlineKey(profile, name, inlineKeys);
    if (inline) {
      refuse(name, { refused: 'inline private_key', at: inline });
      continue;
    }
    if (!isRecord(profile) || !isRecord(profile.outputs)) {
      staged[name] = profile;
      continue;
    }
    const result = stageProfileOutputs(profile.outputs, opts.home, opts.queryTag);
    if ('refused' in result) {
      refuse(name, result);
      continue;
    }
    for (const key of result.keys) copySecretFile(key.src, path.join(opts.dest, 'keys', key.rel));
    staged[name] = { ...profile, outputs: result.outputs };
  }
  fs.writeFileSync(path.join(opts.dest, 'profiles.yml'), YAML.stringify(staged), { mode: 0o600 });
}

const TOML_COMMENT = String.raw`\s*(?:#.*)?`;
const TOML_HEADER = new RegExp(String.raw`^\s*\[\s*([A-Za-z0-9_-]+)\s*\]` + TOML_COMMENT + '$');
const TOML_VALUE = String.raw`(?:"(?:[^"\\]|\\.)*"|'[^']*'|[A-Za-z0-9_.:+-]+|\{(?:[^{}"'#]|"(?:[^"\\]|\\.)*"|'[^']*')*\})`;
const TOML_KEY_VALUE = new RegExp(String.raw`^\s*([A-Za-z0-9_-]+)\s*=\s*` + TOML_VALUE + TOML_COMMENT + '$');
const TOML_BLANK = /^\s*(?:#.*)?$/;

/**
 * Adds `session_parameters = { QUERY_TAG = <tag> }` to every connection that declares no `session_parameters`.
 * Returns null, never a partial edit, when any line falls outside the bare-header / bare-key / one-line-value subset:
 * a duplicate table fails the whole file in TOML, and a header-shaped line can sit inside a multi-line credential.
 */
export function tagSnowflakeConnections(toml: string, tag: string): string | null {
  const lines = toml.split('\n');
  const sections: Array<{ at: number; declared: boolean }> = [];
  for (const [at, raw] of lines.entries()) {
    const line = raw.replace(/\r$/, '');
    if (line.includes('"""') || line.includes("'''")) return null;
    if (TOML_HEADER.test(line)) sections.push({ at, declared: false });
    else if (TOML_BLANK.test(line)) continue;
    else {
      const kv = line.match(TOML_KEY_VALUE);
      if (!kv || sections.length === 0) return null;
      if (kv[1] === 'session_parameters') sections[sections.length - 1].declared = true;
    }
  }
  const tagLine = `session_parameters = { QUERY_TAG = ${JSON.stringify(tag)} }`;
  for (const { at } of sections.filter((section) => !section.declared).reverse()) lines.splice(at + 1, 0, tagLine);
  return lines.join('\n');
}
