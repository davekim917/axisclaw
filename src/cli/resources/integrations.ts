/**
 * `ncl integrations`: connect a remote MCP server via OAuth rather than a pasted key. The default is a two-step paste
 * (`login` prints a URL, `complete` takes the landed URL); nothing on this host opens a browser.
 * Every mutating verb is `hostOnly`: a login mints a credential on the operator's third-party account, which no
 * `cli_scope` or approval makes appropriate for an agent. `list` stays open (no token material). No generic
 * create/update/delete: a row without its OAuth bundle and OneCLI secret is meaningless.
 * Flag names in ColumnDefs are snake_case, ALWAYS: `normalizeArgs` runs before `validateArgs`, so a hyphenated
 * declaration matches nothing (enforced by `src/cli/flag-name-normalization.test.ts`).
 */
import { TIMEZONE } from '../../config.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import {
  addClientCredentialsIntegration,
  completeLogin,
  refreshExpiringMcpOAuthIntegrations,
  removeIntegration,
  startLogin,
} from '../../modules/mcp-oauth/service.js';
import { formatLocalTime } from '../../timezone.js';
import { registerResource } from '../crud.js';

/** `true` from argv, a real boolean over JSON. */
function flag(raw: unknown): boolean {
  return raw === true || raw === 'true';
}

function parseExtraParams(raw: unknown): Record<string, string> | undefined {
  if (raw === undefined) return undefined;
  const items = (Array.isArray(raw) ? raw : [raw])
    .flatMap((s) => String(s).split(','))
    .map((s) => s.trim())
    .filter(Boolean);
  if (items.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const item of items) {
    const eq = item.indexOf('=');
    if (eq <= 0) throw new Error(`--authorize-param expects key=value, got "${item}"`);
    out[item.slice(0, eq)] = item.slice(eq + 1);
  }
  return out;
}

registerResource({
  name: 'integration',
  plural: 'integrations',
  table: 'mcp_oauth_integrations',
  description:
    'Remote MCP servers connected over standard MCP authorization (OAuth 2.0 authorization-code + PKCE + dynamic client registration). The host holds the refresh token and keeps the OneCLI bearer secret the container reads fresh; no API key is ever pasted. Rows carry endpoints, scopes, secret NAMES and status — never token material.',
  idColumn: 'name',
  columns: [
    { name: 'name', type: 'string', description: 'Operator-chosen handle; unique across the install.' },
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'Agent group whose container.json declares the bearer secret.',
    },
    { name: 'mcp_url', type: 'string', description: 'The MCP endpoint, e.g. https://mcp.dropbox.com/mcp.' },
    {
      name: 'resource',
      type: 'string',
      description: 'RFC 8707 resource indicator from the protected-resource metadata.',
    },
    { name: 'authorization_endpoint', type: 'string', description: 'Discovered.' },
    { name: 'token_endpoint', type: 'string', description: 'Discovered. May be on a different host from the issuer.' },
    { name: 'registration_endpoint', type: 'string', description: 'Discovered; used for dynamic client registration.' },
    { name: 'issuer', type: 'string', description: 'Authorization server issuer.' },
    { name: 'scopes', type: 'string', description: 'Space-delimited scopes the grant was requested with.' },
    { name: 'redirect_uri', type: 'string', description: 'Loopback redirect the authorization code comes back to.' },
    { name: 'bearer_secret_name', type: 'string', description: 'OneCLI secret whose value the gateway injects.' },
    { name: 'bearer_secret_id', type: 'string', description: "That secret's vault UUID." },
    { name: 'host_pattern', type: 'string', description: 'Gateway host match for the injection.' },
    { name: 'path_pattern', type: 'string', description: 'Gateway path match for the injection.' },
    {
      name: 'status',
      type: 'string',
      description: 'pending (login started) | active | needs_login (grant dead) | error (transient refresh failure).',
      enum: ['pending', 'active', 'needs_login', 'error'],
    },
    { name: 'status_detail', type: 'string', description: 'Why, when status is not active.' },
    { name: 'expires_at', type: 'string', description: 'Access-token expiry (ISO-8601 UTC).' },
    { name: 'last_refresh_at', type: 'string', description: 'Last successful token mint.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.' },
    { name: 'updated_at', type: 'string', description: 'Auto-set.' },
  ],
  operations: { list: 'open', get: 'open' },
  listOrder: 'name ASC',
  customOperations: {
    login: {
      access: 'open',
      hostOnly: true,
      description:
        'Start an OAuth login for a remote MCP server. Discovers the authorization server from the MCP URL, registers a client dynamically, and prints a URL to open in a browser. Nothing is granted until `ncl integrations complete`.\n\n' +
        'The host is headless, so open the printed URL on your own machine. The redirect lands on a loopback address nothing is listening on — your browser will show a connection error, and the address bar holds the code. Copy that whole URL into `ncl integrations complete --redirect-url`.',
      args: [
        {
          name: 'name',
          type: 'string',
          description: 'Handle for this integration (lowercase, hyphens).',
          required: true,
        },
        { name: 'url', type: 'string', description: 'The MCP endpoint URL.', required: true },
        {
          name: 'group',
          type: 'string',
          description:
            "Agent group id that owns the integration. The bearer is declared on that group's workgroup, so every member gets it (a group in no workgroup declares it itself).",
          required: true,
        },
        {
          name: 'scopes',
          type: 'string',
          description: "Space-delimited scope override. Defaults to the resource metadata's scopes_supported.",
        },
        {
          name: 'issuer',
          type: 'string',
          description: 'Authorization server override, when the resource lists more than one.',
        },
        {
          name: 'secret',
          type: 'string',
          description:
            'OneCLI secret name to write the bearer into. Defaults to <Name>-MCP-<Group>; point it at an existing secret to adopt it.',
        },
        {
          name: 'redirect_uri',
          type: 'string',
          description:
            'Loopback redirect override (default http://127.0.0.1:8765/callback). Must be a URI the authorization server will accept.',
        },
        {
          name: 'client_name',
          type: 'string',
          description: 'Client name sent to dynamic registration (default NanoClaw).',
        },
        {
          name: 'authorize_param',
          type: 'string',
          multiple: true,
          description:
            'Extra authorize-endpoint parameter, key=value. Repeatable. Dropbox needs token_access_type=offline to issue a refresh token.',
        },
        {
          name: 'no_resource',
          type: 'boolean',
          description: 'Omit the RFC 8707 resource parameter, for a server that rejects it.',
        },
        {
          name: 'listen',
          type: 'boolean',
          description:
            'Opt-in: also bind a loopback listener here, so a forwarded port (ssh -L 8765:127.0.0.1:8765) completes the login with no paste. The paste path stays open either way.',
        },
        {
          name: 'port',
          type: 'number',
          description:
            'Loopback port for the redirect URI and --listen (default 8765). A re-login keeps the port its client was registered with.',
        },
        {
          name: 'listen_timeout',
          type: 'number',
          description: 'Seconds the --listen listener stays up (default 600).',
        },
        {
          name: 'device',
          type: 'boolean',
          description:
            'Opt-in: use the RFC 8628 device grant instead of a redirect. Only works where the server publishes device_authorization_endpoint.',
        },
        {
          name: 'device_endpoint',
          type: 'string',
          description:
            'Device-authorization endpoint for a server that advertises the device_code grant without publishing the endpoint.',
        },
      ],
      examples: [
        'ncl integrations login --name dropbox-files --url https://mcp.dropbox.com/mcp --group ag-123 --authorize-param token_access_type=offline',
        'ncl integrations login --name amplitude-analytics --url https://mcp.amplitude.com/mcp --group ag-123 --secret Amplitude-MCP-Analytics',
      ],
      handler: async (args) => {
        const group = await getAgentGroup(String(args.group));
        if (!group) throw new Error(`Agent group not found: ${String(args.group)}`);
        const result = await startLogin({
          name: String(args.name),
          mcpUrl: String(args.url),
          agentGroupId: group.id,
          scopes: args.scopes === undefined ? undefined : String(args.scopes),
          issuer: args.issuer === undefined ? undefined : String(args.issuer),
          secretName: args.secret === undefined ? undefined : String(args.secret),
          redirectUri: args.redirect_uri === undefined ? undefined : String(args.redirect_uri),
          clientName: args.client_name === undefined ? undefined : String(args.client_name),
          extraAuthorizeParams: parseExtraParams(args.authorize_param),
          noResourceIndicator: flag(args.no_resource),
          listen: flag(args.listen),
          port: args.port === undefined ? undefined : Number(args.port),
          listenTimeoutSeconds: args.listen_timeout === undefined ? undefined : Number(args.listen_timeout),
          device: flag(args.device),
          deviceEndpoint: args.device_endpoint === undefined ? undefined : String(args.device_endpoint),
        });
        return {
          ...result,
          next: `ncl integrations complete --name ${result.name} --redirect-url '<paste the URL your browser landed on>'`,
        };
      },
      formatHuman: (data) => {
        const d = data as Awaited<ReturnType<typeof startLogin>> & { next: string };
        const head = [
          `Integration "${d.name}" — client ${d.registered === 'dynamic' ? 'registered dynamically' : 'reused from a previous login'}.`,
          `Bearer secret: ${d.bearerSecretName}`,
          `Scopes:        ${d.scopes || '(none requested)'}`,
          '',
        ];

        if (d.mode === 'device' && d.device) {
          return [
            ...head,
            '1. Open this on YOUR machine:',
            '',
            `   ${d.device.verificationUriComplete ?? d.device.verificationUri}`,
            '',
            `2. Enter the code: ${d.device.userCode}`,
            `   It expires in ${Math.round(d.device.expiresInSeconds / 60)} minutes.`,
            '',
            '3. This finishes on its own once you approve. Confirm with:',
            '',
            '   ncl integrations list',
          ].join('\n');
        }

        const lines = [
          ...head,
          '1. Open this on YOUR machine (this host has no browser):',
          '',
          `   ${d.authorizationUrl}`,
          '',
          '2. Approve. Your browser will fail to load the redirect — that is expected.',
          '3. Copy the whole URL from the address bar and run:',
          '',
          `   ${d.next}`,
        ];

        if (d.loopback) {
          lines.push(
            '',
            `Optional — a listener is up on 127.0.0.1:${d.loopback.port} for ${Math.round(d.loopback.timeoutSeconds / 60)} minutes.`,
            'Forward it from another terminal and step 3 happens by itself:',
            '',
            `   ${d.loopback.sshTunnelCommand}`,
          );
        } else if (d.loopbackError) {
          lines.push('', `(--listen could not bind: ${d.loopbackError} — use the paste above.)`);
        }

        return lines.join('\n');
      },
    },

    complete: {
      access: 'open',
      hostOnly: true,
      description:
        "Finish a login by exchanging the authorization code. Takes the whole redirect URL your browser landed on (or a bare code). Writes the access token into the OneCLI secret, stores the refresh token host-side, and declares the secret in the group's container.json.",
      args: [
        { name: 'name', type: 'string', description: 'Integration handle from `login`.', required: true },
        {
          name: 'redirect_url',
          type: 'string',
          description: 'The URL the browser landed on. A bare ?code=…&state=… or a bare code also works.',
          required: true,
        },
      ],
      examples: [
        "ncl integrations complete --name dropbox-files --redirect-url 'http://127.0.0.1:8765/callback?code=abc&state=xyz'",
      ],
      handler: async (args) => completeLogin({ name: String(args.name), redirectResponse: String(args.redirect_url) }),
      formatHuman: (data) => {
        const d = data as Awaited<ReturnType<typeof completeLogin>>;
        const lines = [
          `Connected "${d.name}".`,
          `Secret:   ${d.secretName} (${d.secretId})`,
          `Expires:  ${d.expiresAt ? formatLocalTime(d.expiresAt, TIMEZONE) : 'not stated by the server'}`,
          `Scopes:   ${d.scopes ?? '(not stated)'}`,
          d.declaredOn.added
            ? `Declared the secret on ${d.declaredOn.kind} ${d.declaredOn.id} — it is granted at the next spawn${d.declaredOn.kind === 'workgroup' ? ' of every member' : ''}.`
            : `The secret was already declared on ${d.declaredOn.kind} ${d.declaredOn.id}.`,
        ];
        if (!d.hasRefreshToken) {
          lines.push(
            '',
            'WARNING: the server issued no refresh token, so this bearer cannot be renewed automatically.',
            "Re-run `login` with the provider's offline flag (Dropbox: --authorize-param token_access_type=offline;",
            'many servers: --scopes "<scopes> offline_access").',
          );
        }
        lines.push('', 'Restart the group to pick it up: ncl groups restart --id <agent-group-id>');
        return lines.join('\n');
      },
    },

    remove: {
      access: 'open',
      hostOnly: true,
      description:
        "Forget an integration: deletes the registry row and the host-side OAuth bundle. The OneCLI secret and its declarations (the owning group's workgroup, or its container.json) are left alone unless --delete-secret is given, because the secret may predate this integration and other requests may match on it.",
      args: [
        { name: 'name', type: 'string', description: 'Integration handle.', required: true },
        {
          name: 'delete_secret',
          type: 'boolean',
          description:
            "Also delete the OneCLI bearer secret, dropping it from the owning group's workgroup onecli_secrets and its container.json onecliSecrets first, under the same lock the refresher takes. REFUSES, deleting nothing, if the secret is declared anywhere this cannot edit — another workgroup's onecli_secrets, or another group's container.json — because the spawn takes the union of those and a deleted secret they still declare aborts every spawn that inherits it.",
        },
      ],
      handler: async (args) =>
        removeIntegration(String(args.name), {
          deleteSecret: flag(args.delete_secret),
        }),
      formatHuman: (data) => {
        const d = data as Awaited<ReturnType<typeof removeIntegration>>;
        const lines = [
          `removed: ${d.name}`,
          `registry row: ${d.removedRow ? 'deleted' : 'not found'}`,
          `oauth bundle: ${d.removedBundle ? 'deleted' : 'not found'}`,
        ];
        // Speaks about the declaration only when --delete-secret was requested: only then did the refusal above prove
        // the owning file was the only declaration site.
        if (d.secretName && d.deleteSecretRequested) {
          lines.push(
            `bearer secret ${d.secretName}: ${d.removedSecret ? 'deleted from the vault' : 'not found in the vault'}`,
          );
          lines.push(
            `declaration (workgroup / container.json): ${d.undeclaredSecret ? 'removed (they were the only ones)' : 'none to remove'}`,
          );
        } else if (d.secretName) {
          lines.push(
            `bearer secret ${d.secretName}: left in the vault, and every declaration of it is untouched — drop them ` +
              'unless you meant to keep granting it (a declared secret is re-granted on every spawn)',
          );
        }
        return lines.join('\n');
      },
    },

    'add-client': {
      access: 'open',
      hostOnly: true,
      description:
        "Connect an API that issues tokens for a client id and secret (OAuth client_credentials, e.g. Looker's /api/4.0/login). The host reads the pair from two of its own env vars, named here, never typed: the values go to the 0600 host bundle store, a token is minted to prove them before anything is stored, and the sweep keeps a short-lived token in a OneCLI secret on the API host, declared on the group's workgroup. --replace gives an existing integration new credentials.",
      args: [
        { name: 'name', type: 'string', description: 'Integration handle.', required: true },
        {
          name: 'group',
          type: 'string',
          description: 'Agent group id whose workgroup gets the token.',
          required: true,
        },
        {
          name: 'api_url',
          type: 'string',
          description: 'API origin, e.g. https://example.cloud.looker.com.',
          required: true,
        },
        {
          name: 'token_url',
          type: 'string',
          description: 'Token endpoint, e.g. https://example.cloud.looker.com/api/4.0/login.',
          required: true,
        },
        {
          name: 'client_id_env',
          type: 'string',
          description: 'Name of the host env var holding the client id.',
          required: true,
        },
        {
          name: 'client_secret_env',
          type: 'string',
          description: 'Name of the host env var holding the client secret.',
          required: true,
        },
        { name: 'secret', type: 'string', description: 'OneCLI secret name (default <Name>-MCP-<Group>).' },
        { name: 'scopes', type: 'string', description: 'Space-delimited scopes, when the token endpoint takes them.' },
        {
          name: 'replace',
          type: 'boolean',
          description: 'Give an existing client-credentials integration new credentials.',
        },
      ],
      handler: async (args) => {
        const fromEnv = (flagName: string, raw: unknown): string => {
          const envName = String(raw);
          if (!/^[A-Z][A-Z0-9_]*$/.test(envName))
            throw new Error(`--${flagName} must be an env var name, not a value.`);
          const value = process.env[envName];
          if (!value) throw new Error(`Host env var ${envName} is not set.`);
          return value;
        };
        return addClientCredentialsIntegration({
          name: String(args.name),
          agentGroupId: String(args.group),
          apiUrl: String(args.api_url),
          tokenUrl: String(args.token_url),
          clientId: fromEnv('client-id-env', args.client_id_env),
          clientSecret: fromEnv('client-secret-env', args.client_secret_env),
          secretName: args.secret === undefined ? undefined : String(args.secret),
          scopes: args.scopes === undefined ? undefined : String(args.scopes),
          replace: flag(args.replace),
        });
      },
      formatHuman: (data) => {
        const d = data as Awaited<ReturnType<typeof addClientCredentialsIntegration>>;
        return [
          `integration: ${d.name}`,
          `status: ${d.status}${d.statusDetail ? ` — ${d.statusDetail}` : ''}`,
          `token secret: ${d.bearerSecretName} on ${d.hostPattern}`,
          `token expires: ${d.expiresAt ? formatLocalTime(d.expiresAt, TIMEZONE) : 'unknown'}`,
          'Restart the group to pick up a new declaration: ncl groups restart --id <agent-group-id>',
        ].join('\n');
      },
    },

    refresh: {
      access: 'open',
      hostOnly: true,
      description:
        'Run the refresh pass the host sweep runs every 60 seconds, now. Refreshes every active integration inside its expiry margin; reports which were refreshed, which failed, and which need a fresh login.',
      args: [],
      handler: async () => refreshExpiringMcpOAuthIntegrations(),
      formatHuman: (data) => {
        const d = data as Awaited<ReturnType<typeof refreshExpiringMcpOAuthIntegrations>>;
        return [
          `due: ${d.checked}`,
          `refreshed: ${d.refreshed.join(', ') || '(none)'}`,
          `failed: ${d.failed.join(', ') || '(none)'}`,
          `needs login: ${d.needsLogin.join(', ') || '(none)'}`,
        ].join('\n');
      },
    },
  },
});
