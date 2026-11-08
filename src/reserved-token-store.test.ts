import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  vault: [] as Array<{ id: string; name: string; value: string }>,
  grants: [] as string[],
  writes: [] as string[],
}));

vi.mock('./onecli-secret-writer.js', () => ({
  findOnecliSecretByName: async (name: string) => h.vault.find((s) => s.name === name),
  findOnecliSecretsByName: async (name: string) => h.vault.filter((s) => s.name === name),
  createOnecliSecret: async (spec: { name: string }, value: string) => {
    h.writes.push(`create ${spec.name}`);
    const ref = { id: `id-${h.vault.length + 1}`, name: spec.name };
    h.vault.push({ ...ref, value });
    return ref;
  },
  updateOnecliSecretValue: async (ref: { id: string }, value: string, match?: { pathPattern?: string | null }) => {
    h.writes.push(match ? `update ${ref.id} at ${match.pathPattern}` : `update ${ref.id}`);
    h.vault.find((s) => s.id === ref.id)!.value = value;
  },
  deleteOnecliSecret: async (id: string) => {
    h.writes.push(`delete ${id}`);
    h.vault = h.vault.filter((s) => s.id !== id);
  },
}));
vi.mock('./onecli-secrets.js', () => ({
  ensureOnecliAgent: async (input: object) => ({ ...input, created: true }),
  grantOnecliSecretToAgent: async (agent: string, ref: { id: string }) => void h.grants.push(`${agent}:${ref.id}`),
  agentsHoldingSecret: async (name: string) => {
    const ids = h.vault.filter((s) => s.name === name).map((s) => s.id);
    const holders = h.grants.filter((g) => ids.some((id) => g.endsWith(`:${id}`))).map((g) => g.split(':')[0]);
    return holders;
  },
}));

const { putReservedToken } = await import('./reserved-token-store.js');

const AGENT = 'approved-run-example-person';
const injection = {
  name: `${AGENT} token`,
  hostPattern: 'api.example.com',
  pathPattern: '/v1/post',
  headerName: 'Authorization',
  valueFormat: 'Bearer {value}',
};

beforeEach(() => {
  h.vault = [];
  h.grants = [];
  h.writes = [];
});

describe('putReservedToken', () => {
  it('creates the token for its agent alone the first time, then replaces only its value', async () => {
    await putReservedToken(AGENT, injection, 'first-value');
    await putReservedToken(AGENT, injection, 'second-value');

    expect(h.vault).toEqual([{ id: 'id-1', name: `${AGENT} token`, value: 'second-value' }]);
    expect(h.grants).toEqual([`${AGENT}:id-1`]);
    expect(h.writes).toEqual([`create ${AGENT} token`, 'update id-1 at /v1/post']);
  });

  it('moves a token already in the vault to the path its agent now injects it on', async () => {
    h.vault = [{ id: 'id-1', name: `${AGENT} token`, value: 'old' }];
    h.grants = [`${AGENT}:id-1`];

    await putReservedToken(AGENT, { ...injection, pathPattern: '/v1/*' }, 'new-value');

    expect(h.writes).toEqual(['update id-1 at /v1/*']);
  });

  it('writes no token for an agent outside the reserved family, such as an agent group’s identity', async () => {
    await expect(
      putReservedToken('ag-example-group', { ...injection, name: 'ag-example-group token' }, 'v'),
    ).rejects.toThrow('ag-example-group is not a reserved agent');
    expect([h.writes, h.grants]).toEqual([[], []]);
  });

  it('runs two writes for one agent one after the other, so they leave one entry', async () => {
    await Promise.all([
      putReservedToken(AGENT, injection, 'first-value'),
      putReservedToken(AGENT, injection, 'second-value'),
    ]);

    expect(h.vault).toEqual([{ id: 'id-1', name: `${AGENT} token`, value: 'second-value' }]);
    expect(h.writes).toEqual([`create ${AGENT} token`, 'update id-1 at /v1/post']);
  });

  it('writes nothing when the vault holds two entries by the name', async () => {
    h.vault = [
      { id: 'id-a', name: `${AGENT} token`, value: 'a' },
      { id: 'id-b', name: `${AGENT} token`, value: 'b' },
    ];

    await expect(putReservedToken(AGENT, injection, 'new-value')).rejects.toThrow('leave exactly one');
    expect(h.writes).toEqual([]);
  });

  it('refuses a name outside the reservation, even one already in the vault, before writing', async () => {
    h.vault = [{ id: 'id-shared', name: 'Some-Shared-Key', value: 'shared' }];

    await expect(putReservedToken(AGENT, { ...injection, name: 'Some-Shared-Key' }, 'v')).rejects.toThrow(
      "is not approved-run-example-person's token name",
    );
    expect(h.writes).toEqual([]);
  });
});
