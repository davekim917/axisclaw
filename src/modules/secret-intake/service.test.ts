/**
 * Secret intake service: what it validates before posting the card, who may open and submit the form, what reaches
 * the vault and the grants, and — the point of the feature — that the value reaches nothing else: not a card, an agent
 * note, a log line, a returned view or a grant call.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const SECRET = 'sk-live-SERVICE-SENTINEL-9d41e7';

const h = vi.hoisted(() => ({
  vault: new Map<string, { id: string; name: string; hostPattern?: string | null }>(),
  /** While set, every vault lookup waits for it, so a test can hold two writers between lookup and write. */
  lookupGate: null as Promise<void> | null,
  lookups: 0,
  createFailsFor: new Set<string>(),
  createLosesAnswerFor: new Set<string>(),
  createTimesOutFor: new Set<string>(),
  updateFailsFor: new Set<string>(),
  updateLosesAnswerFor: new Set<string>(),
  clientHosts: new Map<string, string>(),
  rekeyCalls: [] as Array<[string, { clientId: string; clientSecret: string }]>,
  rekeyResult: { status: 'active', statusDetail: null as string | null, hostPattern: 'looker.example.com' },
  rekeyError: null as Error | null,
  rekeyExpected: [] as unknown[],
  createCalls: [] as Array<{ spec: unknown; value: string }>,
  updateCalls: [] as Array<{ ref: unknown; value: string }>,
  createFails: false,
  deliverFails: false,
  deliverGate: null as Promise<void> | null,
  deliveries: [] as Array<{ args: unknown[] }>,
  notes: [] as string[],
  logs: [] as unknown[],
  groupGrants: [] as string[],
  workgroupGrants: [] as string[],
  owners: new Set<string>(['slack:UOWNER']),
  groups: new Map<string, { id: string; name: string; folder: string; workgroup_id: string | null }>(),
  workgroups: new Set<string>(['wg-a', 'wg-b']),
  groupAdmins: new Set<string>(['slack:UADMIN1|ag-1', 'slack:UADMIN2|ag-2']),
  originType: 'slack',
  notifyFails: false,
  ownerIds: ['slack:UOWNER'],
  ownerSafe: false,
  ownerSafeCalls: [] as unknown[][],
  deletes: [] as string[],
  deleteFails: false,
  extraCopies: [] as Array<{ id: string; name: string }>,
  createLosesAnswer: false,
  lookupFails: false,
  unknownUsers: new Set<string>(),
  noDm: new Set<string>(),
  workgroupTypes: new Map<string, string[]>(),
  laneTargets: [] as Array<{ agentGroups: string[] }>,
  lane: {
    ensured: [] as string[],
    granted: [] as string[],
    others: [] as string[],
    grantFails: false,
    othersAfterWrite: false,
  },
}));

vi.mock('../../onecli-secret-writer.js', () => ({
  findOnecliSecretByName: vi.fn(async (name: string) => {
    if (h.lookupFails) throw new Error('OneCLI secrets list failed with HTTP 502');
    return h.vault.get(name);
  }),
  findOnecliSecretsByName: vi.fn(async (name: string) => {
    h.lookups += 1;
    await h.lookupGate;
    return [...(h.vault.has(name) ? [h.vault.get(name)] : []), ...h.extraCopies.filter((c) => c.name === name)];
  }),
  listOnecliSecrets: vi.fn(async () => {
    if (h.lookupFails) throw new Error('OneCLI secrets list failed with HTTP 502');
    return [...h.vault.values(), ...h.extraCopies].map((ref) => ({ hostPattern: null, ...ref }));
  }),
  createOnecliSecret: vi.fn(async (spec: { name: string; hostPattern: string }, value: string) => {
    h.createCalls.push({ spec, value });
    if (h.createFails || h.createFailsFor.has(spec.name)) {
      throw new Error(`OneCLI secret create failed with HTTP 500 for "${spec.name}"`);
    }
    if (h.createTimesOutFor.has(spec.name)) throw new Error('OneCLI secret create timed out');
    const ref = { id: `id-${spec.name}`, name: spec.name };
    h.vault.set(spec.name, { ...ref, hostPattern: spec.hostPattern });
    if (h.createLosesAnswerFor.has(spec.name)) throw new Error('OneCLI secret create timed out');
    if (h.createLosesAnswer) throw new Error('OneCLI secret create timed out');
    return ref;
  }),
  updateOnecliSecretValue: vi.fn(async (ref: { name: string }, value: string) => {
    if (h.updateFailsFor.has(ref.name)) throw new Error(`OneCLI secret update failed with HTTP 500 for "${ref.name}"`);
    if (h.updateLosesAnswerFor.has(ref.name)) throw new Error('OneCLI secret update timed out');
    h.updateCalls.push({ ref, value });
  }),
  deleteOnecliSecret: vi.fn(async (id: string) => {
    if (h.deleteFails) throw new Error('OneCLI secret delete failed with HTTP 500');
    h.deletes.push(id);
    for (const [name, ref] of h.vault) if (ref.id === id) h.vault.delete(name);
    return true;
  }),
}));
vi.mock('../mcp-oauth/service.js', () => ({
  IntegrationChangedError: class IntegrationChangedError extends Error {},
  clientCredentialsIntegration: vi.fn(async (name: string) => {
    if (name === 'oauth-example')
      throw new Error(`"${name}" is an OAuth login integration; it holds no client credentials to replace.`);
    const host = h.clientHosts.get(name);
    if (!host) throw new Error(`No integration named "${name}".`);
    return { host, agentGroupId: 'ag-1' };
  }),
  rekeyClientCredentials: vi.fn(
    async (
      name: string,
      pair: { clientId: string; clientSecret: string },
      _fetch: unknown,
      expected: { host: string; agentGroupId: string },
    ) => {
      h.rekeyExpected.push(expected);
      h.rekeyCalls.push([name, pair]);
      if (h.rekeyError) throw h.rekeyError;
      return { name, ...h.rekeyResult };
    },
  ),
}));
vi.mock('../../onecli-secrets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../onecli-secrets.js')>()),
  ensureOnecliAgent: vi.fn(async (input: { identifier: string }) => {
    h.lane.ensured.push(input.identifier);
    return { ...input, created: true };
  }),
  grantOnecliSecretToAgent: vi.fn(async (agent: string, secret: { id: string }) => {
    if (h.lane.grantFails) throw new Error('OneCLI grant failed with HTTP 500');
    h.lane.granted.push(`${agent}:${secret.id}`);
  }),
  agentsHoldingSecret: vi.fn(async (name: string) => [
    ...h.lane.granted.filter((g) => g.endsWith(`:id-${name}`)).map((g) => g.split(':')[0]),
    ...h.lane.others,
    ...(h.lane.othersAfterWrite && h.updateCalls.length ? ['ag-agent'] : []),
  ]),
}));
vi.mock('../../onecli-secret-grants.js', () => ({
  declareGroupSecret: vi.fn(async (groupId: string, name: string) => {
    h.groupGrants.push(`${groupId}:${name}`);
    return true;
  }),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: vi.fn(async (id: string) => h.groups.get(id)),
  workgroupExists: vi.fn(async (id: string) => h.workgroups.has(id)),
  addWorkgroupOnecliSecret: vi.fn(async (id: string, name: string) => {
    h.workgroupGrants.push(`${id}:${name}`);
    return true;
  }),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: vi.fn(async (id: string) => ({
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: 'mg-1',
    thread_id: 'T1',
  })),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: vi.fn(async () => ({
    id: 'mg-1',
    channel_type: h.originType,
    platform_id: 'slack:C1',
    name: 'ops',
  })),
}));
vi.mock('../../db/workgroup-surfaces.js', () => ({
  getWorkgroupChannelTypes: vi.fn(async (id: string) => h.workgroupTypes.get(id) ?? []),
}));
vi.mock('../../db/central-lease.js', () => ({
  withCentralSync: vi.fn(async (fn: () => unknown) => fn()),
  withRawDb: (fn: (db: unknown) => unknown) => fn('raw-db'),
}));
vi.mock('../../container-config.js', () => ({
  readContainerConfig: (folder: string) => ({ slack_user_token: { also_allowed_in: [`allowed-for-${folder}`] } }),
}));
vi.mock('../permissions/slack-user-token-gate.js', () => ({
  isOwnerSafeSlackSession: (...args: unknown[]) => {
    h.ownerSafeCalls.push(args);
    return h.ownerSafe;
  },
}));
vi.mock('../../delivery.js', () => ({
  getDeliveryAdapter: () => ({
    deliver: vi.fn(async (...args: unknown[]) => {
      if (h.deliverFails) throw new Error('Slack is down');
      if (h.deliverGate) await h.deliverGate;
      h.deliveries.push({ args });
      return `msg-${h.deliveries.length}`;
    }),
  }),
}));
vi.mock('../approvals/primitive.js', () => ({
  pickOwnersFirst: vi.fn(async () => h.ownerIds),
  pickApprovalDelivery: vi.fn(async (approvers: string[]) =>
    h.noDm.has(approvers[0])
      ? null
      : approvers[0].startsWith('discord')
        ? {
            userId: approvers[0],
            messagingGroup: { channel_type: 'discord', platform_id: 'discord:D9', instance: 'discord' },
          }
        : {
            userId: approvers[0],
            messagingGroup: { channel_type: 'slack', platform_id: 'slack:D1', instance: 'slack' },
          },
  ),
  notifyAgent: vi.fn(async (_session: unknown, text: string) => {
    if (h.notifyFails) throw new Error('session DB unavailable');
    h.notes.push(text);
  }),
}));
vi.mock('../permissions/db/user-roles.js', () => ({
  isOwner: (id: string) => h.owners.has(id),
  isGlobalAdmin: () => false,
  isAdminOfAgentGroup: (id: string, group: string) => h.groupAdmins.has(`${id}|${group}`),
}));
vi.mock('../permissions/user-dm.js', () => ({
  resolveUserChannelType: vi.fn(async (id: string) => id.slice(0, id.indexOf(':'))),
}));
vi.mock('../permissions/db/users.js', () => ({
  getUser: vi.fn(async (id: string) => (h.unknownUsers.has(id) ? undefined : { id, display_name: `name-of-${id}` })),
}));
vi.mock('../approved-run/targets.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../approved-run/targets.js')>()),
  targetsUsing: () => h.laneTargets,
}));
vi.mock('../../router.js', () => ({
  isSlackChannelType: (type: string) => type === 'slack' || type.startsWith('slack-'),
  isDiscordChannelType: (type: string) => type === 'discord' || type.startsWith('discord-'),
}));
vi.mock('../../log.js', () => {
  const record = (...args: unknown[]) => {
    h.logs.push(args);
  };
  return { log: { info: record, warn: record, error: record, debug: record } };
});

import { lookup } from '../../cli/registry.js';
import '../../cli/resources/secrets.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { withCentralSync } from '../../db/central-lease.js';
import { putReservedToken } from '../../reserved-token-store.js';
import { pickApprovalDelivery } from '../approvals/primitive.js';
import { OAuthTokenError } from '../mcp-oauth/oauth-client.js';
import { IntegrationChangedError } from '../mcp-oauth/service.js';
import {
  __resetSecretIntakesForTest,
  getSecretIntake,
  grantSecret,
  secretIntakeHooks,
  startSecretIntake,
  type SecretIntakeView,
} from './service.js';

const hooks = secretIntakeHooks('slack');
const submitValue = (intakeId: string, userId: string, value: string) =>
  hooks.submit(intakeId, userId, { secret_value: value });
const agentCaller = { kind: 'agent' as const, sessionId: 'sess-1', agentGroupId: 'ag-1' };
const newKey = {
  name: 'Linear-API-Key',
  rotate: false,
  hostPattern: 'api.linear.app',
  groups: [] as string[],
  workgroups: [] as string[],
};

async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

function everythingObservable(): string {
  return JSON.stringify({
    deliveries: h.deliveries,
    notes: h.notes,
    logs: h.logs,
    grants: [h.groupGrants, h.workgroupGrants],
  });
}

beforeEach(() => {
  __resetSecretIntakesForTest();
  h.vault.clear();
  h.lookupGate = null;
  h.lookups = 0;
  h.createCalls.length = 0;
  h.updateCalls.length = 0;
  h.createFails = false;
  h.createFailsFor.clear();
  h.createLosesAnswerFor.clear();
  h.createTimesOutFor.clear();
  h.updateFailsFor.clear();
  h.updateLosesAnswerFor.clear();
  h.clientHosts.clear();
  h.clientHosts.set('looker-example', 'looker.example.com');
  h.rekeyCalls.length = 0;
  h.rekeyExpected.length = 0;
  h.rekeyResult = { status: 'active', statusDetail: null, hostPattern: 'looker.example.com' };
  h.rekeyError = null;
  h.deliverFails = false;
  h.deliverGate = null;
  h.deliveries.length = 0;
  h.notes.length = 0;
  h.logs.length = 0;
  h.groupGrants.length = 0;
  h.workgroupGrants.length = 0;
  h.groups.clear();
  h.originType = 'slack';
  h.notifyFails = false;
  h.ownerIds = ['slack:UOWNER'];
  h.ownerSafe = false;
  h.ownerSafeCalls.length = 0;
  h.deletes.length = 0;
  h.deleteFails = false;
  h.extraCopies = [];
  h.createLosesAnswer = false;
  h.lookupFails = false;
  h.unknownUsers.clear();
  h.noDm.clear();
  h.workgroupTypes = new Map([
    ['wg-a', ['slack']],
    ['wg-b', ['slack']],
  ]);
  h.laneTargets = [];
  h.lane = { ensured: [], granted: [], others: [], grantFails: false, othersAfterWrite: false };
  h.groups.set('ag-1', { id: 'ag-1', name: 'Helper', folder: 'helper', workgroup_id: 'wg-a' });
  h.groups.set('ag-2', { id: 'ag-2', name: 'Other', folder: 'other', workgroup_id: 'wg-b' });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('startSecretIntake', () => {
  it('posts the card into the requesting thread, or to an owner DM for the host', async () => {
    await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(h.deliveries[0].args.slice(0, 3)).toEqual(['slack', 'slack:C1', 'T1']);
    await startSecretIntake({ ...newKey, name: 'Host-Key', caller: { kind: 'host' } });
    expect(h.deliveries[1].args.slice(0, 3)).toEqual(['slack', 'slack:D1', null]);
    expect(JSON.parse(h.deliveries[1].args[4] as string).body).toContain('Only an owner or global admin can enter it.');
  });

  it("sends a rotation to an owner DM unless the conversation is already the owner's own", async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    const rotation = { name: 'Linear-API-Key', rotate: true, groups: [], workgroups: [], caller: agentCaller };
    await startSecretIntake(rotation);
    expect(h.deliveries[0].args.slice(0, 3)).toEqual(['slack', 'slack:D1', null]);
    expect(h.ownerSafeCalls[0]).toEqual(['raw-db', 'ag-1', 'mg-1', ['allowed-for-helper']]);

    h.ownerSafe = true;
    await startSecretIntake(rotation);
    expect(h.deliveries[1].args.slice(0, 3)).toEqual(['slack', 'slack:C1', 'T1']);
    expect(JSON.parse(h.deliveries[1].args[4] as string).body).toContain('Only an owner or global admin can enter it.');
  });

  it('never consults owner-safety for a new secret, which a group admin may fill in the thread', async () => {
    await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(h.ownerSafeCalls).toEqual([]);
    expect(h.deliveries[0].args.slice(0, 3)).toEqual(['slack', 'slack:C1', 'T1']);
  });

  it("picks an owner's Slack DM over an earlier owner's Discord DM", async () => {
    h.ownerIds = ['discord:UFIRST', 'slack-inst:UOWNER'];
    await startSecretIntake({ ...newKey, caller: { kind: 'host' } });
    expect(h.deliveries[0].args.slice(0, 2)).toEqual(['slack', 'slack:D1']);
  });

  it.each([
    {
      when: "one workgroup: an owner DM on that workgroup's Slack, not an earlier owner's other workspace",
      workgroups: ['wg-a'],
      owners: ['slack-other:UOWNER', 'slack-mine:UOWNER'],
      own: ['discord', 'slack-mine'],
      to: 'slack-mine:UOWNER',
    },
    {
      when: "one workgroup with no reachable Slack: that workgroup's Discord",
      workgroups: ['wg-a'],
      owners: ['slack-other:UOWNER', 'discord:UOWNER'],
      own: ['cli', 'discord'],
      to: 'discord:UOWNER',
    },
    {
      when: 'one workgroup: its Slack before its Discord',
      workgroups: ['wg-a'],
      owners: ['discord:UOWNER', 'slack-mine:UOWNER'],
      own: ['discord', 'slack-mine'],
      to: 'slack-mine:UOWNER',
    },
    {
      when: "one workgroup whose Slack DM can't be opened: refused, not sent to another workspace",
      workgroups: ['wg-a'],
      owners: ['slack-mine:UOWNER', 'slack-other:UOWNER'],
      own: ['slack-mine'],
      noDm: ['slack-mine:UOWNER'],
      to: null,
    },
    {
      when: 'one workgroup with no surface that opens a form: refused',
      workgroups: ['wg-a'],
      owners: ['slack-other:UOWNER', 'teams:UOWNER'],
      own: ['cli', 'teams'],
      to: null,
    },
    {
      when: "one group's workgroup, named through --groups alone: that workgroup's Slack",
      groups: ['ag-1'],
      owners: ['slack-other:UOWNER', 'slack-mine:UOWNER'],
      own: ['slack-mine'],
      to: 'slack-mine:UOWNER',
    },
    {
      when: 'a workgroup and a group in another workgroup: the first owner with a Slack DM, as before',
      workgroups: ['wg-b'],
      groups: ['ag-1'],
      owners: ['slack-other:UOWNER', 'slack-mine:UOWNER'],
      own: ['slack-mine'],
      to: 'slack-other:UOWNER',
    },
    {
      when: 'several workgroups: the first owner with a Slack DM, as before',
      workgroups: ['wg-a', 'wg-b'],
      owners: ['slack-other:UOWNER', 'slack-mine:UOWNER'],
      own: ['slack-mine'],
      to: 'slack-other:UOWNER',
    },
    {
      when: 'no workgroup: the first owner with a Slack DM, as before',
      workgroups: [],
      owners: ['slack-other:UOWNER', 'slack-mine:UOWNER'],
      own: ['slack-mine'],
      to: 'slack-other:UOWNER',
    },
  ])('host form, $when', async ({ workgroups = [], groups = [], owners, own, noDm, to }) => {
    h.ownerIds = owners;
    h.workgroupTypes.set('wg-a', own);
    for (const id of noDm ?? []) h.noDm.add(id);
    vi.mocked(pickApprovalDelivery).mockClear();
    const start = startSecretIntake({ ...newKey, workgroups, groups, caller: { kind: 'host' } });
    if (to === null) {
      await expect(start).rejects.toThrow(/surface of workgroup "wg-a".*never sent to another workgroup/);
      expect(h.deliveries).toEqual([]);
    } else {
      await start;
      expect(h.deliveries).toHaveLength(1);
      expect(vi.mocked(pickApprovalDelivery).mock.calls.at(-1)?.[0]).toEqual([to]);
    }
  });

  it("sends an agent's rotation that isn't owner-safe to an owner DM on its own workgroup's surface", async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    h.ownerIds = ['slack-other:UOWNER', 'slack-mine:UOWNER'];
    h.workgroupTypes.set('wg-a', ['slack-mine']);
    vi.mocked(pickApprovalDelivery).mockClear();
    await startSecretIntake({ name: 'Linear-API-Key', rotate: true, groups: [], workgroups: [], caller: agentCaller });
    expect(h.deliveries).toHaveLength(1);
    expect(vi.mocked(pickApprovalDelivery).mock.calls.at(-1)?.[0]).toEqual(['slack-mine:UOWNER']);
  });

  it('posts a Discord request in its thread, a Discord rotation there only when owner-safe', async () => {
    h.originType = 'discord-codex';
    await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(h.deliveries[0].args.slice(0, 3)).toEqual(['discord-codex', 'slack:C1', 'T1']);

    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    const rotation = { name: 'Linear-API-Key', rotate: true, groups: [], workgroups: [], caller: agentCaller };
    await startSecretIntake(rotation);
    expect(h.deliveries[1].args.slice(0, 3)).toEqual(['slack', 'slack:D1', null]);
    h.ownerSafe = true;
    await startSecretIntake(rotation);
    expect(h.deliveries[2].args.slice(0, 3)).toEqual(['discord-codex', 'slack:C1', 'T1']);
  });

  it('sends a card from a platform that cannot open forms to an owner DM instead', async () => {
    h.originType = 'telegram';
    await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(h.deliveries[0].args.slice(0, 3)).toEqual(['slack', 'slack:D1', null]);
  });

  it("posts a card naming the host and grants, and grants the calling group's workgroup by default", async () => {
    const view = await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(view).toMatchObject({
      secretName: 'Linear-API-Key',
      mode: 'create',
      status: 'pending',
      groups: [],
      workgroups: ['wg-a'],
    });
    expect(h.deliveries).toHaveLength(1);
    const content = JSON.parse(h.deliveries[0].args[4] as string);
    expect(content).toMatchObject({ type: 'secret_intake', intakeId: view.intakeId });
    expect(content.body).toContain('api.linear.app');
    expect(content.body).toContain('Authorization: Bearer <secret>');
    expect(content.body).toContain('workgroups wg-a');
    expect(content.body).toContain('Agent "Helper"');
  });

  it('grants the calling group itself by default when it is in no workgroup', async () => {
    h.groups.set('ag-1', { id: 'ag-1', name: 'Helper', folder: 'helper', workgroup_id: null });
    const view = await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(view).toMatchObject({ groups: ['ag-1'], workgroups: [] });
  });

  it.each([
    [{ name: 'bad name!' }, /Secret names/],
    [{ hostPattern: undefined }, /--host-pattern is required/],
    [{ hostPattern: 'https://api.linear.app/v1' }, /--host-pattern is required/],
    [{ valueFormat: 'Bearer' }, /containing \{value\}/],
    [{ valueFormat: 'Bearer {value}\nX-Other: 1' }, /one line/],
    [{ hostPattern: '*' }, /--host-pattern is required/],
    [{ hostPattern: '*.com' }, /--host-pattern is required/],
    [{ hostPattern: '*.linear.app' }, /--host-pattern is required/],
    [{ hostPattern: '*.co.uk' }, /--host-pattern is required/],
    [{ pathPattern: 'v1/*' }, /must start with \//],
    [{ headerName: 'Bad Header' }, /Invalid header name/],
    [{ groups: ['ag-2'] }, /only to its own group/],
    [{ workgroups: ['wg-b'] }, /only to its own workgroup/],
    [{ rotate: true, hostPattern: 'api.linear.app' }, /Drop those flags/],
  ])('refuses %o before posting anything', async (override, message) => {
    await expect(startSecretIntake({ ...newKey, ...override, caller: agentCaller })).rejects.toThrow(message);
    expect(h.deliveries).toHaveLength(0);
  });

  it('refuses a new name the vault already has, and a rotation of one it lacks', async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    await expect(startSecretIntake({ ...newKey, caller: agentCaller })).rejects.toThrow(/Pass --rotate/);
    await expect(
      startSecretIntake({ name: 'Missing', rotate: true, groups: [], workgroups: [], caller: agentCaller }),
    ).rejects.toThrow(/nothing to rotate/);
  });

  it("refuses a second pending intake for the same name from someone else, but replaces the requester's own", async () => {
    const first = await startSecretIntake({ ...newKey, caller: agentCaller });
    await expect(startSecretIntake({ ...newKey, caller: { kind: 'host' } })).rejects.toThrow(/already waiting/);
    const second = await startSecretIntake({ ...newKey, hostPattern: 'api2.linear.app', caller: agentCaller });
    expect(getSecretIntake(first.intakeId)?.status).toBe('expired');
    expect(JSON.parse(h.deliveries[1].args[4] as string)).toMatchObject({ type: 'secret_intake' });
    expect(JSON.parse(h.deliveries[2].args[4] as string)).toMatchObject({ operation: 'edit', messageId: 'msg-1' });
    expect(JSON.parse(h.deliveries[2].args[4] as string).text).toContain('Replaced by a newer request');
    expect(await hooks.open(first.intakeId, 'UOWNER')).toMatchObject({ ok: false });
    expect(getSecretIntake(second.intakeId)?.status).toBe('pending');
  });

  it('keeps the old card live when the replacement cannot be posted', async () => {
    const first = await startSecretIntake({ ...newKey, caller: agentCaller });
    h.deliverFails = true;
    await expect(startSecretIntake({ ...newKey, caller: agentCaller })).rejects.toThrow(/Could not post/);
    expect(getSecretIntake(first.intakeId)?.status).toBe('pending');
  });

  it('leaves an old card alone if it was submitted while its replacement was posting', async () => {
    const first = await startSecretIntake({ ...newKey, caller: agentCaller });
    let open!: () => void;
    h.deliverGate = new Promise((resolve) => {
      open = resolve;
    });
    const second = startSecretIntake({ ...newKey, caller: agentCaller });
    await settle();
    await submitValue(first.intakeId, 'UOWNER', SECRET);
    open();
    h.deliverGate = null;
    await second;
    await settle();
    expect(getSecretIntake(first.intakeId)?.status).toBe('stored');
    expect(JSON.stringify(h.deliveries)).not.toContain('Replaced by a newer request');
  });

  it('lets a session at its cap replace one of its own requests', async () => {
    for (const n of ['A', 'B', 'C']) await startSecretIntake({ ...newKey, name: `Key-${n}`, caller: agentCaller });
    await expect(startSecretIntake({ ...newKey, name: 'Key-A', caller: agentCaller })).resolves.toMatchObject({
      status: 'pending',
    });
  });

  it('caps the pending requests one session can hold', async () => {
    for (const n of ['A', 'B', 'C']) await startSecretIntake({ ...newKey, name: `Key-${n}`, caller: agentCaller });
    await expect(startSecretIntake({ ...newKey, name: 'Key-D', caller: agentCaller })).rejects.toThrow(/already has 3/);
    expect(h.deliveries).toHaveLength(3);
  });

  it('lets the host grant to any existing group and workgroup', async () => {
    const view = await startSecretIntake({
      ...newKey,
      groups: ['ag-1,ag-2'],
      workgroups: ['wg-b'],
      caller: { kind: 'host' },
    });
    expect(view.groups).toEqual(['ag-1', 'ag-2']);
    expect(view.workgroups).toEqual(['wg-b']);
    await expect(
      startSecretIntake({ ...newKey, name: 'Other-Key', workgroups: ['wg-nope'], caller: { kind: 'host' } }),
    ).rejects.toThrow(/Workgroup not found/);
  });
});

describe('the form', () => {
  it('stores nothing for a submit by someone with no authority, says so in the thread, and stays open', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(await submitValue(intakeId, 'USTRANGER', SECRET)).toEqual({ ok: true });
    await settle();
    expect(h.createCalls).toHaveLength(0);
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
    const note = h.deliveries.at(-1)!.args;
    expect(note.slice(0, 4)).toEqual(['slack', 'slack:C1', 'T1', 'chat']);
    expect(JSON.parse(note[4] as string).text).toMatch(/Only an owner, a global admin or an admin of "Helper"/);
    expect(everythingObservable()).not.toContain(SECRET);
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.createCalls).toHaveLength(1);
  });

  it('refuses the form up front when the lease answers in time and the clicker has no authority', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(await hooks.open(intakeId, 'USTRANGER')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/Only/),
    });
    expect(await hooks.open(intakeId, 'UADMIN2')).toMatchObject({ ok: false });
    expect(await hooks.open(intakeId, 'UADMIN1')).toMatchObject({ ok: true });
  });

  it("lets an admin of the requesting agent's group store it, and tells the owner without the value", async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    await submitValue(intakeId, 'UADMIN1', SECRET);
    await settle();
    expect(h.createCalls).toHaveLength(1);
    const fyi = h.deliveries.find((d) => d.args[1] === 'slack:D1' && d.args[3] === 'chat');
    expect(fyi).toBeDefined();
    const text = JSON.parse(fyi!.args[4] as string).text as string;
    expect(text).toContain('name-of-slack:UADMIN1');
    expect(text).toContain('Linear-API-Key');
    expect(text).toContain('api.linear.app');
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('sends the owner no notice when an owner stores it', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.deliveries.some((d) => d.args[1] === 'slack:D1')).toBe(false);
  });

  it('refuses an admin of another group', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    await submitValue(intakeId, 'UADMIN2', SECRET);
    await settle();
    expect(h.createCalls).toHaveLength(0);
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
  });

  it('never lets a group admin rotate; an owner still can', async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    const { intakeId } = await startSecretIntake({
      name: 'Linear-API-Key',
      rotate: true,
      groups: [],
      workgroups: [],
      caller: agentCaller,
    });
    expect(JSON.parse(h.deliveries[0].args[4] as string).body).toContain('Only an owner or global admin can enter it.');
    expect(await hooks.open(intakeId, 'UADMIN1')).toMatchObject({ ok: false });
    await submitValue(intakeId, 'UADMIN1', SECRET);
    await settle();
    expect(h.updateCalls).toHaveLength(0);
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.updateCalls).toHaveLength(1);
  });

  it('sends the owner notice even when a later follow-up fails', async () => {
    h.notifyFails = true;
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    await submitValue(intakeId, 'UADMIN1', SECRET);
    await settle();
    expect(h.createCalls).toHaveLength(1);
    expect(h.deliveries.some((d) => d.args[1] === 'slack:D1' && d.args[3] === 'chat')).toBe(true);
    expect(getSecretIntake(intakeId)?.status).toBe('stored');
  });

  it('answers open and submit without waiting on the central lease', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    vi.mocked(withCentralSync).mockImplementation(() => new Promise(() => {}));
    try {
      expect(await hooks.open(intakeId, 'UOWNER')).toMatchObject({ ok: true, form: { title: 'Store secret' } });
      expect(await submitValue(intakeId, 'UOWNER', SECRET)).toEqual({ ok: true });
    } finally {
      vi.mocked(withCentralSync).mockImplementation((async (fn: () => unknown) => fn()) as never);
    }
  });

  it('counts a submitted, still-storing intake as live for the same name', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    vi.mocked(withCentralSync).mockImplementation(() => new Promise(() => {}));
    try {
      await submitValue(intakeId, 'UOWNER', SECRET);
      expect(getSecretIntake(intakeId)?.status).toBe('storing');
      await expect(startSecretIntake({ ...newKey, caller: agentCaller })).rejects.toThrow(/already waiting/);
    } finally {
      vi.mocked(withCentralSync).mockImplementation((async (fn: () => unknown) => fn()) as never);
    }
  });

  it('fails the intake, visibly, when the authority lookup throws', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    vi.mocked(withCentralSync).mockImplementationOnce(async () => {
      throw new Error('central DB unavailable');
    });
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(getSecretIntake(intakeId)).toMatchObject({ status: 'failed', detail: 'central DB unavailable' });
    expect(h.createCalls).toHaveLength(0);
    expect(h.notes[0]).toContain('was NOT stored');
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('refuses an empty value or one with whitespace, keeping the intake pending', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    expect(await submitValue(intakeId, 'UOWNER', '  ')).toEqual({
      ok: false,
      field: 'secret_value',
      message: 'Paste a value for "Secret value".',
    });
    expect(await submitValue(intakeId, 'UOWNER', 'sk one')).toMatchObject({ ok: false });
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
  });

  it('stores the value, grants after the store, edits the card and tells the agent — without the value', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, workgroups: ['wg-a'], caller: agentCaller });
    expect(await submitValue(intakeId, 'UOWNER', `  ${SECRET}\n`)).toEqual({ ok: true });
    await settle();

    expect(h.createCalls).toEqual([
      {
        spec: {
          name: 'Linear-API-Key',
          hostPattern: 'api.linear.app',
          pathPattern: null,
          headerName: 'Authorization',
          valueFormat: 'Bearer {value}',
        },
        value: SECRET,
      },
    ]);
    expect(h.workgroupGrants).toEqual(['wg-a:Linear-API-Key']);
    expect(getSecretIntake(intakeId)?.status).toBe('stored');
    const edit = JSON.parse(h.deliveries[1].args[4] as string);
    expect(edit).toMatchObject({ operation: 'edit', messageId: 'msg-1', clearActions: true });
    expect(edit.text).toContain('Stored');
    expect(h.notes[0]).toContain('Secret "Linear-API-Key" stored in the vault');

    expect(everythingObservable()).not.toContain(SECRET);
    expect(JSON.stringify(getSecretIntake(intakeId))).not.toContain(SECRET);
    expect(await submitValue(intakeId, 'UOWNER', SECRET)).toMatchObject({ ok: false });
  });

  it('writes once when two submits race past the authority check', async () => {
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    const results = await Promise.all([
      submitValue(intakeId, 'UOWNER', SECRET),
      submitValue(intakeId, 'UOWNER', SECRET),
    ]);
    await settle();
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(h.createCalls).toHaveLength(1);
  });

  it('grants nothing new on a rotation unless asked', async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    const view = await startSecretIntake({
      name: 'Linear-API-Key',
      rotate: true,
      groups: [],
      workgroups: [],
      caller: agentCaller,
    });
    expect(view.groups).toEqual([]);
    expect(JSON.parse(h.deliveries[0].args[4] as string).body).toContain('New grants: none; current holders keep it');
    expect(JSON.parse(h.deliveries[0].args[4] as string).body).not.toContain('nobody yet');
    await submitValue(view.intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.groupGrants).toEqual([]);
    expect(JSON.parse(h.deliveries[1].args[4] as string).text).toContain('New grants: none; current holders keep it');
    expect(h.notes[0]).toContain('New grants: none; current holders keep it');
  });

  it('rotates by value only', async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    const { intakeId } = await startSecretIntake({
      name: 'Linear-API-Key',
      rotate: true,
      groups: [],
      workgroups: [],
      caller: { kind: 'host' },
    });
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.updateCalls).toEqual([{ ref: { id: 'id-1', name: 'Linear-API-Key' }, value: SECRET }]);
    expect(h.createCalls).toHaveLength(0);
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('grants nothing when the vault write fails, and says so', async () => {
    h.createFails = true;
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();
    expect(getSecretIntake(intakeId)?.status).toBe('failed');
    expect(h.groupGrants).toHaveLength(0);
    expect(h.notes[0]).toContain('was NOT stored');
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('stays open for a day, then expires', async () => {
    vi.useFakeTimers();
    const { intakeId } = await startSecretIntake({ ...newKey, caller: agentCaller });
    vi.advanceTimersByTime(24 * 60 * 60_000 - 1);
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
    vi.advanceTimersByTime(1);
    expect(await hooks.open(intakeId, 'UOWNER')).toMatchObject({
      ok: false,
      message: expect.stringMatching(/expired/),
    });
    expect(getSecretIntake(intakeId)?.status).toBe('expired');
  });
});

describe('declared fields', () => {
  const CLIENT_ID = 'cid-SENTINEL-4f1a';
  const API_SECRET = 'as-SENTINEL-77b0';
  const COMPOSED = Buffer.from(`${CLIENT_ID}:${SECRET}`).toString('base64');
  const basic = {
    ...newKey,
    name: 'Example-Client',
    hostPattern: 'auth.example.com',
    compose: 'basic',
    fields: ['client_id|Client ID', 'client_secret|Client secret'],
  };
  const separate = {
    ...newKey,
    name: 'Example-API',
    hostPattern: 'api.example.com',
    fields: ['api_key|API key|X-Api-Key', 'api_secret?|API secret|X-Api-Secret|Token {value}'],
  };
  const rotation = {
    rotate: true,
    groups: [] as string[],
    workgroups: [] as string[],
    caller: { kind: 'host' as const },
  };

  it('opens one input per field and lists them on the card, basic defaulting to Basic', async () => {
    const { intakeId } = await startSecretIntake({ ...basic, caller: agentCaller });
    const body = JSON.parse(h.deliveries[0].args[4] as string).body as string;
    expect(body).toContain('asks for "Client ID", "Client secret"');
    expect(body).toContain('Basic <secret>');
    expect(await hooks.open(intakeId, 'UOWNER')).toMatchObject({
      ok: true,
      form: {
        inputs: [
          { id: 'client_id', label: 'Client ID', optional: false },
          { id: 'client_secret', label: 'Client secret', optional: false },
        ],
      },
    });
  });

  it('basic stores base64 of "<first>:<second>" as one secret, exposing none of the three values', async () => {
    const { intakeId } = await startSecretIntake({ ...basic, caller: agentCaller });
    expect(
      await hooks.submit(intakeId, 'UADMIN1', { client_id: ` ${CLIENT_ID} `, client_secret: `${SECRET}\n` }),
    ).toEqual({ ok: true });
    await settle();
    expect(h.createCalls).toEqual([
      { spec: expect.objectContaining({ name: 'Example-Client', valueFormat: 'Basic {value}' }), value: COMPOSED },
    ]);
    const observed = everythingObservable() + JSON.stringify(getSecretIntake(intakeId));
    for (const leaked of [CLIENT_ID, SECRET, COMPOSED]) expect(observed).not.toContain(leaked);
  });

  it('separate stores each field as its own secret with its own header, and grants every one', async () => {
    const { intakeId } = await startSecretIntake({ ...separate, workgroups: ['wg-a'], caller: agentCaller });
    const body = JSON.parse(h.deliveries[0].args[4] as string).body as string;
    expect(body).toContain('"API key" → Example-API-api_key');
    expect(body).toContain('"API secret" (optional)');
    expect(await hooks.open(intakeId, 'UOWNER')).toMatchObject({
      form: {
        inputs: [
          { id: 'api_key', optional: false },
          { id: 'api_secret', optional: true },
        ],
      },
    });
    await hooks.submit(intakeId, 'UOWNER', { api_key: SECRET, api_secret: API_SECRET });
    await settle();
    expect(h.createCalls).toEqual([
      {
        spec: expect.objectContaining({ name: 'Example-API-api_key', headerName: 'X-Api-Key', valueFormat: '{value}' }),
        value: SECRET,
      },
      {
        spec: expect.objectContaining({
          name: 'Example-API-api_secret',
          headerName: 'X-Api-Secret',
          valueFormat: 'Token {value}',
        }),
        value: API_SECRET,
      },
    ]);
    expect(h.workgroupGrants).toEqual(['wg-a:Example-API-api_key', 'wg-a:Example-API-api_secret']);
    expect(getSecretIntake(intakeId)?.secrets).toEqual(['Example-API-api_key', 'Example-API-api_secret']);
    const observed = everythingObservable() + JSON.stringify(getSecretIntake(intakeId));
    for (const leaked of [SECRET, API_SECRET]) expect(observed).not.toContain(leaked);
  });

  it('stores nothing, and grants nothing, for a blank optional field', async () => {
    const { intakeId } = await startSecretIntake({ ...separate, caller: agentCaller });
    await hooks.submit(intakeId, 'UOWNER', { api_key: SECRET, api_secret: '' });
    await settle();
    expect(h.createCalls.map((c) => (c.spec as { name: string }).name)).toEqual(['Example-API-api_key']);
    expect(h.workgroupGrants).toEqual(['wg-a:Example-API-api_key']);
  });

  it('a rotation replaces only the fields filled in', async () => {
    h.vault.set('Example-API-api_key', { id: 'k', name: 'Example-API-api_key' });
    h.vault.set('Example-API-api_secret', { id: 's', name: 'Example-API-api_secret' });
    const { intakeId } = await startSecretIntake({
      ...rotation,
      name: 'Example-API',
      fields: ['api_key|API key', 'api_secret|API secret'],
    });
    expect(await hooks.open(intakeId, 'UOWNER')).toMatchObject({
      form: { inputs: [{ optional: true }, { optional: true }] },
    });
    expect(await hooks.submit(intakeId, 'UOWNER', { api_key: '', api_secret: '' })).toMatchObject({
      ok: false,
      message: 'Fill in at least one field.',
    });
    await hooks.submit(intakeId, 'UOWNER', { api_key: '', api_secret: API_SECRET });
    await settle();
    expect(h.updateCalls).toEqual([{ ref: { id: 's', name: 'Example-API-api_secret' }, value: API_SECRET }]);
    expect(everythingObservable()).not.toContain(API_SECRET);
  });

  it('a basic rotation takes both fields again', async () => {
    h.vault.set('Example-Client', { id: 'id-1', name: 'Example-Client' });
    const { intakeId } = await startSecretIntake({
      ...rotation,
      name: 'Example-Client',
      compose: 'basic',
      fields: basic.fields,
    });
    await hooks.submit(intakeId, 'UOWNER', { client_id: CLIENT_ID, client_secret: SECRET });
    await settle();
    expect(h.updateCalls).toEqual([{ ref: { id: 'id-1', name: 'Example-Client' }, value: COMPOSED }]);
    expect(everythingObservable()).not.toContain(COMPOSED);
  });

  it('refuses an empty required field, whitespace, or a colon in a basic first field, keeping it open', async () => {
    const { intakeId } = await startSecretIntake({ ...basic, caller: agentCaller });
    expect(await hooks.submit(intakeId, 'UOWNER', { client_id: CLIENT_ID, client_secret: ' ' })).toMatchObject({
      ok: false,
      field: 'client_secret',
    });
    expect(await hooks.submit(intakeId, 'UOWNER', { client_id: 'a b', client_secret: SECRET })).toMatchObject({
      ok: false,
      field: 'client_id',
    });
    expect(await hooks.submit(intakeId, 'UOWNER', { client_id: 'a:b', client_secret: SECRET })).toMatchObject({
      ok: false,
      field: 'client_id',
      message: expect.stringMatching(/colon/),
    });
    expect(h.createCalls).toHaveLength(0);
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
  });

  it('reports the secrets already stored when a later one fails, grants none, and still tells the owner', async () => {
    const { intakeId } = await startSecretIntake({ ...separate, caller: agentCaller });
    const { createOnecliSecret } = await import('../../onecli-secret-writer.js');
    vi.mocked(createOnecliSecret).mockImplementationOnce(async (spec, value) => {
      h.createCalls.push({ spec, value });
      h.vault.set(spec.name, { id: 'x', name: spec.name });
      return { id: 'x', name: spec.name };
    });
    h.createFails = true;
    await hooks.submit(intakeId, 'UADMIN1', { api_key: SECRET, api_secret: API_SECRET });
    await settle();
    expect(getSecretIntake(intakeId)?.status).toBe('failed');
    const notice = h.deliveries.find((d) => d.args[1] === 'slack:D1');
    expect(JSON.parse(notice?.args[4] as string).text).toContain('stored secret "Example-API-api_key" for agent');
    expect(JSON.parse(notice?.args[4] as string).text).not.toContain('Example-API-api_secret');
    expect(JSON.parse(notice?.args[4] as string).text).toContain('nothing was granted');
    expect(JSON.parse(notice?.args[4] as string).text).not.toContain('Granted to');
    expect(h.notes[0]).toContain('was only partly stored');
    expect(getSecretIntake(intakeId)?.detail).toContain('"Example-API-api_key" stored but granted to no one');
    expect(h.groupGrants).toEqual([]);
    expect(everythingObservable()).not.toContain(API_SECRET);
  });

  it.each([
    [{ fields: ['a|A|X-A', 'a|B|X-B'] }, /declared twice/],
    [{ fields: ['a|A|Bad Header', 'b|B|X-B'] }, /Invalid header name/],
    [{ fields: ['a|A|X-Same', 'b|B|x-same'] }, /Two fields are sent as header/],
    [{ fields: ['a|A', 'b|B|X-B'] }, /"a" needs a header/],
    [{ fields: ['a|A|X-A', 'b|B|X-B'], headerName: 'X-C' }, /its own header/],
    [{ compose: 'basic', fields: ['a|A', 'b?|B'] }, /exactly two required fields/],
    [{ compose: 'basic', fields: ['a|A', 'b|B', 'c|C'] }, /exactly two required fields/],
    [{ compose: 'basic', fields: ['a|A|X-A', 'b|B'] }, /only --compose separate/],
    [{ compose: 'separate', fields: ['a|A|X-A'] }, /two or more fields/],
    [{ fields: ['a?|A'] }, /cannot be optional/],
    [{ compose: 'basic' }, /--compose needs --field/],
    [{ fields: ['Bad-Name|A'] }, /Field name/],
    [{ fields: ['a|A|X-A', 'b|B|X-B', 'c|C|X-C', 'd|D|X-D', 'e|E|X-E', 'f|F|X-F'] }, /At most 5/],
  ])('refuses %o', async (overrides, error) => {
    await expect(startSecretIntake({ ...newKey, ...overrides, caller: agentCaller })).rejects.toThrow(error);
    expect(h.deliveries).toHaveLength(0);
  });

  it('refuses a request whose secrets overlap one already waiting', async () => {
    await startSecretIntake({ ...separate, caller: agentCaller });
    await expect(
      startSecretIntake({ ...newKey, name: 'Example-API-api_secret', caller: { kind: 'host' } }),
    ).rejects.toThrow(/already waiting/);
  });

  it('refuses a header or format on a rotation field', async () => {
    h.vault.set('Example-API-api_key', { id: 'k', name: 'Example-API-api_key' });
    h.vault.set('Example-API-api_secret', { id: 's', name: 'Example-API-api_secret' });
    await expect(
      startSecretIntake({ ...rotation, name: 'Example-API', fields: ['api_key|K|X-Api-Key', 'api_secret|S'] }),
    ).rejects.toThrow(/drop the header and format/);
  });

  it('refuses a separate secret name that would exist, and a rotation of one that does not', async () => {
    h.vault.set('Example-API-api_secret', { id: 's', name: 'Example-API-api_secret' });
    await expect(startSecretIntake({ ...separate, caller: agentCaller })).rejects.toThrow(
      /"Example-API-api_secret" already exists/,
    );
    await expect(
      startSecretIntake({ ...rotation, name: 'Example-API', fields: ['api_key|K', 'api_secret|S'] }),
    ).rejects.toThrow(/"Example-API-api_key" is not in the vault/);
  });
});

describe('host sets', () => {
  const HOSTS = ['ab1.example.com', 'ab1.metadata.example.com', 'ab1.semantic.example.com'];
  const MEMBERS = ['Example-Cloud-1of3', 'Example-Cloud-2of3', 'Example-Cloud-3of3'];
  const setKey = {
    name: 'Example-Cloud',
    rotate: false,
    hostPattern: [`${HOSTS[0]}=Token {value}`, HOSTS[1], HOSTS[2]],
    groups: [] as string[],
    workgroups: ['wg-a'],
  };
  const rotation = { name: 'Example-Cloud', rotate: true, groups: [] as string[], workgroups: [] as string[] };
  const cardBody = () => JSON.parse(h.deliveries[0].args[4] as string).body as string;
  const seedSet = (names: string[]) => {
    for (const [i, name] of names.entries()) h.vault.set(name, { id: `id-${name}`, name, hostPattern: HOSTS[i] });
  };

  it('stores one pasted value once per host with its own format, lists every host on the card, and grants each', async () => {
    const { intakeId, secrets } = await startSecretIntake({ ...setKey, caller: agentCaller });
    expect(secrets).toEqual(MEMBERS);
    expect(cardBody()).toContain(
      `${MEMBERS[0]}: Sent only to ${HOSTS[0]}, as header \`Authorization: Token <secret>\``,
    );
    expect(cardBody()).toContain(
      `${MEMBERS[1]}: Sent only to ${HOSTS[1]}, as header \`Authorization: Bearer <secret>\``,
    );
    expect(cardBody()).toContain(`${MEMBERS[2]}: Sent only to ${HOSTS[2]}`);

    expect(await submitValue(intakeId, 'UOWNER', SECRET)).toEqual({ ok: true });
    await settle();

    expect(
      h.createCalls.map(({ spec, value }) => {
        const { name, hostPattern, valueFormat } = spec as { name: string; hostPattern: string; valueFormat: string };
        return [name, hostPattern, valueFormat, value];
      }),
    ).toEqual([
      [MEMBERS[0], HOSTS[0], 'Token {value}', SECRET],
      [MEMBERS[1], HOSTS[1], 'Bearer {value}', SECRET],
      [MEMBERS[2], HOSTS[2], 'Bearer {value}', SECRET],
    ]);
    expect(h.workgroupGrants).toEqual(MEMBERS.map((name) => `wg-a:${name}`));
    expect(getSecretIntake(intakeId)?.status).toBe('stored');
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('removes what it stored when a later host fails, and grants nothing', async () => {
    const { intakeId } = await startSecretIntake({ ...setKey, caller: agentCaller });
    h.createFailsFor.add(MEMBERS[1]);
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();

    expect(h.createCalls.map(({ spec }) => (spec as { name: string }).name)).toEqual(MEMBERS.slice(0, 2));
    expect(h.deletes).toEqual([`id-${MEMBERS[0]}`]);
    expect([...h.vault.keys()]).toEqual([]);
    expect(h.workgroupGrants).toEqual([]);
    expect(getSecretIntake(intakeId)?.status).toBe('failed');
    expect(h.notes[0]).toContain('was NOT stored');
    expect(h.notes[0]).toContain('removed again');
  });

  it('reports the outcome as unknown when it cannot tell whether the vault kept the failed host', async () => {
    const { intakeId } = await startSecretIntake({ ...setKey, caller: agentCaller });
    h.createFailsFor.add(MEMBERS[1]);
    h.lookupFails = true;
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();

    expect(h.deletes).toEqual([`id-${MEMBERS[0]}`]);
    expect(getSecretIntake(intakeId)?.status).toBe('failed');
    expect(h.notes[0]).toContain('in an unknown state');
    expect(h.notes[0]).not.toContain('NOT stored');
    expect(getSecretIntake(intakeId)?.detail).toContain(`"${MEMBERS[1]}" may be in the vault`);
  });

  it('rotates every member of a complete set with the one value, naming each host on the card', async () => {
    seedSet(MEMBERS);
    const { intakeId, secrets } = await startSecretIntake({ ...rotation, caller: { kind: 'host' } });
    expect(secrets).toEqual(MEMBERS);
    for (const [i, name] of MEMBERS.entries())
      expect(cardBody()).toContain(`${name}: Replaces the value sent to ${HOSTS[i]}`);

    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();

    expect(h.updateCalls.map(({ ref, value }) => [(ref as { name: string }).name, value])).toEqual(
      MEMBERS.map((name) => [name, SECRET]),
    );
    expect(h.createCalls).toEqual([]);
    expect(getSecretIntake(intakeId)?.status).toBe('stored');
  });

  it('removes a member the vault kept although its create got no answer, then reports nothing stored', async () => {
    const { intakeId } = await startSecretIntake({ ...setKey, caller: agentCaller });
    h.createLosesAnswerFor.add(MEMBERS[1]);
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();

    expect(h.deletes.sort()).toEqual([`id-${MEMBERS[0]}`, `id-${MEMBERS[1]}`]);
    expect([...h.vault.keys()]).toEqual([]);
    expect(h.notes[0]).toContain('was NOT stored');
  });

  it.each([
    [
      'a create that got no answer and is not in the vault yet',
      () => h.createTimesOutFor.add(MEMBERS[1]),
      'may still be stored',
    ],
    [
      'a rollback delete that fails',
      () => {
        h.createFailsFor.add(MEMBERS[1]);
        h.deleteFails = true;
      },
      `removing "${MEMBERS[0]}"`,
    ],
  ])('reports the outcome as unknown after %s', async (_name, fault, detail) => {
    const { intakeId } = await startSecretIntake({ ...setKey, caller: agentCaller });
    fault();
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();

    expect(getSecretIntake(intakeId)?.status).toBe('failed');
    expect(h.notes[0]).toContain('in an unknown state');
    expect(getSecretIntake(intakeId)?.detail).toContain(detail);
    expect(h.workgroupGrants).toEqual([]);
  });

  it("names only what may remain in the owner notice when a group admin's set ends unknown", async () => {
    const { intakeId } = await startSecretIntake({ ...setKey, caller: agentCaller });
    h.createTimesOutFor.add(MEMBERS[1]);
    await submitValue(intakeId, 'UADMIN1', SECRET);
    await settle();

    expect(h.deletes).toEqual([`id-${MEMBERS[0]}`]);
    const notice = JSON.parse(h.deliveries.find((d) => d.args[1] === 'slack:D1')?.args[4] as string).text as string;
    expect(notice).toContain(`stored secret "${MEMBERS[1]}"`);
    expect(notice).not.toContain(`"${MEMBERS[0]}"`);
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('refuses a rotation submitted after the set lost a member, writing nothing', async () => {
    seedSet(MEMBERS);
    const { intakeId } = await startSecretIntake({ ...rotation, caller: { kind: 'host' } });
    h.vault.delete(MEMBERS[1]);
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();

    expect(h.updateCalls).toEqual([]);
    expect(getSecretIntake(intakeId)?.status).toBe('failed');
    expect(getSecretIntake(intakeId)?.detail).toContain('changed in the vault');
  });

  it('reports a set rotation that fails partway as partly stored, naming what took the new value', async () => {
    seedSet(MEMBERS);
    const { intakeId } = await startSecretIntake({ ...rotation, caller: { kind: 'host' } });
    h.updateFailsFor.add(MEMBERS[1]);
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();

    expect(h.updateCalls.map(({ ref }) => (ref as { name: string }).name)).toEqual([MEMBERS[0]]);
    const edits = h.deliveries.map((d) => JSON.parse(d.args[4] as string)).filter((c) => c.operation === 'edit');
    expect(edits.at(-1)?.text).toContain('only partly stored');
    expect(getSecretIntake(intakeId)?.detail).toContain(`"${MEMBERS[0]}" replaced`);
  });

  it('reports a set rotation whose update got no answer as unknown, naming what took the new value', async () => {
    seedSet(MEMBERS);
    const { intakeId } = await startSecretIntake({ ...rotation, caller: { kind: 'host' } });
    h.updateLosesAnswerFor.add(MEMBERS[1]);
    await submitValue(intakeId, 'UOWNER', SECRET);
    await settle();

    const edits = h.deliveries.map((d) => JSON.parse(d.args[4] as string)).filter((c) => c.operation === 'edit');
    expect(edits.at(-1)?.text).toContain('in an unknown state');
    expect(getSecretIntake(intakeId)?.detail).toContain(`"${MEMBERS[0]}" took the new value`);
    expect(getSecretIntake(intakeId)?.detail).toContain(`"${MEMBERS[1]}" got no answer`);
    expect(h.updateCalls.map(({ ref }) => (ref as { name: string }).name)).toEqual([MEMBERS[0]]);
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('rotates a set through a declared field id', async () => {
    seedSet(MEMBERS);
    const { intakeId } = await startSecretIntake({
      ...rotation,
      fields: ['api_key|API key'],
      caller: { kind: 'host' },
    });
    expect(await hooks.submit(intakeId, 'UOWNER', { api_key: SECRET })).toEqual({ ok: true });
    await settle();

    expect(h.updateCalls).toHaveLength(3);
  });

  it.each([
    ['rotate', true],
    ['create', false],
  ])('refuses to %s one member of a set on its own', async (_name, rotate) => {
    seedSet(MEMBERS);
    await expect(
      startSecretIntake({
        ...setKey,
        name: MEMBERS[0],
        rotate,
        hostPattern: rotate ? undefined : HOSTS[0],
        caller: agentCaller,
      }),
    ).rejects.toThrow(/belongs to the host set "Example-Cloud"/);
    expect(h.deliveries).toEqual([]);
  });

  it.each([
    ['a member missing', [MEMBERS[0], MEMBERS[2]]],
    ['a member of another size beside it', [...MEMBERS, 'Example-Cloud-1of2']],
    ['a plain secret of the same name beside it', [...MEMBERS, 'Example-Cloud']],
  ])('refuses to rotate a set with %s', async (_name, names) => {
    for (const name of names) h.vault.set(name, { id: `id-${name}`, name });
    await expect(startSecretIntake({ ...rotation, caller: { kind: 'host' } })).rejects.toThrow(/incomplete/);
    expect(h.deliveries).toEqual([]);
  });

  it.each([
    [
      'a set over a plain secret of that name',
      () => h.vault.set('Example-Cloud', { id: 'x', name: 'Example-Cloud' }),
      setKey.hostPattern,
      /already exists in the vault as one secret/,
    ],
    ['a set over an existing set', () => seedSet(MEMBERS), setKey.hostPattern, /already in the vault as/],
    ['one secret over an existing set', () => seedSet(MEMBERS), HOSTS[0], /already in the vault as/],
    [
      'five hosts',
      () => undefined,
      ['a.example.com', 'b.example.com', 'c.example.com', 'd.example.com', 'e.example.com'],
      /At most 4/,
    ],
    ['a host named twice', () => undefined, [HOSTS[0], HOSTS[0].toUpperCase()], /named twice/],
    [
      'a host format without {value}',
      () => undefined,
      [`${HOSTS[0]}=Token`, HOSTS[1]],
      /must be one line of plain text containing \{value\}/,
    ],
    ['several hosts with --field', () => undefined, HOSTS, /drop --field/],
    ['--compose basic over an existing set', () => seedSet(MEMBERS), HOSTS[0], /is a host set/],
  ])('refuses %s', async (name, seed, hostPattern, reason) => {
    seed();
    const fields =
      name === 'several hosts with --field'
        ? ['api_key|API key']
        : name === '--compose basic over an existing set'
          ? ['user|User', 'pass|Password']
          : undefined;
    const compose = name === '--compose basic over an existing set' ? 'basic' : undefined;
    await expect(startSecretIntake({ ...setKey, hostPattern, fields, compose, caller: agentCaller })).rejects.toThrow(
      reason,
    );
    expect(h.deliveries).toEqual([]);
  });
});

describe('client credentials for the host store', () => {
  const card = {
    clientCredentials: 'looker-example',
    rotate: false,
    groups: [] as string[],
    workgroups: [] as string[],
    caller: { kind: 'host' as const },
  };
  const pair = { client_id: 'id-new', client_secret: SECRET };
  const body = () => JSON.parse(h.deliveries[0].args[4] as string).body as string;
  const lastEdit = () =>
    h.deliveries
      .map((d) => JSON.parse(d.args[4] as string))
      .filter((c) => c.operation === 'edit')
      .at(-1)?.text as string;

  it('posts an owner-only card naming the host store and the host, with one input per part', async () => {
    const { intakeId } = await startSecretIntake(card);

    expect(h.deliveries[0].args[1]).toBe('slack:D1');
    expect(body()).toContain('Kept on this host (0600), not in the vault');
    expect(body()).toContain('looker.example.com');
    expect(body()).toContain('Only an owner or global admin can enter it.');
    const opened = await hooks.open(intakeId, 'UOWNER');
    expect(opened.ok && opened.form.inputs.map((i) => i.id)).toEqual(['client_id', 'client_secret']);
  });

  it("goes to an owner on the integration's own workgroup, not an earlier owner's other workspace", async () => {
    h.ownerIds = ['slack-other:UOWNER', 'slack-mine:UOWNER'];
    h.workgroupTypes.set('wg-a', ['slack-mine']);
    vi.mocked(pickApprovalDelivery).mockClear();

    await startSecretIntake(card);

    expect(vi.mocked(pickApprovalDelivery).mock.calls.at(-1)?.[0]).toEqual(['slack-mine:UOWNER']);
  });

  it("is refused when the integration's workgroup has no surface that opens a form", async () => {
    h.ownerIds = ['slack-other:UOWNER'];
    h.workgroupTypes.set('wg-a', ['cli']);

    await expect(startSecretIntake(card)).rejects.toThrow(/surface of workgroup "wg-a"/);
    expect(h.deliveries).toEqual([]);
  });

  it('re-keys the integration with the pair, touching neither the vault nor any grant, and shows no value', async () => {
    const { intakeId } = await startSecretIntake(card);
    expect(await hooks.submit(intakeId, 'UOWNER', pair)).toEqual({ ok: true });
    await settle();

    expect(h.rekeyCalls).toEqual([['looker-example', { clientId: 'id-new', clientSecret: SECRET }]]);
    expect([h.createCalls, h.updateCalls, h.groupGrants, h.workgroupGrants]).toEqual([[], [], [], []]);
    expect(getSecretIntake(intakeId)?.status).toBe('stored');
    expect(lastEdit()).toContain('Stored the new pair on this host');
    expect(everythingObservable()).not.toContain(SECRET);
    expect(JSON.stringify(getSecretIntake(intakeId))).not.toContain(SECRET);
  });

  it('stores nothing for anyone but an owner or global admin, and stays open', async () => {
    const { intakeId } = await startSecretIntake(card);
    await hooks.submit(intakeId, 'UADMIN1', pair);
    await settle();

    expect(h.rekeyCalls).toEqual([]);
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
  });

  it('needs both parts, keeping the card open', async () => {
    const { intakeId } = await startSecretIntake(card);
    expect(await hooks.submit(intakeId, 'UOWNER', { client_id: 'id-new', client_secret: '' })).toMatchObject({
      ok: false,
    });
    expect(h.rekeyCalls).toEqual([]);
    expect(getSecretIntake(intakeId)?.status).toBe('pending');
  });

  it.each([
    [404, 'refused the pair', 'keeps its current pair'],
    [400, 'refused the pair', 'keeps its current pair'],
    [503, 'gave no usable answer', 'post a new card'],
    [429, 'gave no usable answer', 'post a new card'],
  ])('says nothing was stored when the token endpoint answers %i', async (status, what, next) => {
    h.rekeyError = new OAuthTokenError(`http_${status}`, status);
    const { intakeId } = await startSecretIntake(card);
    await hooks.submit(intakeId, 'UOWNER', pair);
    await settle();

    expect(getSecretIntake(intakeId)?.status).toBe('failed');
    expect(lastEdit()).toContain('NOT stored');
    expect(lastEdit()).toContain(what);
    expect(lastEdit()).toContain(next);
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('re-keys only the integration the card showed, and says nothing was stored when it changed', async () => {
    const { intakeId } = await startSecretIntake(card);
    h.rekeyError = new IntegrationChangedError('"looker-example" now serves other.example.com for group ag-2');
    await hooks.submit(intakeId, 'UOWNER', pair);
    await settle();

    expect(h.rekeyExpected).toEqual([{ host: 'looker.example.com', agentGroupId: 'ag-1' }]);
    expect(lastEdit()).toContain('NOT stored');
    expect(lastEdit()).toContain('changed since this card was posted');
    expect(lastEdit()).not.toContain('other.example.com');
    expect(lastEdit()).not.toContain('in an unknown state');
  });

  it("is refused when the integration's agent group no longer exists", async () => {
    h.groups.delete('ag-1');
    await expect(startSecretIntake(card)).rejects.toThrow(/no longer exists/);
    expect(h.deliveries).toEqual([]);
  });

  it('says the pair goes to the host store, never the vault, and lists no vault secret', async () => {
    const { intakeId } = await startSecretIntake(card);
    expect(body()).toContain('The pair goes straight to the host store');
    expect(body()).not.toContain('to the vault —');
    expect(getSecretIntake(intakeId)).toMatchObject({ secrets: [], clientCredentials: 'looker-example' });
  });

  it('leaves a pending vault intake of the same name alone, and is left alone by one', async () => {
    h.vault.set('looker-example', { id: 'id-1', name: 'looker-example' });
    const vault = await startSecretIntake({
      name: 'looker-example',
      rotate: true,
      groups: [],
      workgroups: [],
      caller: { kind: 'host' },
    });
    const hostStore = await startSecretIntake(card);

    expect(getSecretIntake(vault.intakeId)?.status).toBe('pending');
    expect(getSecretIntake(hostStore.intakeId)?.status).toBe('pending');
  });

  it('reports the outcome as unknown when the re-key fails any other way', async () => {
    h.rekeyError = new Error('registry write failed');
    const { intakeId } = await startSecretIntake(card);
    await hooks.submit(intakeId, 'UOWNER', pair);
    await settle();

    expect(lastEdit()).toContain('in an unknown state');
    expect(lastEdit()).not.toContain('NOT stored');
  });

  it('says so when the pair is stored but the vault write is still retrying', async () => {
    h.rekeyResult = { status: 'error', statusDetail: 'gateway unreachable', hostPattern: 'looker.example.com' };
    const { intakeId } = await startSecretIntake(card);
    await hooks.submit(intakeId, 'UOWNER', pair);
    await settle();

    expect(getSecretIntake(intakeId)?.status).toBe('stored');
    expect(lastEdit()).toContain('still retrying: gateway unreachable');
  });

  it.each([
    ['an agent caller', { caller: agentCaller }, /host operator only/],
    ['an integration that does not exist', { clientCredentials: 'dropbox' }, /No integration named/],
    ['an OAuth login integration', { clientCredentials: 'oauth-example' }, /OAuth login integration/],
    ['--name', { name: 'Other' }, /drop --name/],
    ['--rotate', { rotate: true }, /drop --rotate/],
    ['--host-pattern', { hostPattern: 'api.example.com' }, /drop --host-pattern/],
    ['--workgroups', { workgroups: ['wg-a'] }, /drop --workgroups/],
    ['--field', { fields: ['a|A'] }, /drop --field/],
    ['--reserved-for', { reservedFor: 'approved-run-example' }, /drop --reserved-for/],
  ])('refuses %s before posting', async (_name, change, reason) => {
    await expect(startSecretIntake({ ...card, ...change })).rejects.toThrow(reason);
    expect(h.deliveries).toEqual([]);
  });

  it('takes the integration from the CLI flag', async () => {
    const intake = lookup('secrets-intake')!;
    const view = (await intake.handler(intake.parseArgs({ client_credentials: 'looker-example' }), {
      caller: 'host',
    })) as SecretIntakeView;
    expect(view).toMatchObject({ clientCredentials: 'looker-example', secrets: [] });
  });

  it('names the integration in the human intake view', async () => {
    const intake = lookup('secrets-intake')!;
    const view = await intake.handler(intake.parseArgs({ client_credentials: 'looker-example' }), { caller: 'host' });
    expect(intake.formatHuman!(view)).toContain('client-credentials pair of integration "looker-example"');
  });

  it('refuses rather than routes anywhere when the group goes missing after the integration was looked up', async () => {
    const group = h.groups.get('ag-1');
    vi.mocked(getAgentGroup)
      .mockResolvedValueOnce(group as never)
      .mockResolvedValueOnce(undefined);

    await expect(startSecretIntake(card)).rejects.toThrow(/no longer exists/);
    expect(h.deliveries).toEqual([]);
  });
});

describe('grantSecret', () => {
  it('grants an existing secret and refuses one the vault lacks', async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    expect(
      await grantSecret({ name: 'Linear-API-Key', groups: ['ag-2'], workgroups: ['wg-b'], caller: { kind: 'host' } }),
    ).toEqual({
      secretName: 'Linear-API-Key',
      addedGroups: ['ag-2'],
      addedWorkgroups: ['wg-b'],
      alreadyGranted: [],
    });
    await expect(
      grantSecret({ name: 'Nope', groups: ['ag-2'], workgroups: [], caller: { kind: 'host' } }),
    ).rejects.toThrow(/not in the vault/);
    await expect(
      grantSecret({ name: 'Linear-API-Key', groups: [], workgroups: [], caller: { kind: 'host' } }),
    ).rejects.toThrow(/at least one/);
    // A secret an approved-run target reserves to its own agent is never granted to a group or workgroup.
    h.vault.set('approved-run-acme token', { id: 'id-lane', name: 'approved-run-acme token' });
    await expect(
      grantSecret({ name: 'approved-run-acme token', groups: ['ag-3'], workgroups: [], caller: { kind: 'host' } }),
    ).rejects.toThrow(/reserved to OneCLI agent approved-run-acme/);
    expect(h.groupGrants).not.toContain('ag-3:approved-run-acme token');
    // An agent naming no target grants its own workgroup, as intake does.
    expect(
      await grantSecret({ name: 'Linear-API-Key', groups: [], workgroups: [], caller: agentCaller }),
    ).toMatchObject({ addedGroups: [], addedWorkgroups: ['wg-a'] });
  });

  it('holds an agent to its own group and workgroup, as intake does', async () => {
    h.vault.set('Linear-API-Key', { id: 'id-1', name: 'Linear-API-Key' });
    await expect(
      grantSecret({ name: 'Linear-API-Key', groups: [], workgroups: ['wg-b'], caller: agentCaller }),
    ).rejects.toThrow(/only to its own workgroup/);
    await expect(
      grantSecret({ name: 'Linear-API-Key', groups: ['ag-2'], workgroups: [], caller: agentCaller }),
    ).rejects.toThrow(/only to its own group/);
    expect(
      await grantSecret({ name: 'Linear-API-Key', groups: [], workgroups: ['wg-a'], caller: agentCaller }),
    ).toMatchObject({ addedGroups: [], addedWorkgroups: ['wg-a'] });
    expect(h.groupGrants).toEqual([]);
  });
});

describe('reserved lane tokens', () => {
  const AGENT = 'approved-run-example';
  const TOKEN = `${AGENT} token`;
  const laneKey = {
    reservedFor: AGENT,
    rotate: false,
    hostPattern: 'api.example.com',
    pathPattern: '/v1/things/one',
    groups: [] as string[],
    workgroups: [] as string[],
    caller: { kind: 'host' as const },
  };
  const host = { kind: 'host' as const };
  const status = (id: string) => getSecretIntake(id)?.status;
  const wide = { hostWide: true, pathPattern: undefined };
  const ncl = (args: Record<string, unknown>) => {
    const intake = lookup('secrets-intake')!;
    return intake.handler(intake.parseArgs(args), { caller: 'host' }) as Promise<SecretIntakeView>;
  };

  it('refuses an agent caller, whatever it asks, before anything is posted', async () => {
    await expect(startSecretIntake({ ...laneKey, caller: agentCaller })).rejects.toThrow(/host operator only/);
    expect(h.deliveries).toEqual([]);
  });

  it.each([
    ['an agent outside the lane family', { reservedFor: 'example-retail' }, /approved-run-\* OneCLI agent/],
    ['--name', { name: 'Other-Key' }, /drop --name/],
    ['--groups', { groups: ['ag-1'] }, /drop --groups/],
    ['--workgroups', { workgroups: ['wg-a'] }, /drop --workgroups/],
    ['--field', { fields: ['value|Value'] }, /drop --field/],
    ['--compose', { compose: 'basic' }, /drop --compose/],
    ['--compose basic with one field', { compose: 'basic', fields: ['a|A'] }, /drop --field, --compose/],
    ['--compose separate', { compose: 'separate', fields: ['a|A|X-A', 'b|B|X-B'] }, /drop --field, --compose/],
    ['--compose basic with an optional field', { compose: 'basic', fields: ['a|A', 'b?|B'] }, /two required fields/],
    ['no path', { pathPattern: undefined }, /one exact path/],
    ['a wildcard path', { pathPattern: '/v1/things/*' }, /one exact path/],
    ['--host-wide without --reserved-for', { reservedFor: undefined, name: 'Other-Key', ...wide }, /--reserved-for/],
    ['--host-wide from an agent', { ...wide, caller: agentCaller }, /host operator only/],
    ['--host-wide with --name', { ...wide, name: 'Other-Key' }, /drop --name/],
    ['--host-wide with --path-pattern', { hostWide: true }, /not both/],
    ['--host-wide with an empty --path-pattern', { hostWide: true, pathPattern: '' }, /not both/],
    ['--host-wide with --rotate', { ...wide, rotate: true, hostPattern: undefined }, /drop --host-wide/],
    ['--host-wide with no host', { ...wide, hostPattern: undefined }, /one exact host/],
    ['--host-wide with a wildcard host', { ...wide, hostPattern: '*.example.com' }, /one exact host/],
    ['two hosts', { hostPattern: ['api.example.com', 'api2.example.com'] }, /takes one --host-pattern/],
  ])('refuses %s', async (_name, change, reason) => {
    await expect(startSecretIntake({ ...laneKey, ...change })).rejects.toThrow(reason);
    expect(h.deliveries).toEqual([]);
  });

  it('names the token by its agent, says on the card that only that agent gets it, and lets only an owner enter it', async () => {
    const v = await startSecretIntake(laneKey);
    expect(v).toMatchObject({ secretName: TOKEN, reservedFor: AGENT, groups: [], workgroups: [] });
    const card = JSON.parse(h.deliveries[0].args[4] as string) as { body: string };
    expect(card.body).toContain(`Attached only to OneCLI agent ${AGENT}`);
    expect(card.body).toContain('Only an owner or global admin can enter it.');
    expect((await hooks.open(v.intakeId, 'UOWNER')) as { form: { inputs: unknown[] } }).toMatchObject({
      form: { inputs: [{ label: `Key for ${AGENT}` }] },
    });
    await submitValue(v.intakeId, 'UADMIN1', SECRET);
    await settle();
    expect(h.createCalls).toEqual([]);
    expect(status(v.intakeId)).toBe('pending');
  });

  it('stores the token, attaches it to its agent alone, and only then reports it stored', async () => {
    const v = await startSecretIntake(laneKey);
    await submitValue(v.intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.createCalls).toEqual([
      {
        spec: {
          name: TOKEN,
          hostPattern: 'api.example.com',
          pathPattern: '/v1/things/one',
          headerName: 'Authorization',
          valueFormat: 'Bearer {value}',
        },
        value: SECRET,
      },
    ]);
    expect(h.lane.ensured).toEqual([AGENT]);
    expect(h.lane.granted).toEqual([`${AGENT}:id-${TOKEN}`]);
    expect(status(v.intakeId)).toBe('stored');
    expect([h.groupGrants, h.workgroupGrants]).toEqual([[], []]);
    expect(everythingObservable()).not.toContain(SECRET);
  });

  describe('as an HTTP Basic pair', () => {
    const CLIENT = 'client-SENTINEL-51c2';
    const pair = { compose: 'basic', fields: ['client_id|Client ID', 'client_secret|Client secret'] };
    const BASIC = Buffer.from(`${CLIENT}:${SECRET}`).toString('base64');

    it('asks for both parts and stores them joined as the lane token, attached to its agent alone', async () => {
      const v = await startSecretIntake({ ...laneKey, ...pair });
      expect((await hooks.open(v.intakeId, 'UOWNER')) as { form: { inputs: unknown[] } }).toMatchObject({
        form: { inputs: [{ label: 'Client ID' }, { label: 'Client secret' }] },
      });
      await hooks.submit(v.intakeId, 'UOWNER', { client_id: CLIENT, client_secret: SECRET });
      await settle();
      expect(h.createCalls).toEqual([
        {
          spec: {
            name: TOKEN,
            hostPattern: 'api.example.com',
            pathPattern: '/v1/things/one',
            headerName: 'Authorization',
            valueFormat: 'Basic {value}',
          },
          value: BASIC,
        },
      ]);
      expect(h.lane.granted).toEqual([`${AGENT}:id-${TOKEN}`]);
      expect(status(v.intakeId)).toBe('stored');
      expect(everythingObservable()).not.toContain(SECRET);
    });

    it('rotates both parts by value only', async () => {
      h.vault.set(TOKEN, { id: `id-${TOKEN}`, name: TOKEN });
      h.lane.granted.push(`${AGENT}:id-${TOKEN}`);
      const v = await startSecretIntake({
        reservedFor: AGENT,
        rotate: true,
        groups: [],
        workgroups: [],
        caller: host,
        ...pair,
      });
      await hooks.submit(v.intakeId, 'UOWNER', { client_id: CLIENT, client_secret: SECRET });
      await settle();
      expect(h.updateCalls).toEqual([{ ref: { id: `id-${TOKEN}`, name: TOKEN }, value: BASIC }]);
      expect(status(v.intakeId)).toBe('stored');
    });
  });

  it('stores a --host-wide token with no path rule, and says so on the card and the form before anyone enters it', async () => {
    const v = await ncl({ 'reserved-for': AGENT, 'host-pattern': 'api.example.com', 'host-wide': true });
    const card = JSON.parse(h.deliveries[0].args[4] as string) as { body: string };
    expect(card.body).toContain('Sent only to api.example.com (every path on that host), as header');
    expect((await hooks.open(v.intakeId, 'UOWNER')) as { form: { body: string } }).toMatchObject({
      form: { body: expect.stringContaining('every path on that host') },
    });
    await submitValue(v.intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.createCalls).toEqual([
      {
        spec: {
          name: TOKEN,
          hostPattern: 'api.example.com',
          pathPattern: null,
          headerName: 'Authorization',
          valueFormat: 'Bearer {value}',
        },
        value: SECRET,
      },
    ]);
    expect(h.lane.granted).toEqual([`${AGENT}:id-${TOKEN}`]);
    expect(status(v.intakeId)).toBe('stored');
  });

  it('keeps the exact-path rule unless --host-wide is asked for by name', async () => {
    await expect(
      ncl({ 'reserved-for': AGENT, 'host-pattern': 'api.example.com', 'host-wide': 'false' }),
    ).rejects.toThrow(/one exact path/);
    await ncl({ 'reserved-for': AGENT, 'host-pattern': 'api.example.com', 'path-pattern': '/v1/things/one' });
    const card = JSON.parse(h.deliveries[0].args[4] as string) as { body: string };
    expect(card.body).toContain('Sent only to api.example.com (path /v1/things/one), as header');
  });

  it('leaves the card of an ordinary secret with no path as it was', async () => {
    await startSecretIntake({ ...newKey, caller: host });
    const card = JSON.parse(h.deliveries[0].args[4] as string) as { body: string };
    expect(card.body).toContain('Sent only to api.linear.app, as header');
  });

  it.each([
    ['another agent can also be injected it', () => (h.lane.others = ['ag-agent']), /also granted to ag-agent/],
    ['the attach fails', () => (h.lane.grantFails = true), /grant failed/],
  ])('removes a new token and reports it failed, never stored, when %s', async (_name, arrange, reason) => {
    arrange();
    const v = await startSecretIntake(laneKey);
    await submitValue(v.intakeId, 'UOWNER', SECRET);
    await settle();
    expect(status(v.intakeId)).toBe('failed');
    expect(getSecretIntake(v.intakeId)?.detail).toMatch(reason);
    expect(h.deletes).toEqual([`id-${TOKEN}`]);
    expect(h.vault.has(TOKEN)).toBe(false);
  });

  it('says to delete the token by hand when removing it after a failed attach also fails', async () => {
    h.lane.grantFails = true;
    h.deleteFails = true;
    const v = await startSecretIntake(laneKey);
    await submitValue(v.intakeId, 'UOWNER', SECRET);
    await settle();
    expect(status(v.intakeId)).toBe('failed');
    expect(getSecretIntake(v.intakeId)?.detail).toMatch(/removing it also failed .*delete it by hand/);
  });

  it('rotates the token by value only, keeping its host and path, and checks its holder again', async () => {
    h.vault.set(TOKEN, { id: `id-${TOKEN}`, name: TOKEN });
    h.lane.granted.push(`${AGENT}:id-${TOKEN}`);
    await expect(startSecretIntake({ ...laneKey, rotate: true })).rejects.toThrow(/replaces only the value/);
    const v = await startSecretIntake({ reservedFor: AGENT, rotate: true, groups: [], workgroups: [], caller: host });
    await submitValue(v.intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.updateCalls).toEqual([{ ref: { id: `id-${TOKEN}`, name: TOKEN }, value: SECRET }]);
    expect(h.createCalls).toEqual([]);
    expect(status(v.intakeId)).toBe('stored');
  });

  it.each([
    ['another agent can already be injected it', () => (h.lane.others = ['ag-agent']), /also granted to ag-agent/],
    [
      'the vault holds two entries by its name',
      () => h.extraCopies.push({ id: 'id-copy', name: TOKEN }),
      /2 vault entries are named/,
    ],
  ])('refuses a rotation without writing the new value when %s', async (_name, arrange, reason) => {
    h.vault.set(TOKEN, { id: `id-${TOKEN}`, name: TOKEN });
    h.lane.granted.push(`${AGENT}:id-${TOKEN}`);
    arrange();
    const v = await startSecretIntake({ reservedFor: AGENT, rotate: true, groups: [], workgroups: [], caller: host });
    await submitValue(v.intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.updateCalls).toEqual([]);
    expect(status(v.intakeId)).toBe('failed');
    expect(getSecretIntake(v.intakeId)?.detail).toMatch(reason);
  });

  it('makes a Connect write wait for an intake write of the same token already in flight', async () => {
    const v = await startSecretIntake(laneKey);
    let open!: () => void;
    h.lookupGate = new Promise((resolve) => (open = resolve));
    const spec = {
      name: TOKEN,
      hostPattern: 'api.example.com',
      pathPattern: '/v1/things/one',
      headerName: 'Authorization',
      valueFormat: 'Bearer {value}',
    };
    const submitted = submitValue(v.intakeId, 'UOWNER', SECRET);
    await vi.waitFor(() => expect(h.lookups).toBe(1));
    const elsewhere = putReservedToken(AGENT, spec, 'written-elsewhere');
    await settle();
    expect(h.lookups).toBe(1);
    open();
    await Promise.all([submitted, elsewhere]);
    await settle();

    expect(h.createCalls.map((call) => call.value)).toEqual([SECRET]);
    expect(h.updateCalls.map((call) => call.value)).toEqual(['written-elsewhere']);
  });

  it('refuses a new token whose name reached the vault after the card was posted', async () => {
    const v = await startSecretIntake(laneKey);
    h.vault.set(TOKEN, { id: 'id-by-hand', name: TOKEN });
    await submitValue(v.intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.createCalls).toEqual([]);
    expect(status(v.intakeId)).toBe('failed');
  });

  it('removes a token the vault kept when the answer to its create was lost', async () => {
    h.createLosesAnswer = true;
    const v = await startSecretIntake(laneKey);
    await submitValue(v.intakeId, 'UOWNER', SECRET);
    await settle();
    expect(status(v.intakeId)).toBe('failed');
    expect(h.deletes).toEqual([`id-${TOKEN}`]);
    expect(h.lane.granted).toEqual([]);
  });

  it('says a copy may remain, never "NOT stored", when the create answer is lost and the vault cannot be checked', async () => {
    h.createLosesAnswer = true;
    const v = await startSecretIntake(laneKey);
    h.lookupFails = true;
    await submitValue(v.intakeId, 'UOWNER', SECRET);
    await settle();
    expect(status(v.intakeId)).toBe('failed');
    expect(getSecretIntake(v.intakeId)?.detail).toMatch(/may have kept it, and checking failed .*delete it by hand/);
    expect(JSON.stringify(h.deliveries)).not.toContain('NOT stored');
  });

  it('asks for --name or --reserved-for when neither is given', async () => {
    await expect(startSecretIntake({ ...newKey, name: undefined, caller: host })).rejects.toThrow(
      /Name the secret with --name, or a lane agent with --reserved-for/,
    );
  });

  it('keeps a plain --name intake from creating a lane token by name', async () => {
    await expect(startSecretIntake({ ...newKey, name: TOKEN, caller: host })).rejects.toThrow(/Secret names are/);
    await expect(
      startSecretIntake({ ...newKey, name: 'approved-run-example', fields: ['token|T|X-A', 'b|B|X-B'], caller: host }),
    ).resolves.toMatchObject({ secrets: ['approved-run-example-token', 'approved-run-example-b'] });
  });

  it('reports a rotation partly stored when a stray holder appears between its checks', async () => {
    h.vault.set(TOKEN, { id: `id-${TOKEN}`, name: TOKEN });
    h.lane.granted.push(`${AGENT}:id-${TOKEN}`);
    h.lane.othersAfterWrite = true;
    const v = await startSecretIntake({ reservedFor: AGENT, rotate: true, groups: [], workgroups: [], caller: host });
    await submitValue(v.intakeId, 'UOWNER', SECRET);
    await settle();
    expect(h.updateCalls).toHaveLength(1);
    expect(status(v.intakeId)).toBe('failed');
    expect(getSecretIntake(v.intakeId)?.detail).toMatch(/new value is stored, but .*ag-agent/);
  });
});

describe('a lane token entered by a named user', () => {
  const AGENT = 'approved-run-example';
  const NAMED = 'slack:UADMIN1';
  const laneKey = {
    reservedFor: AGENT,
    enteredBy: NAMED,
    rotate: false,
    hostPattern: 'api.example.com',
    pathPattern: '/v1/things/one',
    groups: [] as string[],
    workgroups: [] as string[],
    caller: { kind: 'host' as const },
  };
  const status = (id: string) => getSecretIntake(id)?.status;

  beforeEach(() => {
    h.laneTargets = [{ agentGroups: ['ag-1', 'ag-2'] }];
  });

  it.each([
    ['from an agent', { caller: agentCaller }, /host operator only/],
    ['without --reserved-for', { reservedFor: undefined, name: 'Other-Key' }, /--entered-by goes with --reserved-for/],
    ['a user the host does not know', { enteredBy: 'slack:UNOBODY' }, /no known user/],
    ['a user who administers none of the lane targets’ agent groups', { enteredBy: 'slack:USTRANGER' }, /not an admin/],
    ['an owner, who can already enter it', { enteredBy: 'slack:UOWNER' }, /drop --entered-by/],
  ])('refuses %s before anything is posted', async (_name, change, reason) => {
    h.unknownUsers.add('slack:UNOBODY');
    await expect(startSecretIntake({ ...laneKey, ...change })).rejects.toThrow(reason);
    expect(h.deliveries).toEqual([]);
  });

  it('refuses when no target runs as the agent, so nothing can qualify the user', async () => {
    h.laneTargets = [];
    await expect(startSecretIntake(laneKey)).rejects.toThrow(/No approved-run target runs as/);
    expect(h.deliveries).toEqual([]);
  });

  it('fails when the named user has no reachable DM, and posts nowhere else', async () => {
    h.noDm.add(NAMED);
    await expect(startSecretIntake(laneKey)).rejects.toThrow(/no reachable Slack or Discord DM/);
    expect(h.deliveries).toEqual([]);
  });

  it('posts the card to the named user, who may store it, and only then is it attached and stored', async () => {
    const v = await startSecretIntake(laneKey);
    expect(v.deliveredTo).toBe(NAMED);
    const card = JSON.parse(h.deliveries[0].args[4] as string) as { body: string };
    expect(card.body).toContain('You, an owner or a global admin can enter it.');
    await submitValue(v.intakeId, 'UADMIN1', SECRET);
    await settle();
    expect(h.lane.granted).toEqual([`${AGENT}:id-${AGENT} token`]);
    expect(status(v.intakeId)).toBe('stored');
    const notice = h.deliveries.map((d) => d.args[4] as string).find((c) => c.includes('stored secret'));
    expect(notice).toContain(`name-of-${NAMED} stored secret`);
    expect(notice).toContain('approved-run lane');
    expect(vi.mocked(pickApprovalDelivery)).toHaveBeenLastCalledWith(['slack:UOWNER'], '');
    expect(everythingObservable()).not.toContain(SECRET);
  });

  it('refuses a scoped admin of the qualifying agent group who is not the named user', async () => {
    h.groupAdmins.add('slack:UADMIN2|ag-1');
    try {
      const v = await startSecretIntake(laneKey);
      await submitValue(v.intakeId, 'UADMIN2', SECRET);
      await settle();
      expect(h.createCalls).toEqual([]);
      expect(status(v.intakeId)).toBe('pending');
    } finally {
      h.groupAdmins.delete('slack:UADMIN2|ag-1');
    }
  });

  it('admits the named user for that intake only, not for another lane token', async () => {
    await startSecretIntake(laneKey);
    const other = await startSecretIntake({ ...laneKey, reservedFor: 'approved-run-other', enteredBy: undefined });
    await submitValue(other.intakeId, 'UADMIN1', SECRET);
    await settle();
    expect(h.createCalls).toEqual([]);
    expect(status(other.intakeId)).toBe('pending');
  });

  it('refuses the named user once they no longer administer the group that qualified them', async () => {
    const v = await startSecretIntake(laneKey);
    h.groupAdmins.delete('slack:UADMIN1|ag-1');
    try {
      await submitValue(v.intakeId, 'UADMIN1', SECRET);
      await settle();
      expect(h.createCalls).toEqual([]);
      expect(status(v.intakeId)).toBe('pending');
    } finally {
      h.groupAdmins.add('slack:UADMIN1|ag-1');
    }
  });

  it('lets the named user rotate the token', async () => {
    h.vault.set(`${AGENT} token`, { id: `id-${AGENT} token`, name: `${AGENT} token` });
    h.lane.granted.push(`${AGENT}:id-${AGENT} token`);
    const v = await startSecretIntake({
      ...laneKey,
      rotate: true,
      hostPattern: undefined,
      pathPattern: undefined,
    });
    expect(v.deliveredTo).toBe(NAMED);
    await submitValue(v.intakeId, 'UADMIN1', SECRET);
    await settle();
    expect(h.updateCalls).toHaveLength(1);
    expect(status(v.intakeId)).toBe('stored');
    expect(h.deliveries.some((d) => (d.args[4] as string).includes(`name-of-${NAMED} rotated secret`))).toBe(true);
    expect(vi.mocked(pickApprovalDelivery)).toHaveBeenLastCalledWith(['slack:UOWNER'], '');
  });

  it("still tells an owner when the named user's rotation lands but its holder check then fails", async () => {
    h.vault.set(`${AGENT} token`, { id: `id-${AGENT} token`, name: `${AGENT} token` });
    h.lane.granted.push(`${AGENT}:id-${AGENT} token`);
    h.lane.othersAfterWrite = true;
    const v = await startSecretIntake({ ...laneKey, rotate: true, hostPattern: undefined, pathPattern: undefined });
    await submitValue(v.intakeId, 'UADMIN1', SECRET);
    await settle();
    expect(status(v.intakeId)).toBe('failed');
    const notice = h.deliveries.map((d) => d.args[4] as string).find((c) => c.includes('rotated secret'));
    expect(notice).toContain('It did not finish');
    expect(vi.mocked(pickApprovalDelivery)).toHaveBeenLastCalledWith(['slack:UOWNER'], '');
  });

  it('takes the user from the CLI flag', async () => {
    const intake = lookup('secrets-intake')!;
    const v = (await intake.handler(
      intake.parseArgs({
        'reserved-for': AGENT,
        'entered-by': NAMED,
        'host-pattern': 'api.example.com',
        'path-pattern': '/v1/things/one',
      }),
      { caller: 'host' },
    )) as SecretIntakeView;
    expect(v.deliveredTo).toBe(NAMED);
  });
});
