import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  dataDir: '',
  sources: [] as Array<() => void>,
  duties: [] as Array<{ run: () => void }>,
  statuses: {} as Record<string, number | Error>,
  fetch: vi.fn(),
  slots: vi.fn(),
  notifyOwner: vi.fn(async () => ({ code: 0 })),
  logged: [] as unknown[],
}));

vi.mock('undici', () => ({ Agent: class {}, fetch: h.fetch }));
vi.mock('../../config.js', () => ({
  get DATA_DIR() {
    return h.dataDir;
  },
}));
vi.mock('../../env.js', () => ({ readEnvFileMatching: h.slots }));
vi.mock('../../notify-owner.js', () => ({ notifyOwner: h.notifyOwner }));
vi.mock('../../log.js', () => ({
  log: {
    warn: (...args: unknown[]) => h.logged.push(args),
    error: (...args: unknown[]) => h.logged.push(args),
    info: (...args: unknown[]) => h.logged.push(args),
  },
}));
vi.mock('../../host-sweep.js', () => ({
  SWEEP_DUTY_INVENTORY: { FORK11: 'oauth-slot-health' },
  registerSweepDuty: (duty: { run: () => void }) => h.duties.push(duty),
  registerSweepDutySource: (_name: string, register: () => void) => h.sources.push(register),
}));

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const LIVE = 'sk-live-invented-token';
const DEAD = 'sk-dead-invented-token';
const OTHER = 'sk-other-invented-token';

async function spawnHost(): Promise<() => Promise<void>> {
  vi.resetModules();
  h.sources.length = 0;
  h.duties.length = 0;
  await import('./index.js');
  for (const register of h.sources) register();
  const [duty] = h.duties;
  return async () => {
    duty.run();
    await vi.advanceTimersByTimeAsync(1);
  };
}

const probed = () => h.fetch.mock.calls.length;
const titles = () => h.notifyOwner.mock.calls.length;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-30T12:00:00.000Z'));
  h.dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'oauth-slot-health-'));
  h.statuses = { [LIVE]: 200, [DEAD]: 401 };
  h.logged.length = 0;
  h.slots.mockReset();
  h.slots.mockImplementation(() => ({ CLAUDE_CODE_OAUTH_TOKEN: LIVE, CLAUDE_CODE_OAUTH_TOKEN_GROUP_A_5: DEAD }));
  h.notifyOwner.mockClear();
  h.notifyOwner.mockImplementation(async () => ({ code: 0 }));
  h.fetch.mockReset();
  h.fetch.mockImplementation(async (_url: string, init: { headers: Record<string, string> }) => {
    const outcome = h.statuses[init.headers.authorization.replace('Bearer ', '')];
    if (outcome instanceof Error) throw outcome;
    return { status: outcome, body: { cancel: async () => undefined } };
  });
});

afterEach(() => {
  vi.useRealTimers();
  fs.rmSync(h.dataDir, { recursive: true, force: true });
});

describe('the daily OAuth slot check', () => {
  it('names a refused slot to the owner once, across days and host restarts', async () => {
    await (
      await spawnHost()
    )();

    expect(h.notifyOwner).toHaveBeenCalledTimes(1);
    const body = JSON.stringify(h.notifyOwner.mock.calls[0]);
    expect(body).toContain('CLAUDE_CODE_OAUTH_TOKEN_GROUP_A_5');
    expect(body).not.toContain('CLAUDE_CODE_OAUTH_TOKEN"');

    await vi.advanceTimersByTimeAsync(DAY_MS);
    await (
      await spawnHost()
    )();

    expect(probed()).toBe(4);
    expect(titles()).toBe(1);
  });

  it.each([
    ['a 500', 500],
    ['a 503', 503],
    ['a rate limit', 429],
    ['a forbidden answer', 403],
    ['a network failure', new Error('connect ECONNRESET')],
  ])('stays silent on %s', async (_name, outcome) => {
    h.statuses[DEAD] = outcome;

    await (
      await spawnHost()
    )();

    expect(probed()).toBe(2);
    expect(titles()).toBe(0);
  });

  it('keeps a standing alert through an unknown answer, then alerts again after the token recovers and dies', async () => {
    await (
      await spawnHost()
    )();

    for (const outcome of [503, 401, 200, 401]) {
      h.statuses[DEAD] = outcome;
      await vi.advanceTimersByTimeAsync(DAY_MS);
      await (
        await spawnHost()
      )();
    }

    expect(titles()).toBe(2);
  });

  it('runs at most once a day however often the host restarts', async () => {
    await (
      await spawnHost()
    )();

    for (let restart = 0; restart < 6; restart++) {
      await vi.advanceTimersByTimeAsync(3 * HOUR_MS);
      await (
        await spawnHost()
      )();
    }

    expect(probed()).toBe(2);
  });

  it('does not let frequent restarts postpone the check', async () => {
    await (
      await spawnHost()
    )();

    for (let restart = 0; restart < 5; restart++) {
      await vi.advanceTimersByTimeAsync(6 * HOUR_MS);
      await (
        await spawnHost()
      )();
    }

    expect(probed()).toBe(4);
  });

  it('retries an undelivered alert within the hour instead of tomorrow', async () => {
    h.notifyOwner.mockImplementationOnce(async () => ({ code: 1 }));
    const tick = await spawnHost();
    await tick();
    expect(titles()).toBe(1);

    await vi.advanceTimersByTimeAsync(HOUR_MS);
    await tick();

    expect(titles()).toBe(2);
    const state = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'oauth-slot-health.json'), 'utf8'));
    expect(state.alerted).toEqual(['CLAUDE_CODE_OAUTH_TOKEN_GROUP_A_5']);
  });

  it('forgets a slot taken out of .env, and never probes the OneCLI placeholder', async () => {
    await (
      await spawnHost()
    )();

    h.slots.mockImplementation(() => ({ CLAUDE_CODE_OAUTH_TOKEN: 'placeholder', CLAUDE_CODE_OAUTH_TOKEN_2: LIVE }));
    await vi.advanceTimersByTimeAsync(DAY_MS);
    await (
      await spawnHost()
    )();

    expect(probed()).toBe(3);
    const state = JSON.parse(fs.readFileSync(path.join(h.dataDir, 'oauth-slot-health.json'), 'utf8'));
    expect(state.alerted).toEqual([]);
  });

  it('never puts a token value in a log line, an alert or the state file', async () => {
    h.statuses[OTHER] = new Error(`socket hang up on ${OTHER}`);
    h.slots.mockImplementation(() => ({
      CLAUDE_CODE_OAUTH_TOKEN: LIVE,
      CLAUDE_CODE_OAUTH_TOKEN_2: DEAD,
      CLAUDE_CODE_OAUTH_TOKEN_3: OTHER,
    }));

    await (
      await spawnHost()
    )();

    const seen = JSON.stringify([h.logged, h.notifyOwner.mock.calls]);
    const onDisk = fs.readFileSync(path.join(h.dataDir, 'oauth-slot-health.json'), 'utf8');
    expect(h.logged.length).toBeGreaterThan(0);
    for (const token of [LIVE, DEAD, OTHER]) {
      expect(seen).not.toContain(token);
      expect(onDisk).not.toContain(token);
    }
  });

  it('asks the API directly, past any proxy, with the token as its own bearer', async () => {
    await (
      await spawnHost()
    )();

    const [url, init] = h.fetch.mock.calls[0] as [string, { dispatcher?: unknown; headers: Record<string, string> }];
    expect(url).toBe('https://api.anthropic.com/v1/messages/count_tokens');
    expect(init.dispatcher).toBeDefined();
    expect(init.headers.authorization).toBe(`Bearer ${LIVE}`);
  });
});
