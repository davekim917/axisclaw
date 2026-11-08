/** Codex project-doc (AGENTS.md) size limits. Nothing here evicts or truncates: `warnIfOversized` only logs. */
import { log } from './log.js';

/** Must match the `-c project_doc_max_bytes` override in codex-app-server.ts (the trees share no modules). */
export const CODEX_PROJECT_DOC_CONFIGURED_MAX_BYTES = 262144;

const bytesOf = (s: string): number => Buffer.byteLength(s, 'utf-8');

export function warnIfOversized(label: string, content: string, limitBytes: number): void {
  const bytes = bytesOf(content);
  if (bytes <= limitBytes) return;
  log.error('Project doc exceeded size limit', { label, bytes, limitBytes });
}
