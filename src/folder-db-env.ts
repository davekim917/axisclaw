import fs from 'fs';

import { GROUPS_DIR } from './config.js';

const PREFIXES = ['RENDER_PG_URL_', 'RENDER_REDIS_URL_'];

const envToken = (folder: string): string => folder.toUpperCase().replace(/-/g, '_');

const startsWithToken = (text: string, token: string): boolean => text === token || text.startsWith(`${token}_`);

function groupFolders(): string[] {
  if (!fs.existsSync(GROUPS_DIR)) return [];
  return fs
    .readdirSync(GROUPS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
}

export function folderDbEnvNames(folder: string, env: NodeJS.ProcessEnv = process.env): string[] {
  const token = envToken(folder);
  const longerTokens = groupFolders()
    .map(envToken)
    .filter((other) => other !== token && startsWithToken(other, token));
  return Object.keys(env)
    .filter((name) => {
      const prefix = PREFIXES.find((p) => name.startsWith(p));
      if (!env[name] || !prefix) return false;
      const tail = name.slice(prefix.length);
      return startsWithToken(tail, token) && !longerTokens.some((other) => startsWithToken(tail, other));
    })
    .sort();
}
