import fs from 'fs';

import { writeMessageOut } from '../db/messages-out.js';
import { registerTools } from './server.js';
import { err, generateId, log, ok } from './tool-helpers.js';
import type { McpToolDefinition } from './types.js';

const MAX_FILE_BYTES = 256 * 1024;

export const proposeRun: McpToolDefinition = {
  tool: {
    name: 'propose_run',
    description:
      'Propose an exact privileged SQL file for a host-run target (for example Snowflake admin SQL such as role, grant, user or ownership changes, or a migration that creates tables and views and merges rows) instead of asking a human to paste it on the host. Nothing runs without a named approver: the host accepts only a set of statement shapes (USE, SHOW, CREATE ROLE/USER/WAREHOUSE/DATABASE/SCHEMA/DATABASE ROLE/STAGE/FILE FORMAT with plain settings, ALTER SCHEMA ... ENABLE MANAGED ACCESS, GRANT/REVOKE/OWNERSHIP of named privileges, CREATE TABLE with a column list, CREATE [OR REPLACE] VIEW or DYNAMIC TABLE, MERGE, and read-only SELECT, calling only built-in functions), and refuses the whole file if any statement falls outside them, touches a system role (ACCOUNTADMIN, SECURITYADMIN, SYSADMIN and the like), or creates or merges into a schema the target does not list. Write rendered SQL with plain names, no comments other than --, no placeholders, and no GRANT ALL; USE ROLE is allowed only for the roles the target permits, and every GRANT, REVOKE or ownership move needs a USE ROLE before it. A file too long to show on one card, or with a long VALUES list, also needs source: the commit and path where the same file is merged to develop or main, which the host checks byte for byte and links on the card. Results arrive as messages; nothing runs in your container.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Target id configured on the host, e.g. "example-snowflake".' },
        file: { type: 'string', description: 'Absolute path to the SQL file to run, exactly as it should run.' },
        reason: { type: 'string', description: 'One line: what this does and why (shown as the card title).' },
        source: {
          type: 'object',
          description: 'Optional: where this exact file is merged, so the card can link it.',
          properties: {
            commit: { type: 'string', description: 'Full 40-character commit on develop or main.' },
            path: { type: 'string', description: 'Path of the file in the repository at that commit.' },
          },
          required: ['commit', 'path'],
        },
      },
      required: ['target', 'file', 'reason'],
    },
  },
  async handler(args) {
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    const file = typeof args.file === 'string' ? args.file : '';
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (!target || !file || !reason) return err('target, file and reason are required');
    let sql: string;
    try {
      if (fs.statSync(file).size > MAX_FILE_BYTES) return err(`file is over ${MAX_FILE_BYTES / 1024} KB; split it`);
      sql = fs.readFileSync(file, 'utf8');
    } catch (e) {
      return err(`cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'request_approved_run',
        requestId,
        target,
        sql,
        reason,
        ...(args.source === undefined ? {} : { source: args.source }),
      }),
    });
    log(`propose_run: ${requestId} target=${target}`);
    return ok(
      `Submitted ${file} for ${target} (request ${requestId}). The host classifies it and tells you whether it runs, waits for a named approver, or is refused. Nothing has run yet.`,
    );
  },
};

export const proposeRenderChange: McpToolDefinition = {
  tool: {
    name: 'propose_render_change',
    description:
      'Propose one Render API write on a production resource your own Render key may not make (set or delete an env var, run a one-off job, turn auto-deploy on or off, add or verify a custom domain, replace routes). The host accepts only those operations, on resources the target lists, with exactly the body each allows; it shows the request on a card only the named approvers can answer and, on approval, sends it once as an Admin key. Env values are masked on the card unless the key is listed as non-secret. Deleting, suspending or creating services and databases, and any other service setting, are dashboard steps for a human. Results arrive as messages; nothing runs in your container.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Render target id configured on the host.' },
        method: { type: 'string', enum: ['POST', 'PUT', 'PATCH', 'DELETE'] },
        path: { type: 'string', description: 'Render API path, e.g. /v1/services/srv-…/env-vars/FEATURE_FLAG' },
        body: { description: 'JSON body exactly as Render takes it; omit for DELETE and verify.' },
        reason: { type: 'string', description: 'One line: what this does and why (shown as the card title).' },
      },
      required: ['target', 'method', 'path', 'reason'],
    },
  },
  async handler(args) {
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    const reason = typeof args.reason === 'string' ? args.reason.trim() : '';
    if (!target || !reason || typeof args.method !== 'string' || typeof args.path !== 'string') {
      return err('target, method, path and reason are required');
    }
    const request: Record<string, unknown> = { method: args.method, path: args.path };
    if (args.body !== undefined) request.body = args.body;
    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({ action: 'request_approved_run', requestId, target, request, reason }),
    });
    log(`propose_render_change: ${requestId} target=${target}`);
    return ok(
      `Submitted ${args.method} ${args.path} for ${target} (request ${requestId}). The host tells you whether it waits for a named approver or is refused. Nothing has been sent yet.`,
    );
  },
};

export const proposeMigration: McpToolDefinition = {
  tool: {
    name: 'propose_migration',
    description:
      "Propose numbered migration files for a database you may not migrate yourself (for example a production app or hub database): one file, or a release's files in the order they run, all at one commit. Name each file by database, stem and sha256; you never send SQL. The host checks the commit is on develop or main and every file there hashes to its sha256, reads the repository's own deploy-safety class and runner rules at that commit, and shows the list on one card only the named approvers can answer; any entry that fails refuses the whole list. On approval it runs that commit's own apply script once per file, in a sandbox: each file is its own transaction with its ledger row, and the list stops at the first file that does not apply, leaving earlier files applied. A file that ships its own runner, or is a baseline, is refused. Send files that must not block each other as separate proposals. Results arrive as messages; nothing runs in your container.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Migration target id configured on the host.' },
        commit: { type: 'string', description: 'Full 40-character commit on develop or main that holds every file.' },
        goLink: { type: 'string', description: 'https link to the Go that covers these migrations.' },
        files: {
          type: 'array',
          description: 'Up to 8 files, in the order they run.',
          items: {
            type: 'object',
            properties: {
              database: { type: 'string', description: 'Database the target allows, e.g. "app" or "hub".' },
              migration: { type: 'string', description: 'File stem without .sql, e.g. 301_add_widgets.' },
              sha256: {
                type: 'string',
                description: 'sha256 of the file at that commit (git show <commit>:<path> | sha256sum).',
              },
            },
            required: ['database', 'migration', 'sha256'],
          },
        },
        reason: { type: 'string', description: 'One line: what this does and why (shown as the card title).' },
      },
      required: ['target', 'commit', 'goLink', 'files', 'reason'],
    },
  },
  async handler(args) {
    const text = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const [target, reason, commit, goLink] = [
      text(args.target),
      text(args.reason),
      text(args.commit),
      text(args.goLink),
    ];
    if (!target || !reason || !commit || !goLink || !Array.isArray(args.files) || args.files.length === 0) {
      return err('target, commit, goLink, files and reason are required');
    }
    const files = (args.files as Array<Record<string, unknown>>).map((f) => ({
      database: text(f?.database),
      migration: text(f?.migration),
      sha256: text(f?.sha256),
    }));
    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'request_approved_run',
        requestId,
        target,
        migration: { commit, goLink, files },
        reason,
      }),
    });
    log(`propose_migration: ${requestId} target=${target} files=${files.length}`);
    return ok(
      `Submitted ${files.map((f) => `${f.migration} on ${f.database}`).join(', ')} for ${target} (request ${requestId}). The host tells you whether it waits for a named approver or is refused. Nothing has run yet.`,
    );
  },
};

export const renderEnvRead: McpToolDefinition = {
  tool: {
    name: 'render_env_read',
    description:
      "Read a production Render service's env vars through the host. Every key comes back; a value is shown in plaintext only when the key is listed as non-secret, otherwise as its length and a keyed HMAC (equal values give the same HMAC, so you can tell whether a value is set, changed, or matches another). No card, no approval. For database access use the RENDER_PG_URL_* variables in your environment instead of reading connection strings here.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        target: { type: 'string', description: 'Render target id configured on the host.' },
        service: { type: 'string', description: 'Service or cron job id (srv-… / crn-…).' },
        key: { type: 'string', description: 'Optional: read one key instead of all.' },
      },
      required: ['target', 'service'],
    },
  },
  async handler(args) {
    const target = typeof args.target === 'string' ? args.target.trim() : '';
    const service = typeof args.service === 'string' ? args.service.trim() : '';
    if (!target || !service) return err('target and service are required');
    const requestId = generateId();
    await writeMessageOut({
      id: requestId,
      kind: 'system',
      content: JSON.stringify({
        action: 'request_render_env_read',
        requestId,
        target,
        service,
        ...(typeof args.key === 'string' && args.key ? { key: args.key } : {}),
      }),
    });
    log(`render_env_read: ${requestId} target=${target} service=${service}`);
    return ok(`Asked the host for ${service}'s env vars (request ${requestId}); the answer arrives as a message.`);
  },
};

registerTools([proposeRun, proposeRenderChange, proposeMigration, renderEnvRead]);
