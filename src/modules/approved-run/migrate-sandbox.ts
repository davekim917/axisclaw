/**
 * Where repository code from a migration's commit runs: a throwaway container from the agent image, with only the
 * extracted tree mounted read-only. That code is agents' work, merged without a human reading it, so it never runs on
 * the host, where it could read every credential the host user can.
 */
import { execFile, spawn } from 'node:child_process';

import { CONTAINER_IMAGE, INSTALL_SLUG } from '../../config.js';
import { CONTAINER_RUNTIME_BIN } from '../../container-runtime.js';
import { containerRunsAsHostUser } from '../../github-token-file.js';
import { log } from '../../log.js';

export const SANDBOX_LABEL = 'nanoclaw.approved-run';
const STOP_GRACE_MS = 15_000;
/** Both streams together; the host keeps what a sandbox prints, so a sandbox can't fill the host's memory. */
export const OUTPUT_MAX_BYTES = 1_000_000;

export interface Spawned {
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  /** The sandbox printed more than OUTPUT_MAX_BYTES; it was stopped and the rest was dropped. */
  overflowed: boolean;
}

/** Runs `docker <args>` for at most `killAfterMs` and OUTPUT_MAX_BYTES of output, then interrupts and removes the named container. */
export type Docker = (args: string[], name: string, killAfterMs: number) => Promise<Spawned>;

export const docker: Docker = (args, name, killAfterMs) =>
  new Promise((resolve) => {
    const child = spawn(CONTAINER_RUNTIME_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let overflowed = false;
    let kept = 0;
    let stopped = false;
    // SIGINT first: psql cancels its query on the server, which rolls the transaction back.
    const stop = () => {
      if (stopped) return;
      stopped = true;
      execFile(CONTAINER_RUNTIME_BIN, ['kill', '--signal', 'INT', name], () => undefined);
      setTimeout(() => execFile(CONTAINER_RUNTIME_BIN, ['rm', '-f', name], () => undefined), STOP_GRACE_MS).unref();
    };
    const collect = (d: Buffer, add: (text: string) => void) => {
      if (overflowed) return;
      const room = OUTPUT_MAX_BYTES - kept;
      if (d.length > room) {
        overflowed = true;
        add(d.subarray(0, room).toString('utf8'));
        kept = OUTPUT_MAX_BYTES;
        stop();
        return;
      }
      kept += d.length;
      add(d.toString('utf8'));
    };
    child.stdout.on('data', (d: Buffer) => collect(d, (t) => (stdout += t)));
    child.stderr.on('data', (d: Buffer) => collect(d, (t) => (stderr += t)));
    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, killAfterMs);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, timedOut, overflowed, stdout, stderr: `${stderr}\n${err.message}` });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, overflowed, stdout, stderr });
    });
  });

/** The flags every sandbox takes: no privileges, a read-only root, and the tree mounted read-only at /work. */
export function sandboxArgs(
  name: string,
  tree: string,
  network: 'none' | `${string}-net`,
  uid: number | undefined = process.getuid?.(),
  gid: number | undefined = process.getgid?.(),
): string[] {
  // The tree is the host user's and 0700, so the sandbox runs as that user wherever session containers do.
  const user = containerRunsAsHostUser(uid) ? ['--user', `${uid}:${gid}`] : [];
  return [
    'run',
    ...user,
    '--rm',
    // The daemon's log copy would hold output before the host redacts it.
    '--log-driver',
    'none',
    '--name',
    name,
    '--label',
    `${SANDBOX_LABEL}=${INSTALL_SLUG}`,
    '--network',
    network,
    '--read-only',
    '--tmpfs',
    '/tmp:rw,size=64m',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--memory',
    '1g',
    '--pids-limit',
    '256',
    '-v',
    `${tree}:/work:ro`,
    '-w',
    '/work',
    '--entrypoint',
    'node',
  ];
}

export const SANDBOX_IMAGE = CONTAINER_IMAGE;

/** `<runtime> <args>`'s non-empty output lines; an error is logged and lists nothing. */
function listed(args: string[], what: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile(CONTAINER_RUNTIME_BIN, args, { timeout: 30_000 }, (err, stdout) => {
      if (err) log.warn(`Could not list leftover approved-run ${what}`, { err });
      resolve(err ? [] : String(stdout).split('\n').filter(Boolean));
    });
  });
}

function removed(args: string[], ids: string[], what: string): Promise<void> {
  return new Promise((resolve) => {
    if (ids.length === 0) return resolve();
    execFile(CONTAINER_RUNTIME_BIN, [...args, ...ids], { timeout: 60_000 }, (err) => {
      if (err) log.error(`Could not remove leftover approved-run ${what}`, { ids, err });
      else log.warn(`Removed approved-run ${what} a previous host left behind`, { ids });
      resolve();
    });
  });
}

/**
 * A host that died mid-run leaves its sandbox and relay running and their network in place, since none is the host's
 * child. Removed before the boot reports interrupted runs, so a report of "unknown" is never followed by a late
 * commit; the networks go last, since the runtime keeps a network that a container still uses.
 */
export async function stopLeftoverSandboxes(): Promise<void> {
  const label = `label=${SANDBOX_LABEL}=${INSTALL_SLUG}`;
  await removed(['rm', '-f'], await listed(['ps', '-aq', '--filter', label], 'containers'), 'containers');
  await removed(['network', 'rm'], await listed(['network', 'ls', '-q', '--filter', label], 'networks'), 'networks');
}
