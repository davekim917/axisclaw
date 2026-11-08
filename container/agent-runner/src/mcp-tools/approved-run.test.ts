import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getOutboundDb } from '../mailbox/sqlite/connection.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';

// Imported, not taken from a registerTools mock: bun shares one module cache
// across files, so the tool may already be registered against another suite's mock.
const { proposeRun, proposeRenderChange, proposeMigration, renderEnvRead } = await import('./approved-run.js');

function systemRows(): Array<{ id: string; content: Record<string, unknown> }> {
  return (
    getOutboundDb().prepare(`SELECT id, content FROM messages_out WHERE kind = 'system' ORDER BY seq`).all() as Array<{
      id: string;
      content: string;
    }>
  ).map((r) => ({ id: r.id, content: JSON.parse(r.content) as Record<string, unknown> }));
}

let dir: string;
beforeEach(() => {
  initTestSessionDb();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'propose-run-'));
});
afterEach(() => {
  closeSessionDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('propose_run', () => {
  it('sends the host the exact file bytes under one request id, and claims nothing ran', async () => {
    const sql =
      "CREATE DATABASE ROLE example_dev.reader;\n-- keep: 'quoted; text'\nGRANT USAGE ON DATABASE example_dev TO DATABASE ROLE example_dev.reader;\n";
    const file = path.join(dir, 'grant.sql');
    fs.writeFileSync(file, sql);

    const result = await proposeRun.handler({ target: ' example-snowflake ', file, reason: ' add a dev reader role ' });

    expect(result.isError).toBeFalsy();
    const rows = systemRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toEqual({
      action: 'request_approved_run',
      requestId: rows[0].id,
      target: 'example-snowflake',
      sql,
      reason: 'add a dev reader role',
    });
    expect(result.content[0]?.text).toContain(rows[0].id);
    expect(result.content[0]?.text).toContain('Nothing has run yet');
  });

  it('passes the source the agent names to the host for it to check', async () => {
    const file = path.join(dir, 'merge.sql');
    fs.writeFileSync(file, 'SELECT 1;\n');
    const source = { commit: 'b2'.repeat(20), path: 'migrations/a.sql' };
    await proposeRun.handler({ target: 'example-snowflake', file, reason: 'r', source });
    expect(systemRows()[0].content).toMatchObject({ source });
  });

  it.each([
    [{ file: '/x.sql', reason: 'r' }],
    [{ target: 't', reason: 'r' }],
    [{ target: 't', file: '/x.sql', reason: '   ' }],
  ])('refuses a request missing target, file or reason, and writes nothing (%j)', async (args) => {
    const result = await proposeRun.handler(args);
    expect(result.isError).toBe(true);
    expect(systemRows()).toHaveLength(0);
  });

  it('refuses a file over 256 KB without reading it into a request', async () => {
    const file = path.join(dir, 'big.sql');
    fs.writeFileSync(file, 'x'.repeat(256 * 1024 + 1));
    const result = await proposeRun.handler({ target: 't', file, reason: 'r' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('split it');
    expect(systemRows()).toHaveLength(0);
  });

  it('accepts a file of exactly 256 KB', async () => {
    const file = path.join(dir, 'edge.sql');
    fs.writeFileSync(file, 'x'.repeat(256 * 1024));
    const result = await proposeRun.handler({ target: 't', file, reason: 'r' });
    expect(result.isError).toBeFalsy();
    expect(systemRows()).toHaveLength(1);
  });

  it('reports an unreadable path as an error, not a submission', async () => {
    const result = await proposeRun.handler({ target: 't', file: path.join(dir, 'missing.sql'), reason: 'r' });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('cannot read');
    expect(systemRows()).toHaveLength(0);
  });
});

describe('propose_render_change', () => {
  it('sends the host the request exactly as given under one request id, and claims nothing was sent', async () => {
    const result = await proposeRenderChange.handler({
      target: ' acme-render ',
      method: 'PUT',
      path: '/v1/services/srv-x/env-vars/FLAG',
      body: { value: 'on' },
      reason: ' turn the flag on ',
    });
    expect(result.isError).toBeFalsy();
    const rows = systemRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toEqual({
      action: 'request_approved_run',
      requestId: rows[0].id,
      target: 'acme-render',
      request: { method: 'PUT', path: '/v1/services/srv-x/env-vars/FLAG', body: { value: 'on' } },
      reason: 'turn the flag on',
    });
    expect(result.content[0]?.text).toContain('Nothing has been sent yet');
  });

  it('leaves the body out when none is given, so a DELETE carries none', async () => {
    await proposeRenderChange.handler({
      target: 't',
      method: 'DELETE',
      path: '/v1/services/srv-x/env-vars/A',
      reason: 'r',
    });
    expect(systemRows()[0].content.request).toEqual({ method: 'DELETE', path: '/v1/services/srv-x/env-vars/A' });
  });

  it('refuses a request missing its method or path, and writes nothing', async () => {
    const result = await proposeRenderChange.handler({ target: 't', reason: 'r', path: '/v1/x' });
    expect(result.isError).toBe(true);
    expect(systemRows()).toHaveLength(0);
  });
});

describe('propose_migration', () => {
  const file = { database: ' app ', migration: ' 301_add_widgets ', sha256: ' ' + 'a'.repeat(64) + ' ' };

  it('sends the host the files by name and hash in order under one request id, and claims nothing ran', async () => {
    const result = await proposeMigration.handler({
      target: ' acme-migrate ',
      commit: ' ' + 'c'.repeat(40) + ' ',
      goLink: ' https://example.invalid/go ',
      files: [file, { database: 'hub', migration: '090_add_sprockets', sha256: 'b'.repeat(64) }],
      reason: ' add tables ',
    });
    expect(result.isError).toBeFalsy();
    const rows = systemRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toEqual({
      action: 'request_approved_run',
      requestId: rows[0].id,
      target: 'acme-migrate',
      migration: {
        commit: 'c'.repeat(40),
        goLink: 'https://example.invalid/go',
        files: [
          { database: 'app', migration: '301_add_widgets', sha256: 'a'.repeat(64) },
          { database: 'hub', migration: '090_add_sprockets', sha256: 'b'.repeat(64) },
        ],
      },
      reason: 'add tables',
    });
    expect(result.content[0]?.text).toContain('Nothing has run yet');
  });

  it('refuses a proposal with no files, and writes nothing', async () => {
    const result = await proposeMigration.handler({ target: 't', commit: 'c', goLink: 'g', files: [], reason: 'r' });
    expect(result.isError).toBe(true);
    expect(systemRows()).toHaveLength(0);
  });
});

describe('render_env_read', () => {
  it('asks the host for one service, with the key only when given', async () => {
    await renderEnvRead.handler({ target: 'acme-render', service: 'srv-x' });
    await renderEnvRead.handler({ target: 'acme-render', service: 'srv-x', key: 'NODE_ENV' });
    const [all, one] = systemRows();
    expect(all.content).toEqual({
      action: 'request_render_env_read',
      requestId: all.id,
      target: 'acme-render',
      service: 'srv-x',
    });
    expect(one.content).toMatchObject({ service: 'srv-x', key: 'NODE_ENV' });
  });
});
