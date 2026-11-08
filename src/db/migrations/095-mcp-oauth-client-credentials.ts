import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

/**
 * A second grant kind for `mcp_oauth_integrations`: `client_credentials`, where the host holds a client id and secret
 * and mints the access token itself, with no browser login. Such a row has no authorization endpoint and no redirect
 * URI, so both lose NOT NULL, which SQLite can only do by rebuilding the table. `mcp_url` keeps NOT NULL: for this
 * kind it holds the API origin the token is for, which keeps the (group, url) uniqueness meaningful.
 */
export const migration095: Migration = {
  version: 95,
  name: 'mcp-oauth-client-credentials',
  up(db: Database.Database) {
    const columns = db.prepare(`PRAGMA table_info(mcp_oauth_integrations)`).all() as Array<{ name: string }>;
    if (columns.some((c) => c.name === 'grant_type')) return;
    db.exec(`
      CREATE TABLE mcp_oauth_integrations_new (
        name                     TEXT PRIMARY KEY,
        agent_group_id           TEXT NOT NULL,
        mcp_url                  TEXT NOT NULL,
        resource                 TEXT,
        grant_type               TEXT NOT NULL DEFAULT 'authorization_code'
                                 CHECK (grant_type IN ('authorization_code', 'client_credentials')),
        authorization_endpoint   TEXT,
        token_endpoint           TEXT NOT NULL,
        registration_endpoint    TEXT,
        issuer                   TEXT,
        scopes                   TEXT,
        redirect_uri             TEXT,
        bearer_secret_name       TEXT NOT NULL,
        bearer_secret_id         TEXT,
        host_pattern             TEXT NOT NULL,
        path_pattern             TEXT,
        status                   TEXT NOT NULL,
        status_detail            TEXT,
        expires_at               TEXT,
        last_refresh_at          TEXT,
        created_at               TEXT NOT NULL,
        updated_at               TEXT NOT NULL,
        CHECK (grant_type = 'client_credentials' OR (authorization_endpoint IS NOT NULL AND redirect_uri IS NOT NULL))
      );
      INSERT INTO mcp_oauth_integrations_new
        (name, agent_group_id, mcp_url, resource, grant_type, authorization_endpoint, token_endpoint,
         registration_endpoint, issuer, scopes, redirect_uri, bearer_secret_name, bearer_secret_id, host_pattern,
         path_pattern, status, status_detail, expires_at, last_refresh_at, created_at, updated_at)
      SELECT name, agent_group_id, mcp_url, resource, 'authorization_code', authorization_endpoint, token_endpoint,
             registration_endpoint, issuer, scopes, redirect_uri, bearer_secret_name, bearer_secret_id, host_pattern,
             path_pattern, status, status_detail, expires_at, last_refresh_at, created_at, updated_at
        FROM mcp_oauth_integrations;
      DROP TABLE mcp_oauth_integrations;
      ALTER TABLE mcp_oauth_integrations_new RENAME TO mcp_oauth_integrations;
      CREATE UNIQUE INDEX idx_mcp_oauth_integrations_group_url
        ON mcp_oauth_integrations (agent_group_id, mcp_url);
      CREATE INDEX idx_mcp_oauth_integrations_status
        ON mcp_oauth_integrations (status);
    `);
  },
};
