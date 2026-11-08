import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { allowSubprocess, enforceHermeticity } from '../../test-hermeticity.js';

const { ROOT, STUB } = vi.hoisted(() => {
  const root = uniqueTmpRoot('test-migrate-relay');
  return { ROOT: root, STUB: `${root}/docker` };
});
vi.mock('../../container-runtime.js', () => ({ CONTAINER_RUNTIME_BIN: STUB }));

const { dbEndpoint, openRelay, RELAY_SCRIPT } = await import('./migrate-relay.js');
const { INSTALL_SLUG } = await import('../../config.js');

enforceHermeticity();
allowSubprocess([STUB, 'bash', process.execPath]);

const CALLS = path.join(ROOT, 'calls');
const LABEL = `nanoclaw.approved-run=${INSTALL_SLUG}`;

/** A container runtime that records each call; `fail` names the call (first two words) that exits 1. */
function stub({ subnet = '172.30.0.0/16', ip = '172.30.0.2', fail = '' } = {}): void {
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(
    STUB,
    `#!/bin/bash
echo "$*" >> ${CALLS}
[ "$1 $2" = "${fail}" ] && { echo boom >&2; exit 1; }
case "$1 $2" in
  "network inspect") echo "${subnet}" ;;
  inspect*) echo "${ip}" ;;
  "run -d") echo relay-id ;;
esac
`,
    { mode: 0o755 },
  );
}

const calls = () => fs.readFileSync(CALLS, 'utf8').trim().split('\n');

beforeEach(() => fs.rmSync(CALLS, { force: true }));
afterAll(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe('dbEndpoint', () => {
  it("takes the host and port from the connection string the host fetched, defaulting Postgres's port", () => {
    expect(dbEndpoint('postgresql://DPG-x-a.oregon-postgres.render.com:6543/app')).toEqual({
      host: 'dpg-x-a.oregon-postgres.render.com',
      port: 6543,
    });
    expect(dbEndpoint('postgresql://db.acme.test/app')).toEqual({ host: 'db.acme.test', port: 5432 });
  });

  it.each([
    ['a bare address, which the sandbox could not be pointed away from', 'postgresql://10.0.0.5:5432/app'],
    ['a single-label name the sandbox already resolves itself', 'postgresql://localhost:5432/app'],
  ])('refuses %s', (_name, url) => {
    expect(() => dbEndpoint(url)).toThrow('the database address is not a hostname');
  });
});

describe('openRelay', () => {
  it('builds an isolated internal network and a relay pinned to the one host and port, and maps the hostname to it', async () => {
    stub();
    const relay = await openRelay('nanoclaw-approved-run-r1-1', { host: 'db.acme.test', port: 5432 }, 60_000);

    const id = relay.network.replace(/-net$/, '');
    expect(id).toMatch(/^nanoclaw-approved-run-r1-1-[0-9a-f]{6}$/);
    expect(relay.addHost).toBe('db.acme.test:172.30.0.2');
    const c = calls();
    expect(c[0]).toBe(
      `network create --internal -o com.docker.network.bridge.gateway_mode_ipv4=isolated --label ${LABEL} ${id}-net`,
    );
    const run = c.find((l) => l.startsWith('run -d'))!;
    for (const part of [
      `--name ${id}-relay`,
      `--label ${LABEL}`,
      '--network bridge',
      '--read-only',
      '--cap-drop ALL',
      '--security-opt no-new-privileges',
      '--log-driver none',
      '-e RELAY_HOST=db.acme.test',
      '-e RELAY_PORT=5432',
      '-e RELAY_SUBNET=172.30.0.0/16',
      '-e RELAY_LIFETIME_MS=60000',
    ]) {
      expect(run).toContain(part);
    }
    expect(c).toContain(`network connect ${id}-net ${id}-relay`);

    fs.rmSync(CALLS, { force: true });
    await relay.close();
    expect(calls()).toEqual([`rm -f ${id}-relay`, `network rm ${id}-net`]);
  });

  it("names each relay apart, so one run can never remove another run's", async () => {
    stub();
    const a = await openRelay('nanoclaw-approved-run-r1-1', { host: 'db.acme.test', port: 5432 }, 60_000);
    const b = await openRelay('nanoclaw-approved-run-r1-1', { host: 'db.acme.test', port: 5432 }, 60_000);
    expect(a.network).not.toBe(b.network);
  });

  it.each([['rm -f'], ['network rm']])(
    'still removes the rest, and never throws, when `%s` fails on close',
    async (fail) => {
      stub({ fail });
      const relay = await openRelay('nanoclaw-approved-run-r3-1', { host: 'db.acme.test', port: 5432 }, 60_000);
      const id = relay.network.replace(/-net$/, '');
      fs.rmSync(CALLS, { force: true });

      await expect(relay.close()).resolves.toBeUndefined();
      expect(calls()).toEqual([`rm -f ${id}-relay`, `network rm ${id}-net`]);
    },
  );

  it.each([
    ['joining the relay to the run network fails', { fail: 'network connect' }, 'network connect failed'],
    ['the run network has no IPv4 subnet', { subnet: 'fd00::/64' }, 'no IPv4 subnet'],
    ['the relay gets no address on the run network', { ip: '' }, 'no address on the run network'],
  ])('removes what it made and throws when %s', async (_name, opts, message) => {
    stub(opts);
    await expect(openRelay('nanoclaw-approved-run-r2-1', { host: 'db.acme.test', port: 5432 }, 60_000)).rejects.toThrow(
      message,
    );
    const [rm, netRm] = calls().slice(-2);
    expect(rm).toMatch(/^rm -f nanoclaw-approved-run-r2-1-[0-9a-f]{6}-relay$/);
    expect(netRm).toBe(`network rm ${rm.slice('rm -f '.length).replace(/-relay$/, '-net')}`);
  });
});

describe('the relay script', () => {
  /** Runs RELAY_SCRIPT on loopback in front of an echo server; resolves with what a client got back. */
  async function through(subnet: string): Promise<{ got: string; closed: boolean }> {
    const net = await import('node:net');
    const { spawn } = await import('node:child_process');
    const target = net.createServer((c) => c.pipe(c));
    await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
    const port = (target.address() as { port: number }).port;
    const free = net.createServer();
    await new Promise<void>((r) => free.listen(0, '127.0.0.1', r));
    const listen = (free.address() as { port: number }).port;
    await new Promise<void>((r) => free.close(() => r()));
    const relay = spawn(process.execPath, ['-e', RELAY_SCRIPT], {
      env: {
        RELAY_HOST: '127.0.0.1',
        RELAY_PORT: String(port),
        RELAY_LISTEN: String(listen),
        RELAY_SUBNET: subnet,
        RELAY_LIFETIME_MS: '20000',
      },
      stdio: 'ignore',
    });
    try {
      await vi.waitFor(
        () =>
          new Promise<void>((ok, bad) => {
            const probe = net.connect(listen, '127.0.0.1', () => (probe.destroy(), ok()));
            probe.on('error', bad);
          }),
        { timeout: 5000, interval: 50 },
      );
      return await new Promise((resolve) => {
        let got = '';
        const c = net.connect(listen, '127.0.0.1', () => c.write('ping'));
        c.on('data', (d) => {
          got += d.toString();
          if (got === 'ping') c.end();
        });
        c.on('close', () => resolve({ got, closed: true }));
        c.on('error', () => undefined);
      });
    } finally {
      relay.kill();
      target.close();
    }
  }

  it('carries a peer from its subnet to the pinned host and port', async () => {
    expect(await through('127.0.0.0/8')).toEqual({ got: 'ping', closed: true });
  });

  it('closes a peer from outside its subnet without reaching the target', async () => {
    expect(await through('10.0.0.0/8')).toEqual({ got: '', closed: true });
  });
});

it('the relay script exits on its own once its lifetime is up', async () => {
  const { spawn } = await import('node:child_process');
  const relay = spawn(process.execPath, ['-e', RELAY_SCRIPT], {
    env: {
      RELAY_HOST: '127.0.0.1',
      RELAY_PORT: '1',
      RELAY_LISTEN: '0',
      RELAY_SUBNET: '127.0.0.0/8',
      RELAY_LIFETIME_MS: '200',
    },
    stdio: 'ignore',
  });
  const code = await new Promise<number | null>((resolve) => {
    const guard = setTimeout(() => (relay.kill(), resolve(-1)), 5000);
    relay.on('exit', (c) => (clearTimeout(guard), resolve(c)));
  });
  expect(code).toBe(0);
});
