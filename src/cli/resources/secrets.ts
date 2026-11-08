// `intake` needs no approval: nothing is stored until an owner fills in the form, which is the consent.
import { TIMEZONE } from '../../config.js';
import {
  getSecretIntake,
  grantSecret,
  startSecretIntake,
  type SecretGrantResult,
  type SecretIntakeCaller,
  type SecretIntakeView,
} from '../../modules/secret-intake/service.js';
import { formatLocalTime } from '../../timezone.js';
import { registerResource } from '../crud.js';
import type { CallerContext } from '../frame.js';

function optionalString(raw: unknown): string | undefined {
  return raw === undefined || raw === null ? undefined : String(raw);
}

function list(raw: unknown): string[] {
  if (raw === undefined || raw === null) return [];
  return (Array.isArray(raw) ? raw : [raw]).map(String);
}

function callerOf(ctx: CallerContext): SecretIntakeCaller {
  return ctx.caller === 'agent'
    ? { kind: 'agent', sessionId: ctx.sessionId, agentGroupId: ctx.agentGroupId }
    : { kind: 'host' };
}

function formatIntake(v: SecretIntakeView): string {
  return [
    `Intake ${v.intakeId} — ${v.mode} "${v.secretName}": ${v.status}${v.detail ? ` (${v.detail})` : ''}`,
    `Form sent to: ${v.deliveredTo}`,
    ...(v.clientCredentials
      ? [`Stores:       the client-credentials pair of integration "${v.clientCredentials}", on this host`]
      : []),
    `Grants:       ${v.reservedFor ? `OneCLI agent ${v.reservedFor} only (lane token)` : [...v.groups.map((g) => `group ${g}`), ...v.workgroups.map((w) => `workgroup ${w}`)].join(', ') || '(none)'}`,
    `Expires:      ${formatLocalTime(v.expiresAt, TIMEZONE)}`,
  ].join('\n');
}

const grantArgs = [
  {
    name: 'groups',
    type: 'string' as const,
    multiple: true,
    description:
      'Agent group id(s) to grant it to, comma-separated, for a key only that member should hold. An agent may name only its own group.',
  },
  {
    name: 'workgroups',
    type: 'string' as const,
    multiple: true,
    description: 'Workgroup id(s) to grant it to, comma-separated; every member group inherits it. The default target.',
  },
];

registerResource({
  name: 'secret',
  plural: 'secrets',
  table: 'workgroups',
  description:
    'Store or rotate an API key in the OneCLI vault through a form the owner fills in, and grant secrets to groups or workgroups by name. No secret value ever passes through chat, argv or this CLI.',
  idColumn: 'id',
  columns: [],
  operations: {},
  customOperations: {
    intake: {
      access: 'open',
      description:
        "Ask for a secret. Posts a card into the requesting Slack or Discord thread (host callers, other platforms, and rotations outside the owner's own conversation: an owner's Slack DM); its button opens a form that an owner, a global admin, or (new secrets only) an admin of the requesting agent's group fills in, and the value typed there goes straight to the vault — you never see it. Returns at once; the requesting agent is told when it is stored (host callers: `ncl secrets intake-status`).\n\n" +
        'New secret: --host-pattern is required and decides where the gateway sends the value, so name the API host exactly. ' +
        'Rotation (--rotate): replaces only the value; the secret keeps its host, header and grants, and takes effect on the next request.\n\n' +
        'Multi-part credentials: declare each part with --field \'name|Label\' (repeatable, up to 5; a trailing ? on the name makes it optional). --compose basic joins exactly two required fields into one secret, base64("<first>:<second>"), sent as "Basic {value}" by default: HTTP Basic auth, or an OAuth client ID and secret at a token endpoint. --compose separate (the default for two or more fields) stores each field as its own secret <name>-<field>, each with its own header: --field \'name|Label|Header[|Format]\', format default "{value}"; a blank optional field stores nothing. A rotation repeats the --field names (no header) and replaces only the fields filled in. Only secret values go in the form: take a user id, subdomain or account id in chat. Never ask a user to encode or combine values themselves.\n\n' +
        "From an agent with no --groups/--workgroups, a new secret is granted to the calling group's workgroup, so every sibling gets it (a group in no workgroup gets it itself); name --groups only for a key one member alone should hold. A rotation grants nothing new. A new grant takes effect at the next container start.",
      args: [
        {
          name: 'name',
          type: 'string',
          description: 'Vault name, e.g. Linear-API-Key. Required unless --reserved-for.',
        },
        {
          name: 'reserved_for',
          type: 'string',
          description:
            'Host operator only: an approved-run-* OneCLI agent. The secret is named "<agent> token" and attached to that agent alone; needs an exact --path-pattern or --host-wide, and takes no --name, --groups or --workgroups, and no --field or --compose except --compose basic with two fields (an API that takes HTTP Basic).',
        },
        {
          name: 'host_wide',
          type: 'boolean',
          description:
            'With --reserved-for, new token only: send it on every path of --host-pattern, not one. Only for a lane whose token stays in host code and whose own allowlist decides what it calls: the gateway no longer limits the path. Takes no --path-pattern.',
        },
        {
          name: 'entered_by',
          type: 'string',
          description:
            'With --reserved-for: a namespaced user id who may enter it besides owners and global admins. They must be an admin of an agent group of a target that runs as that agent; the card goes to their DM only.',
        },
        { name: 'rotate', type: 'boolean', description: 'Replace the value of an existing secret.' },
        {
          name: 'client_credentials',
          type: 'string',
          description:
            'Host operator only: an existing client-credentials integration (ncl integrations add-client). The form takes its new client ID and secret, an owner or global admin enters them, and they go to the 0600 host store instead of the vault. A token is minted from the pair first, so a refused pair changes nothing. Takes no other flag.',
        },
        {
          name: 'host_pattern',
          type: 'string',
          multiple: true,
          description:
            'Host the value is injected for, e.g. api.linear.app. Required for a new secret. Repeat it (up to 4) for an API that authenticates on several hosts: one pasted value is stored once per host as <name>-1of<n> … <name>-<n>of<n>, all or none, and --rotate --name <name> rotates the whole set. host=format gives one host its own --value-format.',
        },
        { name: 'path_pattern', type: 'string', description: 'Optional path match, e.g. /v1/*.' },
        { name: 'header', type: 'string', description: 'Header to inject (default Authorization).' },
        {
          name: 'value_format',
          type: 'string',
          description: 'Header value template containing {value} (default "Bearer {value}").',
        },
        {
          name: 'field',
          type: 'string',
          multiple: true,
          description:
            "Repeatable form field: 'name[?]|Label[|Header[|Format]]'. Header and format only with --compose separate.",
        },
        {
          name: 'compose',
          type: 'string',
          enum: ['basic', 'separate'],
          description: 'How two or more fields become secrets: basic (one Basic-auth secret) or separate (default).',
        },
        ...grantArgs,
      ],
      examples: [
        'ncl secrets intake --name Linear-API-Key --host-pattern api.linear.app --value-format "{value}"',
        'ncl secrets intake --name Exa-API-Key --host-pattern api.exa.ai --header x-api-key --value-format "{value}" --workgroups example-wg',
        "ncl secrets intake --name Example-Client --host-pattern auth.example.com --path-pattern /token --compose basic --field 'client_id|Client ID' --field 'client_secret|Client secret'",
        "ncl secrets intake --name Example-API --host-pattern api.example.com --field 'api_key|API key|X-Api-Key' --field 'api_secret?|API secret|X-Api-Secret'",
        "ncl secrets intake --name Example-Cloud --host-pattern 'ab1.example.com=Token {value}' --host-pattern ab1.metadata.example.com --workgroups example-wg",
        'ncl secrets intake --name Linear-API-Key --rotate',
        'ncl secrets intake --client-credentials example-looker',
        'ncl secrets intake --reserved-for approved-run-example --host-pattern api.example.com --path-pattern /v1/things/one',
        'ncl secrets intake --reserved-for approved-run-example --host-pattern api.example.com --host-wide',
        "ncl secrets intake --reserved-for approved-run-example --host-pattern auth.example.com --path-pattern /oauth/token --compose basic --field 'client_id|Client ID' --field 'client_secret|Client secret'",
      ],
      handler: async (args, ctx) =>
        startSecretIntake({
          name: optionalString(args.name),
          reservedFor: optionalString(args.reserved_for),
          hostWide: args.host_wide === true,
          enteredBy: optionalString(args.entered_by),
          clientCredentials: optionalString(args.client_credentials),
          rotate: args.rotate === true || args.rotate === 'true',
          hostPattern: list(args.host_pattern),
          pathPattern: optionalString(args.path_pattern),
          headerName: optionalString(args.header),
          valueFormat: optionalString(args.value_format),
          fields: list(args.field),
          compose: optionalString(args.compose),
          groups: list(args.groups),
          workgroups: list(args.workgroups),
          caller: callerOf(ctx),
        }),
      formatHuman: (data) =>
        `${formatIntake(data as SecretIntakeView)}\n\nThe owner enters the value in the card's form; nothing is stored until then.`,
    },

    'intake-status': {
      access: 'open',
      description: 'Show where an intake stands: pending, storing, stored, failed or expired. Kept for an hour.',
      args: [{ name: 'id', type: 'string', description: 'Intake id from `ncl secrets intake`.', required: true }],
      handler: async (args) => {
        const found = getSecretIntake(String(args.id));
        if (!found)
          throw new Error(`No intake ${String(args.id)} (unknown, older than an hour, or the host restarted).`);
        return found;
      },
      formatHuman: (data) => formatIntake(data as SecretIntakeView),
    },

    grant: {
      access: 'approval',
      description:
        'Grant a secret already in the vault to workgroups (the default: every member inherits it) or, for a key one member alone should hold, to agent groups, by name. From an agent with no --groups/--workgroups it goes to the calling group’s workgroup. Takes effect at each group’s next container start. An agent’s call waits for admin approval.',
      args: [{ name: 'name', type: 'string', description: 'Vault name.', required: true }, ...grantArgs],
      examples: ['ncl secrets grant --name Linear-API-Key --workgroups example-wg'],
      handler: async (args, ctx) =>
        grantSecret({
          name: String(args.name),
          groups: list(args.groups),
          workgroups: list(args.workgroups),
          caller: callerOf(ctx),
        }),
      formatHuman: (data) => {
        const d = data as SecretGrantResult;
        return [
          `Granted "${d.secretName}":`,
          `  groups:     ${d.addedGroups.join(', ') || '(none new)'}`,
          `  workgroups: ${d.addedWorkgroups.join(', ') || '(none new)'}`,
          ...(d.alreadyGranted.length ? [`  already had it: ${d.alreadyGranted.join(', ')}`] : []),
          'Restart a group to pick it up: ncl groups restart --id <group>',
        ].join('\n');
      },
    },
  },
});
