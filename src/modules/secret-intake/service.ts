// The value lives only between the form submit and the vault write: never logged, returned, persisted or posted.
import { randomBytes } from 'crypto';

import type { SecretIntakeHooks } from '../../channels/adapter.js';
import { TIMEZONE } from '../../config.js';
import { withCentralSync, withRawDb } from '../../db/central-lease.js';
import { readContainerConfig } from '../../container-config.js';
import { addWorkgroupOnecliSecret, getAgentGroup, workgroupExists } from '../../db/agent-groups.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getWorkgroupChannelTypes } from '../../db/workgroup-surfaces.js';
import { getSession } from '../../db/sessions.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { declareGroupSecret } from '../../onecli-secret-grants.js';
import { assertSecretNotReserved } from '../../onecli-secrets.js';
import {
  createOnecliSecret,
  deleteOnecliSecret,
  findOnecliSecretByName,
  findOnecliSecretsByName,
  listOnecliSecrets,
  updateOnecliSecretValue,
  type OnecliInjectionSpec,
  type OnecliSecretRef,
} from '../../onecli-secret-writer.js';
import { isReservedAgent, reservedTokenName } from '../../reserved-secrets.js';
import {
  createReservedToken,
  ReservedTokenMayBeLive,
  rotateReservedToken,
  writeReservedTokenAlone,
} from '../../reserved-token-store.js';
import { isDiscordChannelType, isSlackChannelType } from '../../router.js';
import { equivalentSlackUserIds } from '../../slack-user-identity.js';
import { formatLocalTime } from '../../timezone.js';
import type { AgentGroup } from '../../types.js';
import { OAuthTokenError } from '../mcp-oauth/oauth-client.js';
import { clientCredentialsIntegration, IntegrationChangedError, rekeyClientCredentials } from '../mcp-oauth/service.js';
import { targetsUsing } from '../approved-run/targets.js';
import { notifyAgent, pickApprovalDelivery, pickOwnersFirst } from '../approvals/primitive.js';
import { isAdminOfAgentGroup, isGlobalAdmin, isOwner } from '../permissions/db/user-roles.js';
import { isOwnerSafeSlackSession } from '../permissions/slack-user-token-gate.js';
import { getUser } from '../permissions/db/users.js';
import { resolveUserChannelType } from '../permissions/user-dm.js';

const INTAKE_TTL_MS = 24 * 60 * 60_000;
const FINISHED_RETENTION_MS = 60 * 60_000;
const SECRET_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const HEADER_NAME_RE = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/;
const HOST_PATTERN_RE = /^([A-Za-z0-9-]+\.)+[A-Za-z0-9-]+$/;
const PATH_PATTERN_RE = /^\/[!-~]{0,255}$/;
const VALUE_FORMAT_RE = /^[ -~]{1,200}$/;
const MAX_PENDING_PER_SESSION = 3;
const OPEN_AUTHORITY_WAIT_MS = 1000;
const FIELD_ID_RE = /^[a-z][a-z0-9_]{0,31}$/;
const LABEL_RE = /^[^|\n]{1,40}$/;
const MAX_FIELDS = 5;
const MAX_HOSTS = 4;

type SecretIntakeStatus = 'pending' | 'storing' | 'stored' | 'failed' | 'expired';

export type SecretIntakeCaller = { kind: 'host' } | { kind: 'agent'; sessionId: string; agentGroupId: string };

export interface StartSecretIntakeInput {
  name?: string;
  /** An approved-run lane agent: the secret is its reserved token, attached to it alone. */
  reservedFor?: string;
  /** With `reservedFor`: store no path rule, so the gateway injects the token on every path of its host. */
  hostWide?: boolean;
  /** With `reservedFor`: the one user, besides owners and global admins, who may enter it; the card goes to their DM. */
  enteredBy?: string;
  /** A client-credentials integration whose new pair the card takes for the host store, not the vault. */
  clientCredentials?: string;
  rotate: boolean;
  /** One host, or up to MAX_HOSTS for one pasted value stored once per host; `host=format` sets that host's format. */
  hostPattern?: string | readonly string[];
  pathPattern?: string;
  headerName?: string;
  valueFormat?: string;
  fields?: string[];
  compose?: string;
  groups: string[];
  workgroups: string[];
  caller: SecretIntakeCaller;
}

type Compose = 'single' | 'basic' | 'separate';

interface FormField {
  id: string;
  label: string;
  optional: boolean;
}

interface VaultTarget {
  name: string;
  injection: OnecliInjectionSpec | null;
  fieldIds: string[];
  hostWide?: boolean;
  /** A rotation's host as the vault has it, shown on the card. */
  currentHost?: string | null;
  /** Kept in the host store instead of the vault; the host its minted token goes to, shown on the card. */
  hostStoreFor?: string;
}

interface Intake {
  id: string;
  secretName: string;
  rotate: boolean;
  compose: Compose;
  fields: FormField[];
  targets: VaultTarget[];
  groups: string[];
  workgroups: string[];
  reservedFor: string | null;
  /** The client-credentials integration this card re-keys. */
  clientCredentials: { integration: string; host: string; agentGroupId: string } | null;
  /** The named user and the agent groups that qualified them; they may enter only while still an admin of one. */
  enteredBy: { userId: string; agentGroups: string[] } | null;
  sessionId: string | null;
  requester: { agentGroupId: string; agentName: string; workgroupId: string | null } | null;
  card: {
    channelType: string;
    platformId: string;
    threadId: string | null;
    instance: string;
    messageId: string | null;
  };
  deliveredTo: string;
  expiresAt: number;
  status: SecretIntakeStatus;
  detail: string | null;
  finishedAt: number | null;
}

export interface SecretIntakeView {
  intakeId: string;
  secretName: string;
  secrets: string[];
  mode: 'create' | 'rotate';
  status: SecretIntakeStatus;
  detail: string | null;
  deliveredTo: string;
  expiresAt: string;
  groups: string[];
  workgroups: string[];
  reservedFor: string | null;
  /** The integration whose pair goes to the host store, for a `--client-credentials` card. */
  clientCredentials: string | null;
}

const intakes = new Map<string, Intake>();

function view(intake: Intake): SecretIntakeView {
  return {
    intakeId: intake.id,
    secretName: intake.secretName,
    secrets: intake.clientCredentials ? [] : intake.targets.map((target) => target.name),
    clientCredentials: intake.clientCredentials?.integration ?? null,
    mode: intake.rotate ? 'rotate' : 'create',
    status: intake.status,
    detail: intake.detail,
    deliveredTo: intake.deliveredTo,
    expiresAt: new Date(intake.expiresAt).toISOString(),
    groups: intake.groups,
    workgroups: intake.workgroups,
    reservedFor: intake.reservedFor,
  };
}

function prune(now: number): void {
  for (const [id, intake] of intakes) {
    if (intake.status === 'pending' && now >= intake.expiresAt) {
      intake.status = 'expired';
      intake.finishedAt = now;
      void editCard(intake, `${cardTitle(intake)}\n\nExpired — nothing was stored.`);
    }
    if (intake.finishedAt !== null && now - intake.finishedAt >= FINISHED_RETENTION_MS) intakes.delete(id);
  }
}

function splitList(values: string[]): string[] {
  return [
    ...new Set(
      values
        .flatMap((v) => v.split(','))
        .map((v) => v.trim())
        .filter(Boolean),
    ),
  ];
}

function replacedText(intake: Intake): string {
  return `${cardTitle(intake)}\n\nReplaced by a newer request — nothing was stored.`;
}

function cardTitle(intake: Pick<Intake, 'rotate' | 'secretName'>): string {
  return `🔐 ${intake.rotate ? 'Rotate' : 'New'} secret: ${intake.secretName}`;
}

function grantsLine(
  groups: string[],
  workgroups: string[],
  rotate: boolean,
  reservedFor: string | null = null,
): string {
  if (reservedFor)
    return `Attached only to OneCLI agent ${reservedFor}, for the approved-run lane; no agent group or container gets it`;
  const parts = [
    ...(groups.length ? [`groups ${groups.join(', ')}`] : []),
    ...(workgroups.length ? [`workgroups ${workgroups.join(', ')}`] : []),
  ];
  if (rotate) return `New grants: ${parts.length ? parts.join('; ') : 'none; current holders keep it'}`;
  return `Granted to: ${parts.length ? parts.join('; ') : 'nobody yet (vault only)'}`;
}

function injectionLine(spec: OnecliInjectionSpec, hostWide?: boolean): string {
  const path = hostWide ? ' (every path on that host)' : spec.pathPattern ? ` (path ${spec.pathPattern})` : '';
  const where = `${spec.hostPattern}${path}`;
  return `Sent only to ${where}, as header \`${spec.headerName}: ${spec.valueFormat.replace('{value}', '<secret>')}\``;
}

interface HostEntry {
  hostPattern: string;
  valueFormat?: string;
}

function hostEntries(input: StartSecretIntakeInput): HostEntry[] {
  const raw = (
    input.hostPattern === undefined
      ? []
      : typeof input.hostPattern === 'string'
        ? [input.hostPattern]
        : [...input.hostPattern]
  ).filter((entry) => entry.trim() !== '');
  const entries = raw.map((entry): HostEntry => {
    const eq = entry.indexOf('=');
    return eq < 0
      ? { hostPattern: entry.trim() }
      : { hostPattern: entry.slice(0, eq).trim(), valueFormat: entry.slice(eq + 1) };
  });
  if (entries.length > MAX_HOSTS) throw new Error(`At most ${MAX_HOSTS} --host-pattern entries.`);
  const seen = new Set<string>();
  for (const { hostPattern } of entries) {
    if (seen.has(hostPattern.toLowerCase())) throw new Error(`Host ${hostPattern} is named twice.`);
    seen.add(hostPattern.toLowerCase());
  }
  return entries;
}

function hostsAndPath(input: StartSecretIntakeInput): { hosts: HostEntry[]; pathPattern: string | null } {
  const hosts = hostEntries(input);
  if (
    hosts.length === 0 ||
    hosts.some(({ hostPattern }) => hostPattern.length > 253 || !HOST_PATTERN_RE.test(hostPattern))
  ) {
    throw new Error(
      '--host-pattern is required: one exact host such as api.example.com (no scheme, path or wildcard).',
    );
  }
  const pathPattern = input.pathPattern?.trim() || null;
  if (pathPattern !== null && !PATH_PATTERN_RE.test(pathPattern)) {
    throw new Error('--path-pattern must start with / and contain no spaces.');
  }
  return { hosts, pathPattern };
}

function hostAndPath(input: StartSecretIntakeInput): { hostPattern: string; pathPattern: string | null } {
  const { hosts, pathPattern } = hostsAndPath(input);
  if (hosts.length > 1 || hosts[0].valueFormat !== undefined) {
    throw new Error('Several hosts, or a host=format pairing, take one pasted value: drop --field and --compose.');
  }
  return { hostPattern: hosts[0].hostPattern, pathPattern };
}

/** A set's members are named so a rotation can tell from the vault alone whether every one is still there. */
function setMemberName(stem: string, index: number, size: number): string {
  return `${stem}-${index}of${size}`;
}

function setMemberRe(stem: string): RegExp {
  return new RegExp(`^${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-([1-9][0-9]*)of([1-9][0-9]*)$`);
}

function headerAndFormat(rawHeader: string | undefined, rawFormat: string | undefined, defaultFormat: string) {
  const headerName = rawHeader?.trim() || 'Authorization';
  if (!HEADER_NAME_RE.test(headerName)) throw new Error(`Invalid header name: "${headerName}"`);
  const valueFormat = rawFormat ?? defaultFormat;
  if (!VALUE_FORMAT_RE.test(valueFormat) || !valueFormat.includes('{value}')) {
    throw new Error(`Value format "${valueFormat}" must be one line of plain text containing {value}.`);
  }
  return { headerName, valueFormat };
}

function injectionFor(input: StartSecretIntakeInput, name: string, defaultFormat: string): OnecliInjectionSpec | null {
  if (input.rotate) return null;
  return { name, ...hostAndPath(input), ...headerAndFormat(input.headerName, input.valueFormat, defaultFormat) };
}

interface FieldSpec extends FormField {
  header?: string;
  format?: string;
}

function parseFieldSpec(spec: string): FieldSpec {
  const [rawId = '', rawLabel, header, ...formatParts] = spec.split('|');
  const optional = rawId.trim().endsWith('?');
  const id = rawId.trim().replace(/\?$/, '');
  if (!FIELD_ID_RE.test(id)) {
    throw new Error(`Field name "${id}" must be 1-32 lowercase letters, digits or "_", starting with a letter.`);
  }
  const label = rawLabel?.trim() || id;
  if (!LABEL_RE.test(label)) throw new Error(`Field label "${label}" must be one line of at most 40 characters.`);
  return {
    id,
    label,
    optional,
    header: header?.trim() || undefined,
    format: formatParts.length ? formatParts.join('|') : undefined,
  };
}

function planForm(
  input: StartSecretIntakeInput,
  name: string,
): { compose: Compose; fields: FormField[]; targets: VaultTarget[] } {
  if (input.rotate && (hostEntries(input).length || input.pathPattern || input.headerName || input.valueFormat)) {
    throw new Error(
      '--rotate replaces only the value; the host, path, header and format stay as the secret has them. Drop those flags.',
    );
  }
  const specs = (input.fields ?? []).map(parseFieldSpec);
  if (specs.length === 0) {
    if (input.compose !== undefined) throw new Error('--compose needs --field.');
    const id = 'secret_value';
    const fields = [{ id, label: input.rotate ? 'New value' : 'Secret value', optional: false }];
    if (input.rotate) return { compose: 'single', fields, targets: [{ name, injection: null, fieldIds: [id] }] };
    const { hosts, pathPattern } = hostsAndPath(input);
    const { headerName, valueFormat } = headerAndFormat(input.headerName, input.valueFormat, 'Bearer {value}');
    const targets = hosts.map((host, i): VaultTarget => {
      const secretName = hosts.length === 1 ? name : setMemberName(name, i + 1, hosts.length);
      if (hosts.length > 1 && !SECRET_NAME_RE.test(secretName))
        throw new Error(`Secret name "${secretName}" is longer than 64 characters.`);
      const format =
        host.valueFormat === undefined ? valueFormat : headerAndFormat(headerName, host.valueFormat, '').valueFormat;
      return {
        name: secretName,
        injection: { name: secretName, hostPattern: host.hostPattern, pathPattern, headerName, valueFormat: format },
        fieldIds: [id],
      };
    });
    return { compose: 'single', fields, targets };
  }
  if (specs.length > MAX_FIELDS) throw new Error(`At most ${MAX_FIELDS} --field entries.`);
  const duplicate = specs.find((spec, i) => specs.findIndex((other) => other.id === spec.id) !== i);
  if (duplicate) throw new Error(`Field "${duplicate.id}" is declared twice.`);
  const compose = (input.compose ?? (specs.length === 1 ? 'single' : 'separate')) as Compose;
  const plain = (spec: FieldSpec): FormField => ({ id: spec.id, label: spec.label, optional: spec.optional });

  if (compose !== 'separate') {
    const perField = specs.find((spec) => spec.header || spec.format);
    if (perField) {
      throw new Error(
        `Field "${perField.id}" names a header or format; only --compose separate takes those per field.`,
      );
    }
    if (compose === 'basic' && (specs.length !== 2 || specs.some((spec) => spec.optional))) {
      throw new Error(
        '--compose basic needs exactly two required fields (user or client ID, then password or secret).',
      );
    }
    if (compose === 'single' && specs[0].optional) {
      throw new Error('A single field is the whole secret, so it cannot be optional; declare two or more to compose.');
    }
    const defaultFormat = compose === 'basic' ? 'Basic {value}' : 'Bearer {value}';
    return {
      compose,
      fields: specs.map(plain),
      targets: [{ name, injection: injectionFor(input, name, defaultFormat), fieldIds: specs.map((spec) => spec.id) }],
    };
  }

  if (specs.length < 2) throw new Error('--compose separate needs two or more fields.');
  if (input.headerName !== undefined || input.valueFormat !== undefined) {
    throw new Error('With --compose separate, give each field its own header and format in --field, not --header.');
  }
  const where = input.rotate ? null : hostAndPath(input);
  const headers = new Set<string>();
  const targets = specs.map((spec): VaultTarget => {
    const secretName = `${name}-${spec.id}`;
    if (!SECRET_NAME_RE.test(secretName)) throw new Error(`Secret name "${secretName}" is longer than 64 characters.`);
    if (!where) {
      if (spec.header || spec.format) {
        throw new Error('--rotate replaces only values; drop the header and format from each --field.');
      }
      return { name: secretName, injection: null, fieldIds: [spec.id] };
    }
    if (!spec.header)
      throw new Error(`Field "${spec.id}" needs a header: --field '${spec.id}|${spec.label}|<Header>'.`);
    const injection = { name: secretName, ...where, ...headerAndFormat(spec.header, spec.format, '{value}') };
    if (headers.has(injection.headerName.toLowerCase())) {
      throw new Error(`Two fields are sent as header "${injection.headerName}".`);
    }
    headers.add(injection.headerName.toLowerCase());
    return { name: secretName, injection, fieldIds: [spec.id] };
  });
  const fields = specs.map((spec) => ({ ...plain(spec), optional: spec.optional || input.rotate }));
  return { compose, fields, targets };
}

function fieldsLine(compose: Compose, fields: FormField[]): string {
  if (fields.length === 1) return `The form has one field, "${fields[0].label}": paste the key exactly as issued.`;
  const listed = fields.map((field) => `"${field.label}"${field.optional ? ' (optional)' : ''}`).join(', ');
  const how = compose === 'basic' ? 'The host joins and encodes them' : 'The host stores each as its own secret';
  return `The form asks for ${listed}: paste each exactly as issued. ${how}, so nothing needs preparing first.`;
}

function targetLines(intake: Pick<Intake, 'compose' | 'fields' | 'targets'>): string[] {
  return intake.targets.map((target) => {
    const where = target.hostStoreFor
      ? `Kept on this host (0600), not in the vault; it mints the token sent to ${target.hostStoreFor}.`
      : target.injection
        ? injectionLine(target.injection, target.hostWide)
        : target.currentHost
          ? `Replaces the value sent to ${target.currentHost}; its header stays unchanged.`
          : 'Replaces the value; where it is sent stays unchanged.';
    if (intake.compose !== 'separate') return intake.targets.length > 1 ? `${target.name}: ${where}` : where;
    const label = intake.fields.find((field) => field.id === target.fieldIds[0])?.label;
    return `"${label}" → ${target.name}. ${where}`;
  });
}

type Composed =
  | { ok: true; writes: Array<{ target: VaultTarget; value: string }> }
  | { ok: false; message: string; field: string };

function composeValues(
  intake: Pick<Intake, 'compose' | 'fields' | 'targets'>,
  values: Record<string, string>,
): Composed {
  const read = new Map<string, string>();
  for (const field of intake.fields) {
    const value = (values[field.id] ?? '').trim();
    if (!value && !field.optional)
      return { ok: false, field: field.id, message: `Paste a value for "${field.label}".` };
    if (/\s/.test(value)) {
      return {
        ok: false,
        field: field.id,
        message: `"${field.label}" contains spaces or line breaks; paste only the value.`,
      };
    }
    read.set(field.id, value);
  }
  const writes: Array<{ target: VaultTarget; value: string }> = [];
  for (const target of intake.targets) {
    const parts = target.fieldIds.map((id) => read.get(id) ?? '');
    if (parts.every((part) => !part)) continue;
    if (intake.compose !== 'basic') {
      writes.push({ target, value: parts[0] });
      continue;
    }
    if (parts[0].includes(':')) {
      return { ok: false, field: target.fieldIds[0], message: `"${intake.fields[0].label}" cannot contain a colon.` };
    }
    writes.push({ target, value: Buffer.from(`${parts[0]}:${parts[1]}`, 'utf8').toString('base64') });
  }
  if (writes.length === 0) return { ok: false, field: intake.fields[0].id, message: 'Fill in at least one field.' };
  return { ok: true, writes };
}

/**
 * An agent may grant only to its own group and its own workgroup, whatever its cli_scope. With no target named, the
 * default is its workgroup, so every sibling gets the secret; a group in no workgroup gets it itself.
 */
async function grantTargets(
  rawGroups: string[],
  rawWorkgroups: string[],
  caller: SecretIntakeCaller,
  defaultToOwnWorkgroup: boolean,
): Promise<{ groups: string[]; workgroups: string[] }> {
  let groups = splitList(rawGroups);
  let workgroups = splitList(rawWorkgroups);
  if (caller.kind === 'agent') {
    const ownWorkgroup = (await getAgentGroup(caller.agentGroupId))?.workgroup_id;
    if (defaultToOwnWorkgroup && groups.length === 0 && workgroups.length === 0) {
      if (ownWorkgroup) workgroups = [ownWorkgroup];
      else groups = [caller.agentGroupId];
    }
    const foreignGroup = groups.find((g) => g !== caller.agentGroupId);
    if (foreignGroup) throw new Error(`An agent can grant a secret only to its own group, not ${foreignGroup}.`);
    const foreignWorkgroup = workgroups.find((w) => w !== ownWorkgroup);
    if (foreignWorkgroup) {
      throw new Error(`An agent can grant a secret only to its own workgroup, not ${foreignWorkgroup}.`);
    }
  }
  for (const g of groups) {
    if (!(await getAgentGroup(g))) throw new Error(`Agent group not found: ${g}`);
  }
  for (const w of workgroups) {
    if (!(await workgroupExists(w))) throw new Error(`Workgroup not found: ${w}`);
  }
  return { groups, workgroups };
}

/** A rotation only an owner can fill goes into the thread only where the operator already judged an owner present. */
async function ownerSafeConversation(group: AgentGroup, messagingGroupId: string): Promise<boolean> {
  const alsoAllowedIn = readContainerConfig(group.folder).slack_user_token?.also_allowed_in;
  return withCentralSync(
    () => withRawDb((db) => isOwnerSafeSlackSession(db, group.id, messagingGroupId, alsoAllowedIn)),
    'secret intake owner-safe check',
  );
}

async function clientCredentialsTarget(
  input: StartSecretIntakeInput,
): Promise<{ integration: string; host: string; agentGroupId: string } | null> {
  if (input.clientCredentials === undefined) return null;
  if (input.caller.kind !== 'host') throw new Error('--client-credentials is for the host operator only.');
  const conflicting = [
    input.name !== undefined ? '--name' : null,
    input.reservedFor !== undefined ? '--reserved-for' : null,
    input.rotate ? '--rotate' : null,
    hostEntries(input).length ? '--host-pattern' : null,
    input.pathPattern !== undefined ? '--path-pattern' : null,
    input.headerName !== undefined ? '--header' : null,
    input.valueFormat !== undefined ? '--value-format' : null,
    input.fields?.length ? '--field' : null,
    input.compose !== undefined ? '--compose' : null,
    splitList(input.groups).length ? '--groups' : null,
    splitList(input.workgroups).length ? '--workgroups' : null,
  ].filter((flag): flag is string => flag !== null);
  if (conflicting.length) {
    throw new Error(`--client-credentials names the integration and its form; drop ${conflicting.join(', ')}.`);
  }
  const integration = input.clientCredentials.trim();
  const found = await clientCredentialsIntegration(integration);
  if (!(await getAgentGroup(found.agentGroupId))) {
    throw new Error(
      `"${integration}" belongs to agent group ${found.agentGroupId}, which no longer exists, so no workgroup can receive its form.`,
    );
  }
  return { integration, ...found };
}

function clientCredentialsForm(
  integration: string,
  host: string,
): { compose: Compose; fields: FormField[]; targets: VaultTarget[] } {
  const part = (id: string, label: string) => ({
    field: { id, label, optional: false },
    target: { name: `${integration}-${id}`, injection: null, fieldIds: [id], hostStoreFor: host },
  });
  const parts = [part('client_id', 'Client ID'), part('client_secret', 'Client secret')];
  return { compose: 'separate', fields: parts.map((p) => p.field), targets: parts.map((p) => p.target) };
}

/**
 * A lane token is named by its agent and reaches that agent alone. Only the host may ask for one: `intake` is open to
 * every caller, so this check is the boundary.
 */
function reservedTarget(input: StartSecretIntakeInput): string | null {
  if (input.reservedFor === undefined) {
    if (input.hostWide) throw new Error('--host-wide goes with --reserved-for.');
    if (input.enteredBy !== undefined) throw new Error('--entered-by goes with --reserved-for.');
    return null;
  }
  if (input.caller.kind !== 'host') throw new Error('--reserved-for is for the host operator only.');
  if (hostEntries(input).length > 1)
    throw new Error('--reserved-for takes one --host-pattern; a lane token has one host.');
  const agent = input.reservedFor.trim();
  if (!isReservedAgent(agent))
    throw new Error(`--reserved-for must name an approved-run-* OneCLI agent, not "${agent}".`);
  // An API that takes HTTP Basic, such as an OAuth client's token exchange, needs its two parts joined into the token.
  const basicPair = input.compose === 'basic' && input.fields?.length === 2;
  const conflicting = [
    input.name !== undefined ? '--name' : null,
    splitList(input.groups).length ? '--groups' : null,
    splitList(input.workgroups).length ? '--workgroups' : null,
    input.fields?.length && !basicPair ? '--field' : null,
    input.compose !== undefined && !basicPair ? '--compose' : null,
  ].filter((flag): flag is string => flag !== null);
  if (conflicting.length) {
    throw new Error(`--reserved-for sets the secret's name and its only holder; drop ${conflicting.join(', ')}.`);
  }
  if (input.hostWide) {
    if (input.rotate) throw new Error('--rotate keeps the path the token has; drop --host-wide.');
    if (input.pathPattern !== undefined) throw new Error('Give --path-pattern or --host-wide, not both.');
    return agent;
  }
  const path = input.pathPattern?.trim();
  if (!input.rotate && (!path || path.includes('*'))) {
    throw new Error('--reserved-for needs --path-pattern naming one exact path, with no wildcard.');
  }
  return agent;
}

/**
 * A named user may enter a lane token only for a target they already administer: an admin of one of the agent groups
 * of a target that runs as this identity. Owners and global admins can always enter it, so naming one is refused.
 */
async function namedEnterer(raw: string, agent: string): Promise<{ userId: string; agentGroups: string[] }> {
  const userId = raw.trim();
  if (!(await getUser(userId))) throw new Error(`--entered-by names no known user: "${userId}".`);
  const groups = [...new Set(targetsUsing(agent).flatMap((t) => t.agentGroups))];
  if (groups.length === 0) {
    throw new Error(`No approved-run target runs as ${agent}; add its target before naming who enters its key.`);
  }
  const { privileged, adminOf } = await withCentralSync(
    () => ({
      privileged: isOwner(userId) || isGlobalAdmin(userId),
      adminOf: groups.filter((g) => isAdminOfAgentGroup(userId, g)),
    }),
    'secret intake entered-by check',
  );
  if (privileged) throw new Error(`${userId} is an owner or global admin and can already enter it; drop --entered-by.`);
  if (adminOf.length === 0) {
    throw new Error(`${userId} is not an admin of any agent group of the targets that run as ${agent}.`);
  }
  return { userId, agentGroups: adminOf };
}

/** The named user's own DM, on a channel whose card opens the form; never anywhere else. */
async function enteredByDm(userId: string): ReturnType<typeof pickApprovalDelivery> {
  const type = await resolveUserChannelType(userId);
  if (!type || !(isSlackChannelType(type) || isDiscordChannelType(type))) return null;
  return pickApprovalDelivery([userId], type, { sameChannelTypeOnly: true });
}

async function vaultSet(stem: string): Promise<{
  kind: 'none' | 'plain' | 'set';
  members: Array<{ name: string; hostPattern: string | null }>;
  complete: boolean;
}> {
  const re = setMemberRe(stem);
  const rows = await listOnecliSecrets();
  const plain = rows.filter((row) => row.name === stem);
  const numbered = rows
    .map((row) => ({ row, match: re.exec(row.name) }))
    .filter((x): x is { row: (typeof rows)[number]; match: RegExpExecArray } => x.match !== null)
    .sort((x, y) => Number(x.match[1]) - Number(y.match[1]));
  if (numbered.length === 0) return { kind: plain.length ? 'plain' : 'none', members: [], complete: false };
  const members = [...plain, ...numbered.map((x) => x.row)].map((row) => ({
    name: row.name,
    hostPattern: row.hostPattern,
  }));
  const size = Number(numbered[0].match[2]);
  const complete =
    plain.length === 0 &&
    numbered.length === size &&
    numbered.every((x, i) => Number(x.match[2]) === size && Number(x.match[1]) === i + 1);
  return { kind: 'set', members, complete };
}

export async function startSecretIntake(input: StartSecretIntakeInput): Promise<SecretIntakeView> {
  const now = Date.now();
  prune(now);

  const hostStore = await clientCredentialsTarget(input);
  const rotate = input.rotate || hostStore !== null;
  const reservedFor = reservedTarget(input);
  const enteredBy =
    reservedFor && input.enteredBy !== undefined ? await namedEnterer(input.enteredBy, reservedFor) : null;
  const name = hostStore?.integration ?? (reservedFor ? reservedTokenName(reservedFor) : (input.name ?? '').trim());
  if (!reservedFor && !name) throw new Error('Name the secret with --name, or a lane agent with --reserved-for.');
  if (!reservedFor && !SECRET_NAME_RE.test(name)) {
    throw new Error(
      'Secret names are 1-64 characters: letters, digits, ".", "_" or "-", starting with a letter or digit.',
    );
  }
  const { compose, fields, targets } = hostStore
    ? clientCredentialsForm(hostStore.integration, hostStore.host)
    : planForm(input, name);
  if (reservedFor) {
    if (compose === 'single') fields[0].label = `Key for ${reservedFor}`;
    targets[0].hostWide = input.hostWide;
  }

  const caller = input.caller;
  const callerGroup = caller.kind === 'agent' ? await getAgentGroup(caller.agentGroupId) : undefined;
  const { groups, workgroups } = await grantTargets(input.groups, input.workgroups, caller, !rotate);

  if (!reservedFor && !hostStore && compose !== 'separate') {
    const member = /^(.+)-[1-9][0-9]*of[1-9][0-9]*$/.exec(name);
    if (member && (await vaultSet(member[1])).kind === 'set') {
      throw new Error(
        `"${name}" belongs to the host set "${member[1]}", whose members never change alone. Use --name ${member[1]}.`,
      );
    }
    const set = await vaultSet(name);
    if (set.kind === 'set' && compose !== 'single') {
      throw new Error(`"${name}" is a host set, which holds one pasted value: drop --field and --compose.`);
    }
    if (set.kind === 'set' && !input.rotate) {
      throw new Error(
        `"${name}" is already in the vault as ${quoted(set.members.map((m) => m.name))}. Pass --rotate to replace its value.`,
      );
    }
    if (set.kind === 'plain' && targets.length > 1) {
      throw new Error(`"${name}" already exists in the vault as one secret. Pass --rotate to replace its value.`);
    }
    if (set.kind === 'set' && input.rotate) {
      if (!set.complete) {
        throw new Error(
          `The set "${name}" is incomplete in the vault (${set.members.map((m) => m.name).join(', ')}): rotating it would leave its hosts on different values. Restore or remove the set first.`,
        );
      }
      targets.splice(
        0,
        targets.length,
        ...set.members.map((m) => ({
          name: m.name,
          injection: null,
          fieldIds: [fields[0].id],
          currentHost: m.hostPattern,
        })),
      );
    }
  }
  for (const target of hostStore ? [] : targets) {
    const existing = await findOnecliSecretByName(target.name);
    if (existing && !input.rotate) {
      throw new Error(`"${target.name}" already exists in the vault. Pass --rotate to replace its value.`);
    }
    if (!existing && input.rotate) {
      throw new Error(`"${target.name}" is not in the vault, so there is nothing to rotate.`);
    }
  }

  const session = caller.kind === 'agent' ? await getSession(caller.sessionId) : undefined;
  const originMg = session?.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
  let card: Intake['card'];
  let deliveredTo: string;
  const formInThread =
    originMg &&
    session &&
    callerGroup &&
    (isSlackChannelType(originMg.channel_type) || isDiscordChannelType(originMg.channel_type)) &&
    (!input.rotate || (await ownerSafeConversation(callerGroup, originMg.id)));
  if (enteredBy) {
    const target = await enteredByDm(enteredBy.userId);
    if (!target) throw new Error(`${enteredBy.userId} has no reachable Slack or Discord DM; nothing was posted.`);
    card = {
      channelType: target.messagingGroup.channel_type,
      platformId: target.messagingGroup.platform_id,
      threadId: null,
      instance: target.messagingGroup.instance ?? target.messagingGroup.channel_type,
      messageId: null,
    };
    deliveredTo = target.userId;
  } else if (formInThread) {
    card = {
      channelType: originMg.channel_type,
      platformId: originMg.platform_id,
      threadId: session.thread_id,
      instance: originMg.instance ?? originMg.channel_type,
      messageId: null,
    };
    deliveredTo = `the requesting conversation (${originMg.name ?? originMg.platform_id})`;
  } else {
    const tenants = new Set(workgroups);
    if (callerGroup) tenants.add(callerGroup.workgroup_id ?? callerGroup.folder);
    for (const id of hostStore ? [hostStore.agentGroupId] : groups) {
      const group = await getAgentGroup(id);
      if (group) tenants.add(group.workgroup_id ?? group.folder);
      else if (hostStore) throw new Error(`Agent group ${id} no longer exists, so no workgroup can receive the form.`);
    }
    const target = await ownerFormDm([...tenants]);
    if (!target) {
      throw new Error(
        tenants.size === 1
          ? `No owner or global admin has a reachable Slack or Discord DM on a surface of workgroup "${[...tenants][0]}", so the form was not posted; it is never sent to another workgroup's workspace.`
          : 'No owner or global admin has a reachable Slack DM to receive the secret form.',
      );
    }
    card = {
      channelType: target.messagingGroup.channel_type,
      platformId: target.messagingGroup.platform_id,
      threadId: null,
      instance: target.messagingGroup.instance ?? target.messagingGroup.channel_type,
      messageId: null,
    };
    deliveredTo = target.userId;
  }
  const adapter = getDeliveryAdapter();
  if (!adapter) throw new Error('Channel delivery is not ready yet; try again in a moment.');

  const intake: Intake = {
    id: `si-${randomBytes(8).toString('hex')}`,
    secretName: name,
    rotate,
    compose,
    fields,
    targets,
    groups,
    workgroups,
    reservedFor,
    clientCredentials: hostStore,
    enteredBy,
    sessionId: caller.kind === 'agent' ? caller.sessionId : null,
    requester:
      caller.kind === 'agent' && callerGroup
        ? { agentGroupId: callerGroup.id, agentName: callerGroup.name, workgroupId: callerGroup.workgroup_id ?? null }
        : null,
    card,
    deliveredTo,
    expiresAt: now + INTAKE_TTL_MS,
    status: 'pending',
    detail: null,
    finishedAt: null,
  };

  const requester = callerGroup ? `Agent "${callerGroup.name}"` : 'The host operator';
  const body = [
    `${requester} is asking for this secret.`,
    ...targetLines({ compose, fields, targets }),
    ...(hostStore ? [] : [grantsLine(groups, workgroups, rotate, reservedFor)]),
    enteredBy
      ? `You, an owner or a global admin can enter it.`
      : callerGroup && !input.rotate
        ? `An owner, a global admin, or an admin of "${callerGroup.name}" can enter it.`
        : 'Only an owner or global admin can enter it.',
    fieldsLine(compose, fields),
    `${hostStore ? 'The pair goes straight to the host store' : 'The value goes straight to the vault'} — no agent sees it. Expires ${formatLocalTime(new Date(intake.expiresAt).toISOString(), TIMEZONE)}.`,
  ].join('\n');

  // Checked here, after the last await, so two concurrent requests cannot both pass.
  const pending = [...intakes.values()].filter((other) => other.status === 'pending' || other.status === 'storing');
  const names = new Set(targets.map((target) => target.name));
  // A host-store card writes the host bundle, not a vault value, so it never replaces a vault intake of the same name.
  const overlapping = pending.filter(
    (other) =>
      (other.clientCredentials === null) === (hostStore === null) &&
      (other.secretName === name || other.targets.some((target) => names.has(target.name))),
  );
  const replaceable = (other: Intake) => other.status === 'pending' && other.sessionId === intake.sessionId;
  const duplicate = overlapping.find((other) => !replaceable(other));
  if (duplicate) {
    throw new Error(
      `An intake for "${name}" is already waiting (${duplicate.id}); it expires at ${formatLocalTime(new Date(duplicate.expiresAt).toISOString(), TIMEZONE)}.`,
    );
  }
  if (
    intake.sessionId &&
    pending.filter((other) => other.sessionId === intake.sessionId && !overlapping.includes(other)).length >=
      MAX_PENDING_PER_SESSION
  ) {
    throw new Error(
      `This session already has ${MAX_PENDING_PER_SESSION} secret requests waiting; let them finish or expire.`,
    );
  }
  intakes.set(intake.id, intake);
  try {
    intake.card.messageId =
      (await adapter.deliver(
        intake.card.channelType,
        intake.card.platformId,
        intake.card.threadId,
        'chat-sdk',
        JSON.stringify({
          type: 'secret_intake',
          intakeId: intake.id,
          title: cardTitle(intake),
          body,
          buttonLabel: intake.rotate ? 'Enter new value' : 'Enter secret',
        }),
        undefined,
        intake.card.instance,
      )) ?? null;
  } catch (err) {
    intakes.delete(intake.id);
    throw new Error(`Could not post the secret form: ${err instanceof Error ? err.message : String(err)}`, {
      cause: err,
    });
  }
  for (const old of overlapping) {
    if (old.status !== 'pending') continue;
    old.status = 'expired';
    old.finishedAt = Date.now();
    void editCard(old, replacedText(old));
  }
  if (intake.status === 'expired') void editCard(intake, replacedText(intake));
  log.info('Secret intake posted', { intakeId: intake.id, secretName: name, rotate });
  return view(intake);
}

export function getSecretIntake(intakeId: string): SecretIntakeView | undefined {
  prune(Date.now());
  const intake = intakes.get(intakeId);
  return intake ? view(intake) : undefined;
}

async function editCard(intake: Intake, text: string): Promise<void> {
  if (!intake.card.messageId) return;
  await deliverToCard(intake, 'chat-sdk', {
    operation: 'edit',
    messageId: intake.card.messageId,
    text,
    clearActions: true,
  });
}

async function deliverToCard(intake: Intake, kind: string, content: Record<string, unknown>): Promise<void> {
  const adapter = getDeliveryAdapter();
  if (!adapter) return;
  try {
    await adapter.deliver(
      intake.card.channelType,
      intake.card.platformId,
      intake.card.threadId,
      kind,
      JSON.stringify(content),
      undefined,
      intake.card.instance,
    );
  } catch (err) {
    log.warn('Secret intake: could not post to the card conversation', { intakeId: intake.id, err });
  }
}

type Authority = 'owner' | 'group-admin' | 'named' | null;

function mayEnter(intake: Intake): string {
  const who = intake.enteredBy
    ? `${intake.enteredBy.userId}, an owner or a global admin`
    : intake.requester && !intake.rotate
      ? `an owner, a global admin or an admin of "${intake.requester.agentName}"`
      : 'an owner or global admin';
  return `Only ${who} can enter this secret.`;
}

function authorityOf(intake: Intake, namespacedUserId: string): Promise<Authority> {
  return withCentralSync(() => {
    if (isOwner(namespacedUserId) || isGlobalAdmin(namespacedUserId)) return 'owner' as const;
    const named = intake.enteredBy;
    if (
      named &&
      equivalentSlackUserIds(namespacedUserId).includes(named.userId) &&
      named.agentGroups.some((g) => isAdminOfAgentGroup(namespacedUserId, g))
    ) {
      return 'named' as const;
    }
    if (!intake.rotate && intake.requester && isAdminOfAgentGroup(namespacedUserId, intake.requester.agentGroupId)) {
      return 'group-admin' as const;
    }
    return null;
  }, 'secret intake authority');
}

/**
 * An owner's DM that can open the form. A form whose grants reach exactly one workgroup goes only to a surface that
 * workgroup's agents are wired to (Slack first, then Discord), so one tenant's secret never appears in another's
 * workspace under its bot; otherwise, the first owner with a Slack DM.
 */
async function ownerFormDm(workgroups: string[]): ReturnType<typeof pickApprovalDelivery> {
  const own = workgroups.length === 1 ? new Set(await getWorkgroupChannelTypes(workgroups[0])) : null;
  const owners = await pickOwnersFirst(null);
  for (const opensForm of own ? [isSlackChannelType, isDiscordChannelType] : [isSlackChannelType]) {
    for (const userId of owners) {
      const type = await resolveUserChannelType(userId);
      if (!type || !opensForm(type) || (own && !own.has(type))) continue;
      const target = await pickApprovalDelivery([userId], type, own ? { sameChannelTypeOnly: true } : {});
      if (target) return target;
    }
  }
  return null;
}

async function noticeOwners(
  intake: Intake,
  namespacedUserId: string,
  stored: string[],
  partial: boolean,
  partialDetail?: string,
): Promise<void> {
  try {
    const adapter = getDeliveryAdapter();
    const target = await pickApprovalDelivery(await pickOwnersFirst(null), '');
    if (!adapter || !target) throw new Error('no owner DM is reachable');
    const who = (await getUser(namespacedUserId))?.display_name || namespacedUserId;
    const where = targetLines({ ...intake, targets: intake.targets.filter((x) => stored.includes(x.name)) }).join(' ');
    const granted = partial
      ? (partialDetail ?? 'A later write failed, so nothing was granted.')
      : `${grantsLine(intake.groups, intake.workgroups, intake.rotate, intake.reservedFor)}.`;
    const forWhom = intake.reservedFor ? `the approved-run lane` : `agent "${intake.requester?.agentName}"`;
    const verb = intake.rotate ? 'rotated' : 'stored';
    const text = `🔐 ${who} ${verb} ${quoted(stored)} for ${forWhom}. ${where} ${granted}`;
    await adapter.deliver(
      target.messagingGroup.channel_type,
      target.messagingGroup.platform_id,
      null,
      'chat',
      JSON.stringify({ text }),
      undefined,
      target.messagingGroup.instance ?? target.messagingGroup.channel_type,
    );
  } catch (err) {
    log.error('Secret intake: the owner notice for a non-owner store failed', { intakeId: intake.id, err });
  }
}

async function tellRequester(intake: Intake, text: string): Promise<void> {
  if (!intake.sessionId) return;
  const session = await getSession(intake.sessionId);
  if (session) await notifyAgent(session, text);
}

function unavailable(intake: Intake | undefined): string | null {
  if (!intake) return 'This secret request has expired or no longer exists. Ask for a new one.';
  return intake.status === 'pending' ? null : `This secret request is already ${intake.status}.`;
}

class PartialStoreError extends Error {}

/** The vault may or may not hold what the write left behind; only a look at the vault can tell. */
class UnknownStoreError extends Error {
  constructor(
    message: string,
    readonly mayRemain: string[],
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

async function failIntake(intake: Intake, err: unknown): Promise<void> {
  if (intake.status !== 'storing') {
    log.warn('Secret intake: follow-up after the store failed', { intakeId: intake.id, err });
    return;
  }
  intake.status = 'failed';
  intake.finishedAt = Date.now();
  intake.detail = err instanceof Error ? err.message : String(err);
  const outcome =
    err instanceof UnknownStoreError
      ? 'in an unknown state'
      : err instanceof PartialStoreError
        ? 'only partly stored'
        : 'NOT stored';
  log.warn('Secret intake: not stored', { intakeId: intake.id, detail: intake.detail });
  await editCard(intake, `${cardTitle(intake)}\n\n${outcome}: ${intake.detail}`);
  await tellRequester(intake, `Secret "${intake.secretName}" was ${outcome}: ${intake.detail}`);
}

function quoted(names: string[]): string {
  return `secret${names.length > 1 ? 's' : ''} ${names.map((n) => `"${n}"`).join(', ')}`;
}

async function writeVault(
  writes: Array<{ target: VaultTarget; value: string }>,
): Promise<{ stored: OnecliSecretRef[]; failure: { name: string; err: unknown } | null }> {
  const stored: OnecliSecretRef[] = [];
  for (const { target, value } of writes) {
    try {
      if (target.injection) {
        stored.push(await createOnecliSecret(target.injection, value));
      } else {
        const existing = await findOnecliSecretByName(target.name);
        if (!existing) throw new Error(`"${target.name}" is no longer in the vault`);
        await updateOnecliSecretValue(existing, value);
        stored.push(existing);
      }
    } catch (err) {
      return { stored, failure: { name: target.name, err } };
    }
  }
  return { stored, failure: null };
}

/** A write that got no HTTP answer may still commit, so only an answered failure proves the vault is unchanged. */
function answered(err: unknown): boolean {
  return /with HTTP \d{3}\b/.test(messageOf(err));
}

async function undoSet(
  stem: string,
  stored: OnecliSecretRef[],
  failure: { name: string; err: unknown },
): Promise<Error> {
  const failed = `"${failure.name}" failed: ${messageOf(failure.err)}`;
  let kept: OnecliSecretRef | undefined;
  let unchecked: string | null = null;
  try {
    kept = await findOnecliSecretByName(failure.name);
  } catch (err) {
    unchecked = `"${failure.name}" may be in the vault (checking failed: ${messageOf(err)})`;
  }
  if (!kept && !unchecked && !answered(failure.err)) {
    unchecked = `"${failure.name}" may still be stored: its create got no answer and the vault does not show it yet`;
  }
  const stuck: OnecliSecretRef[] = [];
  const stuckWhy: string[] = [];
  for (const ref of kept ? [...stored, kept] : stored) {
    try {
      await deleteOnecliSecret(ref.id);
    } catch (err) {
      stuck.push(ref);
      stuckWhy.push(`"${ref.name}" (${messageOf(err)})`);
    }
  }
  if (!unchecked && stuck.length === 0) {
    return new Error(`${failed}; the set's other secrets were removed again, so nothing was stored`, {
      cause: failure.err,
    });
  }
  const left = [...(stuck.length ? [`removing ${stuckWhy.join(', ')} failed`] : []), ...(unchecked ? [unchecked] : [])];
  return new UnknownStoreError(
    `${failed}; ${left.join('; ')}: look in the vault for "${stem}-…" and delete what remains by hand`,
    [...stuck.map((ref) => ref.name), ...(unchecked ? [failure.name] : [])],
    { cause: failure.err },
  );
}

async function completeIntake(
  intake: Intake,
  namespacedUserId: string,
  writes: Array<{ target: VaultTarget; value: string }>,
): Promise<void> {
  const authority = await authorityOf(intake, namespacedUserId);
  const refusal = authority ? null : mayEnter(intake);
  if (refusal) {
    intake.status = 'pending';
    log.warn('Secret intake: submit refused', { intakeId: intake.id, authority });
    await deliverToCard(intake, 'chat', { text: `${refusal} Nothing was stored; the request is still open.` });
    return;
  }
  if (intake.clientCredentials) {
    await completeClientCredentials(intake, intake.clientCredentials, writes);
    return;
  }
  if (intake.reservedFor) {
    try {
      await completeReserved(intake, intake.reservedFor, writes[0]);
    } catch (err) {
      if (authority === 'named' && err instanceof PartialStoreError) {
        await noticeOwners(intake, namespacedUserId, [intake.secretName], true, `It did not finish: ${err.message}.`);
      }
      throw err;
    }
    if (authority === 'named') await noticeOwners(intake, namespacedUserId, [intake.secretName], false);
    return;
  }
  if (intake.rotate && intake.compose === 'single' && intake.targets.length > 1) {
    const now = await vaultSet(intake.secretName);
    const names = now.members.map((m) => m.name).join(',');
    if (!now.complete || names !== intake.targets.map((t) => t.name).join(',')) {
      throw new Error(`the set "${intake.secretName}" changed in the vault after this card was posted`);
    }
  }
  const { stored: storedRefs, failure } = await writeVault(writes);
  const stored = storedRefs.map((ref) => ref.name);
  if (failure && !intake.rotate && intake.compose === 'single' && intake.targets.length > 1) {
    const err = await undoSet(intake.secretName, storedRefs, failure);
    if (authority === 'group-admin' && err instanceof UnknownStoreError) {
      await noticeOwners(intake, namespacedUserId, err.mayRemain, true, `It did not finish: ${err.message}.`);
    }
    throw err;
  }
  if (failure && intake.rotate && intake.targets.length > 1 && !answered(failure.err)) {
    throw new UnknownStoreError(
      `${stored.length ? `${quoted(stored)} took the new value; then ` : ''}"${failure.name}" got no answer (${messageOf(failure.err)}), so whether it changed is unknown and these secrets may now hold different values: rotate again`,
      [...stored, failure.name],
      { cause: failure.err },
    );
  }
  if (authority === 'group-admin' && stored.length) await noticeOwners(intake, namespacedUserId, stored, !!failure);
  if (failure) {
    if (!stored.length) throw failure.err;
    const reason = failure.err instanceof Error ? failure.err.message : String(failure.err);
    const done = intake.rotate ? 'replaced, now live for every holder' : 'stored but granted to no one';
    throw new PartialStoreError(`${quoted(stored)} ${done}; then "${failure.name}" failed: ${reason}`, {
      cause: failure.err,
    });
  }

  const failedGrants: string[] = [];
  for (const name of stored) {
    for (const g of intake.groups) {
      try {
        await declareGroupSecret(g, name);
      } catch (err) {
        failedGrants.push(`group ${g} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    for (const w of intake.workgroups) {
      try {
        await addWorkgroupOnecliSecret(w, name);
      } catch (err) {
        failedGrants.push(`workgroup ${w} (${err instanceof Error ? err.message : String(err)})`);
      }
    }
  }

  intake.status = 'stored';
  intake.finishedAt = Date.now();
  intake.detail = failedGrants.length ? `stored, but these grants failed: ${failedGrants.join('; ')}` : null;
  log.info('Secret intake stored', { intakeId: intake.id, stored, failedGrants });

  const granted = grantsLine(intake.groups, intake.workgroups, intake.rotate);
  const effect = intake.rotate
    ? 'The new value applies to the next request; no restart needed.'
    : 'A newly granted group picks it up at its next container start (ncl groups restart --id <group>).';
  await editCard(
    intake,
    `${cardTitle(intake)}\n\nStored ${quoted(stored)}. ${granted}.${intake.detail ? `\n\n⚠️ ${intake.detail}` : ''}`,
  );
  await tellRequester(
    intake,
    `${quoted(stored).replace(/^s/, 'S')} stored in the vault (${intake.rotate ? 'rotated' : 'created'}); you never saw the value. ${granted}. ${effect}${intake.detail ? ` WARNING: ${intake.detail}` : ''}`,
  );
}

async function completeClientCredentials(
  intake: Intake,
  shown: { integration: string; host: string; agentGroupId: string },
  writes: Array<{ target: VaultTarget; value: string }>,
): Promise<void> {
  const { integration } = shown;
  const value = (id: string): string => writes.find((w) => w.target.fieldIds[0] === id)?.value ?? '';
  let result;
  try {
    result = await rekeyClientCredentials(
      integration,
      { clientId: value('client_id'), clientSecret: value('client_secret') },
      undefined,
      { host: shown.host, agentGroupId: shown.agentGroupId },
    );
  } catch (err) {
    if (err instanceof IntegrationChangedError) {
      log.warn('Secret intake: integration changed since the card was posted', {
        intakeId: intake.id,
        detail: err.message,
      });
      throw new Error(`"${integration}" changed since this card was posted; post a new card`, { cause: err });
    }
    if (err instanceof OAuthTokenError) {
      const refused = err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429;
      throw new Error(
        refused
          ? `the token endpoint refused the pair (${err.message}); the integration keeps its current pair`
          : `the token endpoint gave no usable answer (${err.message}); post a new card to try again`,
        { cause: err },
      );
    }
    throw new UnknownStoreError(
      `${messageOf(err)}; check \`ncl integrations list\`, and enter the pair again if the status is not active`,
      [integration],
      { cause: err },
    );
  }
  intake.status = 'stored';
  intake.finishedAt = Date.now();
  intake.detail = result.status === 'active' ? null : result.statusDetail;
  log.info('Secret intake stored client credentials', { intakeId: intake.id, integration, status: result.status });
  await editCard(
    intake,
    `${cardTitle(intake)}\n\nStored the new pair on this host. ${
      result.status === 'active'
        ? `A token minted from it is in the vault for ${result.hostPattern}.`
        : `The vault write is still retrying: ${result.statusDetail}`
    }`,
  );
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * A lane token counts as stored only once its agent holds it and nothing else can be injected it. A new token that
 * fails that is removed again, so it never sits in the vault half-granted.
 */
async function completeReserved(
  intake: Intake,
  agent: string,
  write: { target: VaultTarget; value: string },
): Promise<void> {
  try {
    await writeReservedTokenAlone(agent, async () => {
      const copies = await findOnecliSecretsByName(intake.secretName);
      if (write.target.injection) {
        if (copies.length)
          throw new Error(`"${intake.secretName}" was added to the vault after this request; nothing was stored`);
        await createReservedToken(agent, write.target.injection, write.value);
      } else {
        if (copies.length !== 1) {
          throw new Error(
            `${copies.length} vault entries are named "${intake.secretName}"; leave exactly one before rotating`,
          );
        }
        await rotateReservedToken(agent, copies[0], write.value);
      }
    });
  } catch (err) {
    if (err instanceof ReservedTokenMayBeLive) throw new PartialStoreError(err.message, { cause: err.cause });
    throw err;
  }
  intake.status = 'stored';
  intake.finishedAt = Date.now();
  log.info('Secret intake stored', { intakeId: intake.id, stored: [intake.secretName], reservedFor: agent });
  await editCard(
    intake,
    `${cardTitle(intake)}\n\nStored ${quoted([intake.secretName])}. ${grantsLine([], [], intake.rotate, agent)}.`,
  );
}

export function secretIntakeHooks(channelType: string): SecretIntakeHooks {
  const namespaced = (userId: string): string => (userId.includes(':') ? userId : `${channelType}:${userId}`);
  return {
    // The trigger window can close before the lease frees, so open waits briefly and completeIntake decides.
    async open(intakeId, userId) {
      prune(Date.now());
      const intake = intakes.get(intakeId);
      const refused = unavailable(intake);
      if (refused || !intake) return { ok: false, message: refused ?? 'This secret request no longer exists.' };
      let timer: NodeJS.Timeout | undefined;
      const early = await Promise.race([
        authorityOf(intake, namespaced(userId)).catch(() => 'undecided' as const),
        new Promise<'undecided'>((resolve) => {
          timer = setTimeout(() => resolve('undecided'), OPEN_AUTHORITY_WAIT_MS);
        }),
      ]).finally(() => clearTimeout(timer));
      if (early === null) return { ok: false, message: mayEnter(intake) };
      return {
        ok: true,
        form: {
          title: intake.rotate ? 'Rotate secret' : 'Store secret',
          body: [`*${intake.secretName}*`, ...targetLines(intake)].join('\n'),
          inputs: intake.fields,
        },
      };
    },
    async submit(intakeId, userId, values) {
      prune(Date.now());
      const intake = intakes.get(intakeId);
      const refused = unavailable(intake);
      if (refused || !intake) return { ok: false, message: refused ?? 'This secret request no longer exists.' };
      const composed = composeValues(intake, values);
      if (!composed.ok) return composed;
      intake.status = 'storing';
      completeIntake(intake, namespaced(userId), composed.writes)
        .catch((err) => failIntake(intake, err))
        .catch((err) => log.error('Secret intake: completion failed', { intakeId: intake.id, err }));
      return { ok: true };
    },
  };
}

export interface SecretGrantResult {
  secretName: string;
  addedGroups: string[];
  addedWorkgroups: string[];
  alreadyGranted: string[];
}

/** A declared name missing from the vault aborts every spawn that inherits it. */
export async function grantSecret(input: {
  name: string;
  groups: string[];
  workgroups: string[];
  caller: SecretIntakeCaller;
}): Promise<SecretGrantResult> {
  if (
    input.caller.kind === 'host' &&
    splitList(input.groups).length === 0 &&
    splitList(input.workgroups).length === 0
  ) {
    throw new Error('Name at least one --groups or --workgroups.');
  }
  assertSecretNotReserved(input.name, null);
  const { groups, workgroups } = await grantTargets(input.groups, input.workgroups, input.caller, true);
  if (!(await findOnecliSecretByName(input.name))) {
    throw new Error(`"${input.name}" is not in the vault. Store it first with ncl secrets intake.`);
  }
  const result: SecretGrantResult = {
    secretName: input.name,
    addedGroups: [],
    addedWorkgroups: [],
    alreadyGranted: [],
  };
  for (const g of groups) {
    if (await declareGroupSecret(g, input.name)) result.addedGroups.push(g);
    else result.alreadyGranted.push(`group ${g}`);
  }
  for (const w of workgroups) {
    if (await addWorkgroupOnecliSecret(w, input.name)) result.addedWorkgroups.push(w);
    else result.alreadyGranted.push(`workgroup ${w}`);
  }
  return result;
}

export function __resetSecretIntakesForTest(): void {
  intakes.clear();
}
