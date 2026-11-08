import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { migration095 } from './095-mcp-oauth-client-credentials.js';
import { migrations, runMigrations } from './index.js';

function beforeMigration(): Database.Database {
  const db = new Database(':memory:');
  runMigrations(
    db,
    migrations.filter((m) => m.name !== migration095.name),
  );
  return db;
}

const LOGIN_ROW = {
  name: 'oauth-example',
  agent_group_id: 'ag-example',
  mcp_url: 'https://mcp.example.test/mcp',
  resource: 'https://mcp.example.test/resource',
  authorization_endpoint: 'https://as.example.test/authorize',
  token_endpoint: 'https://as.example.test/token',
  registration_endpoint: 'https://as.example.test/register',
  issuer: 'https://as.example.test',
  scopes: 'read write',
  redirect_uri: 'http://127.0.0.1:8765/callback',
  bearer_secret_name: 'Oauth-MCP-Example',
  bearer_secret_id: 'secret-id-example',
  host_pattern: 'mcp.example.test',
  path_pattern: '/mcp*',
  status: 'needs_login',
  status_detail: 'refresh token rejected',
  expires_at: '2026-09-17T12:00:00.000Z',
  last_refresh_at: '2026-09-16T12:00:00.000Z',
  created_at: '2026-09-01T00:00:00.000Z',
  updated_at: '2026-09-02T00:00:00.000Z',
};

function insertLoginRow(db: Database.Database, row: Record<string, unknown> = LOGIN_ROW): void {
  const cols = Object.keys(row);
  db.prepare(
    `INSERT INTO mcp_oauth_integrations (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`,
  ).run(row);
}

describe('migration 095 (client-credentials grant)', () => {
  it('keeps every existing row, its status and its columns, as an authorization_code grant', () => {
    const db = beforeMigration();
    insertLoginRow(db);
    insertLoginRow(db, {
      ...LOGIN_ROW,
      name: 'oauth-other',
      mcp_url: 'https://mcp2.example.test/mcp',
      status: 'active',
    });

    migration095.up(db);

    const rows = db.prepare('SELECT * FROM mcp_oauth_integrations ORDER BY name').all() as Array<
      Record<string, unknown>
    >;
    expect(rows.map((r) => [r.name, r.status, r.grant_type])).toEqual([
      ['oauth-example', 'needs_login', 'authorization_code'],
      ['oauth-other', 'active', 'authorization_code'],
    ]);
    expect(rows[0]).toMatchObject(LOGIN_ROW);
    const indexes = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'mcp_oauth_integrations' AND sql IS NOT NULL`,
      )
      .pluck()
      .all();
    expect(indexes.sort()).toEqual(['idx_mcp_oauth_integrations_group_url', 'idx_mcp_oauth_integrations_status']);
  });

  it('is a no-op when run again, leaving a client-credentials row as it is', () => {
    const db = beforeMigration();
    insertLoginRow(db);
    migration095.up(db);
    const { authorization_endpoint: _a, redirect_uri: _r, ...withoutLogin } = LOGIN_ROW;
    insertLoginRow(db, {
      ...withoutLogin,
      name: 'client-example',
      mcp_url: 'https://api.example.test',
      grant_type: 'client_credentials',
    });

    migration095.up(db);

    expect(db.prepare('SELECT name, grant_type FROM mcp_oauth_integrations ORDER BY name').all()).toEqual([
      { name: 'client-example', grant_type: 'client_credentials' },
      { name: 'oauth-example', grant_type: 'authorization_code' },
    ]);
  });

  it('lets a client-credentials row omit the login endpoints, and still refuses a login row without them', () => {
    const db = beforeMigration();
    migration095.up(db);
    const { authorization_endpoint: _a, redirect_uri: _r, ...withoutLogin } = LOGIN_ROW;

    insertLoginRow(db, { ...withoutLogin, name: 'client-example', grant_type: 'client_credentials' });
    expect(() =>
      insertLoginRow(db, { ...withoutLogin, name: 'login-example', mcp_url: 'https://x.example.test' }),
    ).toThrow(/CHECK constraint failed/);
  });

  it('keeps one integration per (group, url)', () => {
    const db = beforeMigration();
    migration095.up(db);
    insertLoginRow(db);
    expect(() => insertLoginRow(db, { ...LOGIN_ROW, name: 'oauth-dup' })).toThrow(/UNIQUE constraint failed/);
  });
});
