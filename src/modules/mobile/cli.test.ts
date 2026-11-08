import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const H = vi.hoisted(() => ({
  latestHuman: null as string | null,
  unclear: false,
  dms: new Map<string, string>(),
}));

vi.mock('../../log.js', () => ({
  setLogScrubber: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn() },
  isSurvivableIoError: vi.fn(() => false),
}));
vi.mock('../../config.js', async (orig) => ({
  ...(await orig<typeof import('../../config.js')>()),
  PREVIEW_ORIGIN_SUFFIX: 'calls.example',
}));
vi.mock('../../caller-identity.js', () => ({
  deriveHumanRequest: async () =>
    H.latestHuman && {
      userId: H.latestHuman,
      route: { channelType: 'slack', platformId: 'slack:C0TEST', threadId: 'slack:C0TEST:1.2' },
    },
  resolveRequester: async () =>
    H.unclear || !H.latestHuman ? { kind: 'unclear', reason: 'unidentified' } : { kind: 'one', userId: H.latestHuman },
}));
vi.mock('../permissions/user-dm.js', () => ({
  ensureUserDm: async (userId: string) => ({ channel_type: 'slack', platform_id: `dm:${userId}`, instance: 'slack' }),
}));
vi.mock('../voice-call/service.js', async (orig) => ({
  ...(await orig<typeof import('../voice-call/service.js')>()),
  deliverText: async (route: { platformId: string }, text: string) => void H.dms.set(route.platformId, text),
}));

const { dispatch } = await import('../../cli/dispatch.js');
await import('../../cli/resources/mobile.js');
const { createAgentGroup, ensureContainerConfig, getDb, initMigratedTestDb } = await import('../../db/index.js');
const { createSession } = await import('../../db/sessions.js');
const { addMember } = await import('../permissions/db/agent-group-members.js');
const { createUser } = await import('../permissions/db/users.js');
const { createDevice, findDeviceBySendKey, issueSendKey } = await import('./devices.js');
const { registerSlackBot, unregisterSlackBot } = await import('../../channels/slack-mentions.js');

const NOW = '2026-10-31T12:00:00.000Z';
const AGENT = { caller: 'agent', sessionId: 'sess-1', agentGroupId: 'ag-1', messagingGroupId: 'mg-1' } as const;
const ALICE = 'slack:U1';
const BOB = 'slack:U2';

const run = (command: string, args: Record<string, unknown> = {}, ctx: Parameters<typeof dispatch>[1] = AGENT) =>
  dispatch({ id: '1', command, args }, ctx);

const remainingDevices = async () =>
  (await getDb().all<{ id: string }>('SELECT id FROM mobile_devices ORDER BY id')).map((d) => d.id);

beforeEach(async () => {
  await initMigratedTestDb();
  await createAgentGroup({ id: 'ag-1', name: 'Juniper', folder: 'juniper', agent_provider: null, created_at: NOW });
  await ensureContainerConfig('ag-1');
  await getDb().run(`UPDATE container_configs SET cli_scope = 'group' WHERE agent_group_id = 'ag-1'`);
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: 'slack:C0TEST:1.2',
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: NOW,
    created_at: NOW,
  });
  for (const id of [ALICE, BOB]) {
    await createUser({ id, kind: 'slack', display_name: id === ALICE ? 'Alice' : 'Bob', created_at: NOW });
    await addMember({ user_id: id, agent_group_id: 'ag-1', added_by: null, added_at: NOW });
  }
  H.latestHuman = ALICE;
});

afterEach(() => {
  H.dms.clear();
  H.unclear = false;
});

describe('ncl mobile pair', () => {
  it('reaches a group-scoped agent through the guard and DMs the person the thread names', async () => {
    const resp = await run('mobile-pair');

    expect(resp).toMatchObject({ ok: true, data: { sentTo: 'Alice', expiresAt: expect.any(String) } });
    expect([...H.dms.keys()]).toEqual([`dm:${ALICE}`]);
    expect(H.dms.get(`dm:${ALICE}`)).toMatch(/https:\/\/app\.calls\.example\/pair#[A-Za-z0-9_-]{43}/);
  });

  it('gives the agent no way to name the person', async () => {
    const resp = await run('mobile-pair', { user: BOB });

    expect(resp).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(H.dms.size).toBe(0);
  });

  it('never shows the agent the code', async () => {
    const resp = await run('mobile-pair');
    const code = /pair#(\S+)/.exec(H.dms.get(`dm:${ALICE}`)!)![1];
    expect(JSON.stringify(resp)).not.toContain(code);
  });

  it('refuses when no person has spoken in the thread', async () => {
    H.latestHuman = null;
    expect(await run('mobile-pair')).toMatchObject({ ok: false, error: { message: /No person has asked/ } });
    expect(H.dms.size).toBe(0);
  });

  it('refuses a person who cannot access this agent group', async () => {
    await getDb().run('DELETE FROM agent_group_members WHERE user_id = ?', ALICE);
    expect(await run('mobile-pair')).toMatchObject({ ok: false, error: { message: /can talk to this agent/ } });
    expect(H.dms.size).toBe(0);
  });

  it('refuses a person on a platform the app does not cover', async () => {
    const id = 'telegram:42';
    await createUser({ id, kind: 'telegram', display_name: 'Carol', created_at: NOW });
    await addMember({ user_id: id, agent_group_id: 'ag-1', added_by: null, added_at: NOW });
    H.latestHuman = id;
    expect(await run('mobile-pair')).toMatchObject({ ok: false, error: { message: /Slack or Discord/ } });
  });

  it('refuses a host caller, which has no thread to take a person from', async () => {
    expect(await run('mobile-pair', {}, { caller: 'host' })).toMatchObject({
      ok: false,
      error: { message: /agent session/ },
    });
  });

  it('is refused for an agent whose CLI is disabled', async () => {
    await getDb().run(`UPDATE container_configs SET cli_scope = 'disabled' WHERE agent_group_id = 'ag-1'`);
    expect(await run('mobile-pair')).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(H.dms.size).toBe(0);
  });
});

describe('ncl mobile devices', () => {
  it('shows an agent only the thread’s person’s devices, a host everyone’s, and neither any key', async () => {
    const alice = await createDevice(ALICE, 'Example Phone');
    const bob = await createDevice(BOB, null);

    const fromAgent = await run('mobile-devices');
    const fromHost = await run('mobile-devices', {}, { caller: 'host' });

    expect(fromAgent).toMatchObject({ ok: true, data: [{ id: alice.deviceId, user_id: ALICE }] });
    expect(fromAgent).toMatchObject({ human: expect.stringContaining('Example Phone') });
    expect(fromHost).toMatchObject({ ok: true });
    expect((fromHost as { data: Array<{ id: string }> }).data.map((d) => d.id).sort()).toEqual(
      [alice.deviceId, bob.deviceId].sort(),
    );
    const [hash] = (await getDb().all<{ key_hash: string }>('SELECT key_hash FROM mobile_devices')).map(
      (d) => d.key_hash,
    );
    for (const secret of [alice.key, bob.key, hash]) {
      expect(JSON.stringify([fromAgent, fromHost])).not.toContain(secret);
    }
  });
});

describe('a person the host cannot pick out', () => {
  it.each(['mobile-devices', 'mobile-revoke'])(
    '%s refuses rather than act for the last person who typed',
    async (cmd) => {
      const { deviceId } = await createDevice(ALICE, 'Example Phone');
      H.unclear = true;

      const resp = await run(cmd, cmd === 'mobile-revoke' ? { id: deviceId } : {});

      expect(resp).toMatchObject({ ok: false, error: { message: /Could not tell who is asking/ } });
      expect(JSON.stringify(resp)).not.toContain('Example Phone');
      expect(await remainingDevices()).toEqual([deviceId]);
    },
  );
});

describe('a device paired through a sibling bot', () => {
  const SIBLING = `slack-sibling:${ALICE.slice('slack:'.length)}`;
  const bots: Array<[string, { userId: string; username: string; teamId: string }]> = [
    ['slack', { userId: 'U-BOT-A', username: 'a', teamId: 'T-MOBILE-TEST' }],
    ['slack-sibling', { userId: 'U-BOT-B', username: 'b', teamId: 'T-MOBILE-TEST' }],
  ];

  beforeEach(async () => {
    for (const [channelType, identity] of bots) registerSlackBot(channelType, identity);
    await createUser({ id: SIBLING, kind: 'slack', display_name: 'Alice', created_at: NOW });
  });
  afterEach(() => {
    for (const [channelType, identity] of bots) unregisterSlackBot(channelType, identity);
  });

  it('can be listed and revoked from the other bot', async () => {
    const { deviceId } = await createDevice(SIBLING, null);
    await createDevice(BOB, null);

    expect(await run('mobile-devices')).toMatchObject({ ok: true, data: [{ id: deviceId }] });
    expect(await run('mobile-revoke', { id: deviceId })).toMatchObject({ ok: true });
    expect(await remainingDevices()).toHaveLength(1);
  });
});

describe('ncl mobile revoke', () => {
  it('lets a group-scoped agent revoke a device of the thread’s person, by flag or positionally', async () => {
    const byFlag = await createDevice(ALICE, null);
    const positional = await createDevice(ALICE, null);

    expect(await run('mobile-revoke', { id: byFlag.deviceId })).toMatchObject({ ok: true });
    expect(await run(`mobile-revoke-${positional.deviceId}`)).toMatchObject({ ok: true });

    expect(await remainingDevices()).toEqual([]);
  });

  it('refuses an agent another person’s device, in the words it uses for no device at all', async () => {
    const bobs = await createDevice(BOB, null);

    const foreign = await run('mobile-revoke', { id: bobs.deviceId });
    const missing = await run('mobile-revoke', { id: 'no-such-device' });

    expect(await remainingDevices()).toEqual([bobs.deviceId]);
    expect(foreign).toMatchObject({ ok: false, error: { code: 'handler-error' } });
    const words = (resp: typeof foreign, id: string) => !resp.ok && resp.error.message.replace(id, '<id>');
    expect(words(foreign, bobs.deviceId)).toBe(words(missing, 'no-such-device'));
  });

  it('takes the device’s send key with it, so that phone can no longer reply', async () => {
    const { deviceId } = await createDevice(ALICE, null);
    const sendKey = (await issueSendKey(deviceId))!;
    const before = await findDeviceBySendKey(sendKey);

    expect(await run('mobile-revoke', { id: deviceId })).toMatchObject({ ok: true });

    expect([before?.id, await findDeviceBySendKey(sendKey)]).toEqual([deviceId, undefined]);
  });

  it('lets the host revoke anyone’s device', async () => {
    const bobs = await createDevice(BOB, null);
    expect(await run('mobile-revoke', { id: bobs.deviceId }, { caller: 'host' })).toMatchObject({ ok: true });
    expect(await remainingDevices()).toEqual([]);
  });

  it('requires an id', async () => {
    expect(await run('mobile-revoke')).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
  });
});
