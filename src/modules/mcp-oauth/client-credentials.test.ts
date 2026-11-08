/**
 * Client-credentials integrations: the host holds a client id and secret and mints the bearer itself. Hermetic like
 * refresh.test.ts: migrated in-memory DB, per-run DATA_DIR, the OneCLI writer and grant declaration mocked at their
 * module boundaries, every token request an injected stub.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-client-credentials-'));

vi.mock('../../config.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../config.js')>();
  return {
    ...real,
    get DATA_DIR() {
      return tmpRoot;
    },
  };
});

const logged: unknown[][] = [];
vi.mock('../../log.js', () => ({
  log: {
    info: (...a: unknown[]) => logged.push(a),
    warn: (...a: unknown[]) => logged.push(a),
    error: (...a: unknown[]) => logged.push(a),
    debug: () => undefined,
    fatal: () => undefined,
  },
  setLogScrubber: () => undefined,
  isSurvivableIoError: () => false,
}));

const secretWrites: Array<{ name: string; hostPattern: string; valueFormat: string; value: string }> = [];
let existingSecretCheck: (name: string, host: string) => void = () => undefined;
let failSecretWrites = 0;
vi.mock('../../onecli-secret-writer.js', () => ({
  existingSecretOnHost: async (name: string, host: string) => existingSecretCheck(name, host),
  putOnecliBearerSecret: async (spec: { name: string; hostPattern: string; valueFormat: string }, value: string) => {
    if (failSecretWrites > 0) {
      failSecretWrites--;
      throw new Error('vault down');
    }
    secretWrites.push({ name: spec.name, hostPattern: spec.hostPattern, valueFormat: spec.valueFormat, value });
    return { id: 'secret-uuid-1', name: spec.name };
  },
  findOnecliSecretByName: async () => undefined,
  deleteOnecliSecret: async () => true,
}));

const declared: Array<[string, string]> = [];
vi.mock('../../onecli-secret-grants.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../onecli-secret-grants.js')>()),
  ensureGroupSecretDeclared: async (groupId: string, secretName: string) => {
    declared.push([groupId, secretName]);
    return { kind: 'workgroup', id: 'wg-example', added: true };
  },
}));

import { closeDb, createAgentGroup, initMigratedTestDb } from '../../db/index.js';
import {
  getMcpOAuthIntegration,
  markMcpOAuthIntegration,
  upsertMcpOAuthIntegration,
} from '../../db/mcp-oauth-integrations.js';
import { enforceHermeticity } from '../../test-hermeticity.js';
import {
  addClientCredentialsIntegration,
  clientCredentialsIntegration,
  refreshExpiringMcpOAuthIntegrations,
  IntegrationChangedError,
  rekeyClientCredentials,
  startLogin,
  _resetMcpOAuthWarnStateForTesting,
  type AddClientInput,
} from './service.js';
import { OAuthTokenError } from './oauth-client.js';
import { readMcpOAuthBundle } from './store.js';

enforceHermeticity();

const CLIENT_SECRET = 'client-secret-SENTINEL-4c1a';
const API = 'https://example.cloud.looker.test';
const TOKEN_URL = `${API}/api/4.0/login`;

const tokenRequests: URLSearchParams[] = [];
function tokenEndpoint(status: number, body: Record<string, unknown>) {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    tokenRequests.push(new URLSearchParams(String(init?.body)));
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  });
}
const minted = (token: string) => tokenEndpoint(200, { access_token: token, token_type: 'Bearer', expires_in: 3600 });

const input = (over: Partial<AddClientInput> = {}): AddClientInput => ({
  name: 'looker-example',
  agentGroupId: 'ag-example',
  apiUrl: API,
  tokenUrl: TOKEN_URL,
  clientId: 'client-id-1',
  clientSecret: CLIENT_SECRET,
  replace: false,
  ...over,
});

beforeEach(async () => {
  await initMigratedTestDb();
  await createAgentGroup({
    id: 'ag-example',
    name: 'example',
    folder: 'example',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  secretWrites.length = 0;
  declared.length = 0;
  tokenRequests.length = 0;
  logged.length = 0;
  existingSecretCheck = () => undefined;
  failSecretWrites = 0;
  _resetMcpOAuthWarnStateForTesting();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(path.join(tmpRoot, 'mcp-oauth'), { recursive: true, force: true });
});

describe('addClientCredentialsIntegration', () => {
  it('stores the pair host-side at 0600, a Bearer token on the API host, and declares it', async () => {
    const result = await addClientCredentialsIntegration(input(), minted('tok-1'));

    expect(tokenRequests.map((f) => Object.fromEntries(f))).toEqual([
      { grant_type: 'client_credentials', client_id: 'client-id-1', client_secret: CLIENT_SECRET },
    ]);
    expect(readMcpOAuthBundle('looker-example')).toMatchObject({
      clientId: 'client-id-1',
      clientSecret: CLIENT_SECRET,
    });
    expect(fs.statSync(path.join(tmpRoot, 'mcp-oauth', 'looker-example.json')).mode & 0o777).toBe(0o600);
    expect(secretWrites).toEqual([
      {
        name: 'LookerExample-MCP-Example',
        hostPattern: 'example.cloud.looker.test',
        valueFormat: 'Bearer {value}',
        value: 'tok-1',
      },
    ]);
    expect(declared).toEqual([['ag-example', 'LookerExample-MCP-Example']]);
    expect(await getMcpOAuthIntegration('looker-example')).toMatchObject({
      grant_type: 'client_credentials',
      mcp_url: API,
      authorization_endpoint: null,
      redirect_uri: null,
      token_endpoint: TOKEN_URL,
      status: 'active',
    });
    expect(result.status).toBe('active');
    expect(JSON.stringify({ result, row: await getMcpOAuthIntegration('looker-example'), logged })).not.toContain(
      CLIENT_SECRET,
    );
  });

  it('proves the pair by minting before it stores anything', async () => {
    await expect(
      addClientCredentialsIntegration(input(), tokenEndpoint(404, { message: 'Not found' })),
    ).rejects.toThrow(/http_404/);

    expect(await getMcpOAuthIntegration('looker-example')).toBeUndefined();
    expect(readMcpOAuthBundle('looker-example')).toBeUndefined();
    expect(secretWrites).toEqual([]);
  });

  it('refuses a secret name already on another host before it mints or stores anything', async () => {
    const checkedHosts: string[] = [];
    existingSecretCheck = (_name, host) => {
      checkedHosts.push(host);
      throw new Error('Vault secret "X" injects on old.example.test, not example.cloud.looker.test');
    };
    const endpoint = minted('tok-1');

    await expect(addClientCredentialsIntegration(input(), endpoint)).rejects.toThrow(/injects on old\.example\.test/);

    expect(checkedHosts).toEqual([new URL(API).hostname]);
    expect(endpoint).not.toHaveBeenCalled();
    expect(await getMcpOAuthIntegration('looker-example')).toBeUndefined();
    expect(readMcpOAuthBundle('looker-example')).toBeUndefined();
    expect(secretWrites).toEqual([]);
  });

  it('replaces the pair of an existing integration and keeps its secret name', async () => {
    await addClientCredentialsIntegration(input({ secretName: 'Looker-Example' }), minted('tok-1'));
    await addClientCredentialsIntegration(input({ clientId: 'client-id-2', replace: true }), minted('tok-2'));

    expect(readMcpOAuthBundle('looker-example')?.clientId).toBe('client-id-2');
    expect(secretWrites.map((w) => [w.name, w.value])).toEqual([
      ['Looker-Example', 'tok-1'],
      ['Looker-Example', 'tok-2'],
    ]);
  });

  it.each([
    [
      'a second add without --replace',
      async () => addClientCredentialsIntegration(input(), minted('t')),
      /pass --replace/,
    ],
    ['--replace of a name that does not exist', async () => undefined, /No integration named/],
  ])('refuses %s', async (name, setup, reason) => {
    await setup();
    const replace = name.startsWith('--replace');
    await expect(addClientCredentialsIntegration(input({ replace }), minted('t'))).rejects.toThrow(reason);
  });

  it.each([
    [
      'another API origin',
      { apiUrl: 'https://other.cloud.looker.test', tokenUrl: 'https://other.cloud.looker.test/api/4.0/login' },
      /--delete-secret/,
    ],
    ['another secret name', { secretName: 'Other-Name' }, /drop --secret/],
  ])('refuses a --replace that names %s, storing nothing new', async (_name, change, reason) => {
    await addClientCredentialsIntegration(input(), minted('tok-1'));
    secretWrites.length = 0;
    await expect(addClientCredentialsIntegration(input({ ...change, replace: true }), minted('tok-2'))).rejects.toThrow(
      reason,
    );
    expect(secretWrites).toEqual([]);
    expect((await getMcpOAuthIntegration('looker-example'))?.mcp_url).toBe(API);
  });

  it('refuses a --replace that moves the integration to another group', async () => {
    await addClientCredentialsIntegration(input(), minted('tok-1'));
    await createAgentGroup({
      id: 'ag-other',
      name: 'other',
      folder: 'other',
      agent_provider: null,
      created_at: new Date().toISOString(),
    });

    await expect(
      addClientCredentialsIntegration(input({ agentGroupId: 'ag-other', replace: true }), minted('tok-2')),
    ).rejects.toThrow(/cannot change groups/);
    expect((await getMcpOAuthIntegration('looker-example'))?.agent_group_id).toBe('ag-example');
  });

  it('refuses a second integration for the same group and origin', async () => {
    await addClientCredentialsIntegration(input(), minted('tok-1'));

    await expect(addClientCredentialsIntegration(input({ name: 'looker-other' }), minted('tok-2'))).rejects.toThrow(
      /already serves/,
    );
    expect(await getMcpOAuthIntegration('looker-other')).toBeUndefined();
  });

  it.each([
    ['a path', `${API}/api/4.0`],
    ['a query', `${API}/?x=1`],
    ['credentials', API.replace('https://', `https://user:pw${'@'}`)],
  ])('refuses an --api-url with %s', async (_name, apiUrl) => {
    const endpoint = minted('tok-1');
    await expect(addClientCredentialsIntegration(input({ apiUrl }), endpoint)).rejects.toThrow(/bare https origin/);
    expect(endpoint).not.toHaveBeenCalled();
  });

  it('refuses to re-key an OAuth login integration, and a login refuses a client-credentials one', async () => {
    await upsertMcpOAuthIntegration({
      name: 'oauth-example',
      agent_group_id: 'ag-example',
      mcp_url: 'https://mcp.example.test/mcp',
      resource: null,
      grant_type: 'authorization_code',
      authorization_endpoint: 'https://as.example.test/authorize',
      token_endpoint: 'https://as.example.test/token',
      registration_endpoint: null,
      issuer: 'https://as.example.test',
      scopes: null,
      redirect_uri: 'http://127.0.0.1:8765/callback',
      bearer_secret_name: 'Oauth-MCP-Example',
      bearer_secret_id: null,
      host_pattern: 'mcp.example.test',
      path_pattern: null,
      status: 'active',
      status_detail: null,
      expires_at: null,
      last_refresh_at: null,
    });
    await expect(
      addClientCredentialsIntegration(input({ name: 'oauth-example', replace: true }), minted('t')),
    ).rejects.toThrow(/OAuth login integration/);

    await addClientCredentialsIntegration(input(), minted('tok-1'));
    const noNetwork = vi.fn(async () => {
      throw new Error('discovery must not run');
    });
    await expect(
      startLogin({ name: 'looker-example', mcpUrl: `${API}/mcp`, agentGroupId: 'ag-example' } as never, noNetwork),
    ).rejects.toThrow(/holds client credentials/);
    expect(noNetwork).not.toHaveBeenCalled();
  });
});

describe('rekeyClientCredentials', () => {
  it('swaps the pair and mints a token, keeping every other setting', async () => {
    await addClientCredentialsIntegration(input({ secretName: 'Looker-Example', scopes: 'read' }), minted('tok-1'));
    const before = await getMcpOAuthIntegration('looker-example');

    const result = await rekeyClientCredentials(
      'looker-example',
      { clientId: 'client-id-2', clientSecret: 'second-secret' },
      minted('tok-2'),
    );

    expect(result.status).toBe('active');
    expect(readMcpOAuthBundle('looker-example')).toMatchObject({
      clientId: 'client-id-2',
      clientSecret: 'second-secret',
    });
    expect(secretWrites.map((w) => [w.name, w.value])).toEqual([
      ['Looker-Example', 'tok-1'],
      ['Looker-Example', 'tok-2'],
    ]);
    expect(await getMcpOAuthIntegration('looker-example')).toMatchObject({
      agent_group_id: before?.agent_group_id,
      mcp_url: before?.mcp_url,
      token_endpoint: before?.token_endpoint,
      host_pattern: before?.host_pattern,
      scopes: 'read',
    });
  });

  it('keeps the old pair and token when the token endpoint refuses the new one', async () => {
    await addClientCredentialsIntegration(input(), minted('tok-1'));

    await expect(
      rekeyClientCredentials(
        'looker-example',
        { clientId: 'client-id-2', clientSecret: 'second-secret' },
        tokenEndpoint(404, {}),
      ),
    ).rejects.toBeInstanceOf(OAuthTokenError);

    expect(readMcpOAuthBundle('looker-example')?.clientId).toBe('client-id-1');
    expect(secretWrites.map((w) => w.value)).toEqual(['tok-1']);
    expect((await getMcpOAuthIntegration('looker-example'))?.status).toBe('active');
  });

  it('brings a needs_login integration back to active with a new pair', async () => {
    await addClientCredentialsIntegration(input(), minted('tok-1'));
    await markMcpOAuthIntegration('looker-example', { status: 'needs_login', status_detail: 'refused' });

    const result = await rekeyClientCredentials(
      'looker-example',
      { clientId: 'client-id-2', clientSecret: 'second-secret' },
      minted('tok-2'),
    );

    expect(result.status).toBe('active');
    expect((await getMcpOAuthIntegration('looker-example'))?.status).toBe('active');
    expect(readMcpOAuthBundle('looker-example')?.clientId).toBe('client-id-2');
  });

  it.each([
    ['another host', { host: 'other.example.test', agentGroupId: 'ag-example' }],
    ['another group', { host: 'example.cloud.looker.test', agentGroupId: 'ag-other' }],
  ])('refuses a re-key whose row now names %s, writing nothing', async (_name, expected) => {
    await addClientCredentialsIntegration(input(), minted('tok-1'));
    secretWrites.length = 0;
    const endpoint = minted('tok-2');

    await expect(
      rekeyClientCredentials('looker-example', { clientId: 'client-id-2', clientSecret: 'x' }, endpoint, expected),
    ).rejects.toBeInstanceOf(IntegrationChangedError);

    expect(endpoint).not.toHaveBeenCalled();
    expect(secretWrites).toEqual([]);
    expect(readMcpOAuthBundle('looker-example')?.clientId).toBe('client-id-1');
  });

  it.each([
    ['clientCredentialsIntegration', () => clientCredentialsIntegration('nothing')],
    ['rekeyClientCredentials', () => rekeyClientCredentials('nothing', { clientId: 'a', clientSecret: 'b' })],
  ])('%s refuses a name with no integration', async (_name, call) => {
    await expect(call()).rejects.toThrow(/No integration named/);
  });

  it('clientCredentialsIntegration answers the host of a client-credentials row, and refuses an OAuth login row', async () => {
    await addClientCredentialsIntegration(input(), minted('tok-1'));
    await upsertMcpOAuthIntegration({
      name: 'oauth-example',
      agent_group_id: 'ag-example',
      mcp_url: 'https://mcp.example.test/mcp',
      resource: null,
      grant_type: 'authorization_code',
      authorization_endpoint: 'https://as.example.test/authorize',
      token_endpoint: 'https://as.example.test/token',
      registration_endpoint: null,
      issuer: 'https://as.example.test',
      scopes: null,
      redirect_uri: 'http://127.0.0.1:8765/callback',
      bearer_secret_name: 'Oauth-MCP-Example',
      bearer_secret_id: null,
      host_pattern: 'mcp.example.test',
      path_pattern: null,
      status: 'active',
      status_detail: null,
      expires_at: null,
      last_refresh_at: null,
    });

    expect(await clientCredentialsIntegration('looker-example')).toEqual({
      host: 'example.cloud.looker.test',
      agentGroupId: 'ag-example',
    });
    await expect(clientCredentialsIntegration('oauth-example')).rejects.toThrow(/OAuth login integration/);
  });
});

describe('refreshing a client-credentials integration', () => {
  async function addThenExpire(): Promise<void> {
    await addClientCredentialsIntegration(input(), minted('tok-1'));
    tokenRequests.length = 0;
    secretWrites.length = 0;
    await markMcpOAuthIntegration('looker-example', {
      status: 'active',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
  }

  it('holds a minted token through a vault outage instead of minting another each tick', async () => {
    await addThenExpire();
    failSecretWrites = 1;

    await refreshExpiringMcpOAuthIntegrations(minted('tok-2'));
    await refreshExpiringMcpOAuthIntegrations(minted('tok-3'));

    expect(tokenRequests).toHaveLength(1);
    expect(secretWrites).toEqual([]);
  });

  it('mints with the client_credentials grant, never a refresh token', async () => {
    await addThenExpire();
    const outcome = await refreshExpiringMcpOAuthIntegrations(minted('tok-2'));

    expect(outcome.refreshed).toEqual(['looker-example']);
    expect(tokenRequests.map((f) => f.get('grant_type'))).toEqual(['client_credentials']);
    expect(secretWrites.map((w) => w.value)).toEqual(['tok-2']);
  });

  it.each([
    ['an OAuth refusal', 401, { error: 'invalid_client' }],
    ["Looker's refusal", 404, { message: 'Not found' }],
  ])('needs a human after %s, and does not retry it next tick', async (_name, status, body) => {
    await addThenExpire();
    const refused = tokenEndpoint(status, body);
    const first = await refreshExpiringMcpOAuthIntegrations(refused);
    const second = await refreshExpiringMcpOAuthIntegrations(refused);

    expect(first.needsLogin).toEqual(['looker-example']);
    expect(second.checked).toBe(0);
    expect(refused).toHaveBeenCalledTimes(1);
    expect((await getMcpOAuthIntegration('looker-example'))?.status_detail).toContain(
      'secrets intake --client-credentials',
    );
  });

  it.each([408, 429, 503])('leaves HTTP %i in `error` for the next tick', async (status) => {
    await addThenExpire();
    const outcome = await refreshExpiringMcpOAuthIntegrations(tokenEndpoint(status, {}));

    expect(outcome.failed).toEqual(['looker-example']);
    expect((await getMcpOAuthIntegration('looker-example'))?.status).toBe('error');
  });
});
