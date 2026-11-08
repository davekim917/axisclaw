/**
 * The only way out of a migration sandbox. The sandbox sits on an internal network with no route anywhere; a relay
 * container on that network and the default bridge forwards one port to the one database host the host itself read
 * from Render, so code at the approved commit can reach its database and nothing else. A Unix socket would not do:
 * libpq never uses TLS on one, whatever `sslmode` says.
 */
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';

import { INSTALL_SLUG } from '../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { log } from '../../log.js';

import { SANDBOX_IMAGE, SANDBOX_LABEL } from './migrate-sandbox.js';

export interface DbEndpoint {
  host: string;
  port: number;
}

export interface Relay {
  network: `${string}-net`;
  /** Maps the database's own hostname to the relay, so TLS still names the real host. */
  addHost: string;
  close: () => Promise<void>;
}

/** `lifetimeMs` outlasts the step, so a relay its run failed to remove still ends. */
export type OpenRelay = (name: string, endpoint: DbEndpoint, lifetimeMs: number) => Promise<Relay>;

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const SUBNET_RE = /^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\/\d{1,2}$/;

/** The database's host and port, from the connection string the host fetched; a bare address cannot be remapped. */
export function dbEndpoint(connectionString: string): DbEndpoint {
  const u = new URL(connectionString);
  const host = u.hostname.toLowerCase();
  if (!HOSTNAME_RE.test(host) || IPV4_RE.test(host)) throw new Error('the database address is not a hostname');
  const port = u.port ? Number(u.port) : 5432;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('the database port is invalid');
  return { host, port };
}

/** Runs in the relay container as `node -e`. `RELAY_LISTEN` defaults to the database port. */
export const RELAY_SCRIPT = `
const net = require('node:net');
const [base, bits] = process.env.RELAY_SUBNET.split('/');
const n = (ip) => ip.split('.').reduce((a, b) => a * 256 + Number(b), 0);
const size = 2 ** (32 - Number(bits));
const start = Math.floor(n(base) / size) * size;
const inside = (ip) => { const v = n(ip.replace(/^::ffff:/, '')); return v >= start && v < start + size; };
const port = Number(process.env.RELAY_PORT);
setTimeout(() => process.exit(0), Number(process.env.RELAY_LIFETIME_MS));
net.createServer((client) => {
  if (!inside(client.remoteAddress || '')) return client.destroy();
  const upstream = net.connect(port, process.env.RELAY_HOST);
  client.pipe(upstream).pipe(client);
  const end = () => { client.destroy(); upstream.destroy(); };
  client.on('error', end); upstream.on('error', end); client.on('close', end); upstream.on('close', end);
}).listen(Number(process.env.RELAY_LISTEN || port), '0.0.0.0');
`;

function runtime(args: string[], timeoutMs = 60_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(CONTAINER_RUNTIME_BIN, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err)
        reject(
          new Error(
            `${args[0]} ${args[1] ?? ''} failed: ${String(stderr || err.message)
              .trim()
              .slice(0, 200)}`,
          ),
        );
      else resolve(String(stdout).trim());
    });
  });
}

export const openRelay: OpenRelay = async (name, endpoint, lifetimeMs) => {
  // A random part keeps two runs, or a cleanup after a failed create, from ever touching each other's containers.
  const id = `${name}-${randomBytes(3).toString('hex')}`;
  const network = `${id}-net` as const;
  const relay = `${id}-relay`;
  const label = `${SANDBOX_LABEL}=${INSTALL_SLUG}`;
  const close = async () => {
    await runtime(['rm', '-f', relay]).catch((err: unknown) =>
      log.warn('Could not remove an approved-run relay', { relay, err }),
    );
    await runtime(['network', 'rm', network]).catch((err: unknown) =>
      log.warn('Could not remove an approved-run network', { network, err }),
    );
  };
  try {
    // An internal network still gives the host an address on it, reaching every service the host binds to all
    // interfaces; an isolated gateway gives the host none.
    await runtime([
      'network',
      'create',
      '--internal',
      '-o',
      'com.docker.network.bridge.gateway_mode_ipv4=isolated',
      '--label',
      label,
      network,
    ]);
    const subnet = await runtime(['network', 'inspect', '-f', '{{(index .IPAM.Config 0).Subnet}}', network]);
    if (!SUBNET_RE.test(subnet)) throw new Error(`the run network has no IPv4 subnet (${subnet.slice(0, 40)})`);
    await runtime([
      'run',
      '-d',
      '--rm',
      '--log-driver',
      'none',
      '--name',
      relay,
      '--label',
      label,
      '--network',
      'bridge',
      '--read-only',
      '--cap-drop',
      'ALL',
      '--security-opt',
      'no-new-privileges',
      '--memory',
      '128m',
      '--pids-limit',
      '32',
      '-e',
      `RELAY_HOST=${endpoint.host}`,
      '-e',
      `RELAY_PORT=${endpoint.port}`,
      '-e',
      `RELAY_SUBNET=${subnet}`,
      '-e',
      `RELAY_LIFETIME_MS=${lifetimeMs}`,
      '--entrypoint',
      'node',
      SANDBOX_IMAGE,
      '-e',
      RELAY_SCRIPT,
    ]);
    await runtime(['network', 'connect', network, relay]);
    const ip = await runtime(['inspect', '-f', `{{(index .NetworkSettings.Networks "${network}").IPAddress}}`, relay]);
    if (!IPV4_RE.test(ip)) throw new Error('the relay has no address on the run network');
    return { network, addHost: `${endpoint.host}:${ip}`, close };
  } catch (err) {
    await close();
    throw err;
  }
};
