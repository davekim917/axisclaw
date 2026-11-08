import { readFileSync } from 'fs';
import { beforeEach, describe, expect, test, vi } from 'vitest';

const onecli = vi.hoisted(() => ({ ensure: vi.fn(), apply: vi.fn() }));

vi.mock('../../onecli-secrets.js', async () => {
  const actual = await vi.importActual<typeof import('../../onecli-secrets.js')>('../../onecli-secrets.js');
  return { ...actual, ensureOnecliAgent: onecli.ensure, applyOnecliSecrets: onecli.apply };
});

const { __setSecretsCacheForTest } = await import('../../onecli-secrets.js');
const { previewProxyEnv } = await import('./preview-identity.js');

const secret = (id: string, name: string, hostPattern: string) => ({
  id,
  name,
  type: 'generic',
  hostPattern,
  pathPattern: null,
});
const stripeTest = secret('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'Stripe-Example-Test', 'api.stripe.com');
const stripeLive = secret('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'Stripe-Example-Live', 'api.stripe.com');
const places = secret('cccccccc-cccc-cccc-cccc-cccccccccccc', 'Places-Example', 'places.googleapis.com');

const getContainerConfig = vi.fn();

function run(declarations: string[] | undefined) {
  return previewProxyEnv({ agentIdentifier: 'example-group', groupName: 'Example', declarations, getContainerConfig });
}

beforeEach(() => {
  __setSecretsCacheForTest([stripeTest, stripeLive, places] as never);
  onecli.ensure.mockReset().mockResolvedValue(undefined);
  onecli.apply.mockReset().mockResolvedValue(undefined);
  getContainerConfig.mockReset().mockResolvedValue({ env: { HTTPS_PROXY: 'http://preview-token@gateway:10255' } });
});

describe('previewProxyEnv', () => {
  test('grants exactly the declared secrets to a separate -preview identity and exports its proxy', async () => {
    expect(await run(['Stripe-Example-Test', 'Places-Example'])).toEqual([
      '-e',
      'PREVIEW_HTTPS_PROXY=http://preview-token@gateway:10255',
    ]);
    expect(onecli.ensure).toHaveBeenCalledWith(expect.objectContaining({ identifier: 'example-group-preview' }));
    expect(onecli.apply).toHaveBeenCalledWith('example-group-preview', ['Stripe-Example-Test', 'Places-Example']);
    expect(getContainerConfig).toHaveBeenCalledWith({ agent: 'example-group-preview' });
  });

  test('a -preview identity in the lane family gets no proxy and no grant', async () => {
    expect(
      await previewProxyEnv({
        agentIdentifier: 'approved-run-acme',
        groupName: 'Lane',
        declarations: ['Places-Example'],
        getContainerConfig,
      }),
    ).toEqual([]);
    expect(onecli.ensure).not.toHaveBeenCalled();
    expect(getContainerConfig).not.toHaveBeenCalled();
  });

  test('nothing declared: no identity, no env', async () => {
    expect(await run(undefined)).toEqual([]);
    expect(await run([])).toEqual([]);
    expect(onecli.ensure).not.toHaveBeenCalled();
  });

  test('two secrets on one host are refused before any grant, so a live key can never ride along', async () => {
    expect(await run(['Stripe-Example-Test', 'Stripe-Example-Live'])).toEqual([]);
    expect(onecli.ensure).not.toHaveBeenCalled();
    expect(onecli.apply).not.toHaveBeenCalled();
  });

  test('one secret named twice, by name and by id, is not a conflict', async () => {
    expect(await run(['Stripe-Example-Test', stripeTest.id])).toHaveLength(2);
  });

  test('a gateway failure leaves backends unproxied instead of failing the spawn', async () => {
    onecli.apply.mockRejectedValue(new Error('unresolvable secret'));
    expect(await run(['Places-Example'])).toEqual([]);
  });

  test('the spawn path exports it from the group config, after the agent gateway applies', () => {
    const source = readFileSync(new URL('../../container-runner.ts', import.meta.url), 'utf-8');
    const applied = source.indexOf("log.info('OneCLI gateway applied'");
    const preview = source.search(/await previewProxyEnv\(\{[^}]*declarations: containerConfig\.previewOnecliSecrets/);
    expect(applied).toBeGreaterThan(-1);
    expect(preview).toBeGreaterThan(applied);
  });
});
