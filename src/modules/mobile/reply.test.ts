import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, initMigratedTestDb } from '../../db/index.js';
import { createDevice, deleteDevice, findDeviceByKey, findDeviceBySendKey, hasSendKey } from './devices.js';
import { _resetReplyForTest, _setClaimWaitForTest, issueClaim, redeemClaim, sendReply } from './reply.js';
import type { ThreadToRead } from './threads.js';

beforeEach(async () => {
  _resetReplyForTest();
  await initMigratedTestDb();
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
});

async function newDevice() {
  const { key } = await createDevice('slack:U0EXAMPLE1', null);
  return (await findDeviceByKey(key))!;
}

const neverStored = () => new Promise<string | null>(() => undefined);

describe('a claim for a send key', () => {
  // A phone can ask twice for one claim, when the link opens the app again or an answer is lost on the way, so every
  // answer must be the one key the device now holds, never a second key that kills the first.
  it.each([
    ['issued with nothing to wait on', undefined],
    ['waiting on its token', Promise.resolve(null)],
  ])('%s, answers two redemptions at once with the one key the device holds', async (_label, ready) => {
    const device = await newDevice();
    const { claim } = issueClaim(device.id, ready);

    const answers = await Promise.all([redeemClaim(device, claim), redeemClaim(device, claim)]);
    const keys = answers.map((answer) =>
      typeof answer === 'string' || !('sendKey' in answer) ? null : answer.sendKey,
    );

    expect(keys[0]).toBe(keys[1]);
    expect((await findDeviceBySendKey(keys[0]!))?.id).toBe(device.id);
  });

  it('answers the same key again for two minutes after it was claimed, then nothing', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const device = await newDevice();
    const { claim } = issueClaim(device.id, Promise.resolve(null));

    const first = await redeemClaim(device, claim);
    vi.setSystemTime(Date.now() + 2 * 60_000);
    const again = await redeemClaim(device, claim);
    vi.setSystemTime(Date.now() + 1);
    const late = await redeemClaim(device, claim);

    expect(again).toEqual({ ...(first as object), replayed: true });
    expect(late).toBe('expired');
  });

  it('replays no key a later claim has replaced, since it no longer opens anything', async () => {
    const device = await newDevice();
    const first = issueClaim(device.id);
    const second = issueClaim(device.id);

    await redeemClaim(device, first.claim);
    const current = await redeemClaim(device, second.claim);
    const replay = await redeemClaim(device, first.claim);

    expect(replay).toBe('expired');
    expect(await redeemClaim(device, second.claim)).toEqual({ ...(current as object), replayed: true });
  });

  it('keeps a claim redeemed just before its ten minutes for its whole replay, whatever claims come after', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const device = await newDevice();
    const { claim } = issueClaim(device.id);
    vi.setSystemTime(Date.now() + 10 * 60_000 - 1);
    const redeemed = await redeemClaim(device, claim);
    vi.setSystemTime(Date.now() + 60_000);
    issueClaim(device.id);

    expect(await redeemClaim(device, claim)).toEqual({ ...(redeemed as object), replayed: true });
  });

  it('answers another device presenting the claim as unknown, and leaves it to its own device', async () => {
    const device = await newDevice();
    const { key } = await createDevice('slack:U0OTHER1', null);
    const other = (await findDeviceByKey(key))!;
    const { claim } = issueClaim(device.id);

    expect(await redeemClaim(other, claim)).toBe('unknown');
    expect(await redeemClaim(device, claim)).toEqual({ sendKey: expect.any(String) });
  });

  it('answers a claim that lapses while it waits on its token as expired, not still finishing', async () => {
    _setClaimWaitForTest(50);
    vi.useFakeTimers({ toFake: ['Date'] });
    const device = await newDevice();
    const { claim } = issueClaim(device.id, neverStored());

    const redeeming = redeemClaim(device, claim);
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);

    expect(await redeeming).toBe('expired');
  });

  it('tells why a claim whose token failed once, and the claim is spent for a redemption that waited with it', async () => {
    const device = await newDevice();
    const { claim } = issueClaim(device.id, Promise.resolve('Slack refused the sign-in.'));

    const [first, second] = await Promise.all([redeemClaim(device, claim), redeemClaim(device, claim)]);

    expect(first).toEqual({ failed: 'Slack refused the sign-in.' });
    expect(second).toBe('unknown');
    expect(await hasSendKey(device.id)).toBe(false);
  });

  it('forgets a claim that lapsed unredeemed once a newer claim is issued', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const device = await newDevice();
    const lapsed = issueClaim(device.id);
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);
    issueClaim(device.id);

    expect(await redeemClaim(device, lapsed.claim)).toBe('unknown');
  });

  it('drops the redeemed key from memory when its two-minute replay ends, with no one asking again', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] });
    const device = await newDevice();
    const { claim } = issueClaim(device.id);
    expect(await redeemClaim(device, claim)).toEqual({ sendKey: expect.any(String) });

    vi.advanceTimersByTime(2 * 60_000);

    expect(await redeemClaim(device, claim)).toBe('unknown');
  });

  it('issues no key to a device unpaired before its claim is redeemed', async () => {
    const device = await newDevice();
    const { claim } = issueClaim(device.id);
    expect(await deleteDevice(device.id)).toBe(true);

    expect(await redeemClaim(device, claim)).toBe('unknown');
  });

  it('throws when the key cannot be stored, and the claim is spent rather than replayed', async () => {
    const device = await newDevice();
    const { claim } = issueClaim(device.id);
    await closeDb();

    await expect(redeemClaim(device, claim)).rejects.toThrow('Database not initialized');
    expect(await redeemClaim(device, claim)).toBe('unknown');
  });

  it('answers a claim already past its ten minutes without waiting on its token', async () => {
    _setClaimWaitForTest(60_000);
    vi.useFakeTimers({ toFake: ['Date'] });
    const device = await newDevice();
    const { claim } = issueClaim(device.id, neverStored());
    vi.setSystemTime(Date.now() + 10 * 60_000 + 1);

    expect(await redeemClaim(device, claim)).toBe('expired');
  });
});

describe('a post that throws', () => {
  it('may have reached the platform, so its send id never posts again', async () => {
    const device = await newDevice();
    let posts = 0;
    const send = () =>
      sendReply(
        device,
        'send-id-thrown-000001',
        'On it.',
        async () => ({ agents: [] }) as unknown as ThreadToRead,
        async () => ({
          unlock: 'enable',
          post: async () => {
            posts += 1;
            throw new Error('SQLITE_BUSY');
          },
        }),
        () => true,
      );

    const first = await send();
    const again = await send();

    expect(first).toEqual({ outcome: 'unknown', error: expect.stringContaining('may have posted') });
    expect(again).toEqual({ outcome: 'unknown', error: expect.stringContaining('already tried') });
    expect(posts).toBe(1);
  });
});

describe('a send id', () => {
  it('is remembered for an hour after it posted, then may post again', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const device = await newDevice();
    let posts = 0;
    const send = (sendId: string) =>
      sendReply(
        device,
        sendId,
        'On it.',
        async () => ({ agents: [] }) as unknown as ThreadToRead,
        async () => ({
          unlock: 'enable',
          post: async () => {
            posts += 1;
            return { outcome: 'sent' };
          },
        }),
        () => true,
      );

    await send('send-id-hour-000001');
    await send('send-id-hour-000001');
    expect(posts).toBe(1);
    vi.setSystemTime(Date.now() + 60 * 60_000 + 1);
    await send('send-id-hour-000002');
    await send('send-id-hour-000001');

    expect(posts).toBe(3);
  });
});
