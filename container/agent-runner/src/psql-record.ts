/**
 * Runs the real psql with the caller's stdio and records a read to the source ledger. Started by the `psql` shim only
 * while recording is on. The command line routinely carries a connection string with its password inline, so the
 * entry is parsed here and holds only the database name, the tables read and the exit status: never an argument, never
 * SQL text.
 *
 * Tables are named only from `-c` commands. A script from `-f` or stdin is read to tell a read from a write, but names
 * nothing: psql may take a line of it as a password at any prompt, treat lines after a COPY as data, or change how
 * strings are quoted part way through, and any of those can make text that is not SQL look like a table name.
 */
import { spawn, type StdioOptions } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';

import { appendLedgerEntry, ledgerPath } from './source-ledger.js';
import { readPostgresSql } from './turn-sources.js';

const MAX_LEDGER_BYTES = 256 * 1024 * 1024;
/** A script is classified from its first MiB. */
const MAX_SQL_BYTES = 1024 * 1024;

const DATABASE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_$-]{0,62}$/;

/** psql 15's getopt string: a letter followed by `:` takes a value. */
const SHORT_WITH_VALUE = new Set([...'cdfFhLoPpRTUv']);
const SHORT_FLAGS = new Set([...'aAbeEHlnqsStVwWxXz?01']);
const LONG_OPTIONS: Record<string, { short: string; value: boolean }> = {
  'echo-all': { short: 'a', value: false },
  'no-align': { short: 'A', value: false },
  command: { short: 'c', value: true },
  dbname: { short: 'd', value: true },
  'echo-queries': { short: 'e', value: false },
  'echo-errors': { short: 'b', value: false },
  'echo-hidden': { short: 'E', value: false },
  file: { short: 'f', value: true },
  'field-separator': { short: 'F', value: true },
  'field-separator-zero': { short: 'z', value: false },
  host: { short: 'h', value: true },
  html: { short: 'H', value: false },
  list: { short: 'l', value: false },
  'log-file': { short: 'L', value: true },
  'no-readline': { short: 'n', value: false },
  'single-transaction': { short: '1', value: false },
  output: { short: 'o', value: true },
  port: { short: 'p', value: true },
  pset: { short: 'P', value: true },
  quiet: { short: 'q', value: false },
  'record-separator': { short: 'R', value: true },
  'record-separator-zero': { short: '0', value: false },
  'single-step': { short: 's', value: false },
  'single-line': { short: 'S', value: false },
  'tuples-only': { short: 't', value: false },
  'table-attr': { short: 'T', value: true },
  username: { short: 'U', value: true },
  set: { short: 'v', value: true },
  variable: { short: 'v', value: true },
  version: { short: 'V', value: false },
  'no-password': { short: 'w', value: false },
  password: { short: 'W', value: false },
  expanded: { short: 'x', value: false },
  'no-psqlrc': { short: 'X', value: false },
  help: { short: '?', value: false },
  csv: { short: '', value: false },
};

type SqlSource = { kind: 'command'; text: string } | { kind: 'file'; path: string };

export interface PsqlPlan {
  /** In command-line order; empty means psql reads its script from stdin. */
  sources: SqlSource[];
  /** The database named on the command line, when it can be read without touching any other part of the target. */
  database?: string;
  /** The server can only be on this machine, so the call reads a test database, not data the reply relies on. */
  local?: true;
}

/**
 * libpq's URI form. Only the path segment after the authority is ever taken, and only when no `@` follows the first
 * `/`: a password holding a `/` would otherwise put part of itself where the database name goes. A `dbname` in the
 * query overrides the path in libpq, so a URI carrying one names nothing.
 */
function databaseFromUri(target: string): string | undefined {
  const rest = target.replace(/^postgres(?:ql)?:\/\//i, '');
  const slash = rest.indexOf('/');
  if (slash === -1) return undefined;
  const authority = rest.slice(0, slash);
  const path = rest.slice(slash + 1);
  if (/[?#]/.test(authority) || /[@#]/.test(path)) return undefined;
  const [name, ...query] = path.split('?');
  if (query.length > 0) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(query.join('?'));
    } catch {
      return undefined;
    }
    if (/dbname/i.test(decoded)) return undefined;
  }
  return DATABASE_NAME_RE.test(name) ? name : undefined;
}

/** libpq's isspace() in the C locale; JavaScript's `\s` also matches a no-break space, which libpq keeps in a value. */
const isSpace = (c: string | undefined): boolean => c !== undefined && ' \t\n\r\f\v'.includes(c);

/** libpq's `key=value` form: values may be single-quoted, and a backslash escapes the next character in either form. */
function parseConninfo(target: string): Array<[string, string]> | null {
  const pairs: Array<[string, string]> = [];
  let i = 0;
  const skipSpace = (): void => {
    while (isSpace(target[i])) i++;
  };
  for (;;) {
    skipSpace();
    if (i >= target.length) break;
    const keyStart = i;
    while (i < target.length && target[i] !== '=' && !isSpace(target[i])) i++;
    const key = target.slice(keyStart, i);
    skipSpace();
    if (target[i] !== '=') return null;
    i++;
    skipSpace();
    let value = '';
    if (target[i] === "'") {
      i++;
      while (i < target.length && target[i] !== "'") {
        if (target[i] === '\\') i++;
        value += target[i] ?? '';
        i++;
      }
      if (target[i] !== "'") return null;
      i++;
    } else {
      while (i < target.length && !isSpace(target[i])) {
        if (target[i] === '\\') i++;
        value += target[i] ?? '';
        i++;
      }
    }
    pairs.push([key, value]);
  }
  return pairs;
}

function databaseFromConninfo(target: string): string | undefined {
  const database = parseConninfo(target)
    ?.filter(([key]) => key === 'dbname')
    .pop()?.[1];
  return database !== undefined && DATABASE_NAME_RE.test(database) ? database : undefined;
}

/** The database a `-d` value or positional target names. Anything it cannot read with certainty names nothing. */
export function databaseFromTarget(target: string): string | undefined {
  if (/^postgres(?:ql)?:\/\//i.test(target)) return databaseFromUri(target);
  if (target.includes('=')) return databaseFromConninfo(target);
  return DATABASE_NAME_RE.test(target) ? target : undefined;
}

/** The server-choosing parameters a target sets, each value as written (a host list stays one comma-joined value). */
interface TargetServer {
  host: string[];
  hostaddr: string[];
  service: boolean;
}

/** libpq's URI parser: user info runs to the first `@` before any `/`, then hosts to the path; the query may add more. */
function serverFromUri(target: string): TargetServer | null {
  const rest = target.replace(/^postgres(?:ql)?:\/\//, '');
  const userEnd = rest.search(/[@/]/);
  const hostsStart = userEnd !== -1 && rest[userEnd] === '@' ? userEnd + 1 : 0;
  const hostsEnd = rest.slice(hostsStart).search(/[/?]/);
  const authority = rest.slice(hostsStart, hostsEnd === -1 ? undefined : hostsStart + hostsEnd);
  const afterHosts = hostsEnd === -1 ? '' : rest.slice(hostsStart + hostsEnd);
  const decode = (s: string): string | null => {
    try {
      return decodeURIComponent(s);
    } catch {
      return null;
    }
  };
  const hosts: string[] = [];
  for (const spec of authority.split(',')) {
    const host = spec.startsWith('[') ? spec.slice(1, spec.indexOf(']')) : spec.split(':')[0];
    const decoded = decode(host);
    if (decoded === null || spec.includes('@') || (spec.startsWith('[') && !spec.includes(']'))) return null;
    hosts.push(decoded);
  }
  const server: TargetServer = { host: authority === '' ? [] : [hosts.join(',')], hostaddr: [], service: false };
  const query = afterHosts.indexOf('?');
  if (query === -1) return server;
  for (const param of afterHosts.slice(query + 1).split('&')) {
    const eq = param.indexOf('=');
    if (eq === -1) return null;
    const key = decode(param.slice(0, eq));
    const value = decode(param.slice(eq + 1));
    if (key === null || value === null) return null;
    if (key === 'host') server.host.push(value);
    else if (key === 'hostaddr') server.hostaddr.push(value);
    else if (key === 'service') server.service = true;
  }
  return server;
}

function serverFromTarget(target: string | undefined): TargetServer | null {
  if (target === undefined) return { host: [], hostaddr: [], service: false };
  // libpq matches the scheme case-sensitively: `POSTGRESQL://…` is a database name.
  if (/^postgres(?:ql)?:\/\//.test(target)) return serverFromUri(target);
  if (!target.includes('=')) return { host: [], hostaddr: [], service: false };
  const pairs = parseConninfo(target);
  if (!pairs) return null;
  return {
    host: pairs.filter(([k]) => k === 'host').map(([, v]) => v),
    hostaddr: pairs.filter(([k]) => k === 'hostaddr').map(([, v]) => v),
    service: pairs.some(([k]) => k === 'service'),
  };
}

/** What besides the command line can choose the server psql reaches, or run commands before the call's own. */
export interface Surroundings {
  env: Readonly<Record<string, string | undefined>>;
  /** The caller's home directories: `$HOME` and the password database's entry, which can differ. */
  homes: readonly string[];
  /** The names in a directory: empty when it does not exist, null when it exists but cannot be listed. */
  list: (dir: string) => readonly string[] | null;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const LOOPBACK_ADDRS = new Set(['127.0.0.1', '::1']);
const PG_SYSCONFDIR = '/etc/postgresql-common';

/** Every entry of every value is local. An empty entry means libpq's default, which `fallback` says is local or not. */
function allLocal(values: readonly string[], allowed: (entry: string) => boolean, fallback: () => boolean): boolean {
  let usesDefault = values.length === 0;
  for (const value of values) {
    for (const entry of value.split(',')) {
      if (entry === '') usesDefault = true;
      else if (!allowed(entry)) return false;
    }
  }
  return !usesDefault || fallback();
}

/**
 * Whether the call can only reach a server on this machine: loopback or a Unix socket. Anything not proven local is
 * not: a service file, a psqlrc that might `\connect`, an address it cannot read.
 */
function provenLocal(
  target: string | undefined,
  hostOption: string | undefined,
  readsPsqlrc: boolean,
  s: Surroundings,
): boolean {
  const server = serverFromTarget(target);
  if (!server || server.service || s.env.PGSERVICE !== undefined) return false;
  const isLocalHost = (h: string): boolean => LOOPBACK_HOSTS.has(h) || h.startsWith('/');
  // With no host on the command line and no PGHOST, Debian's psql (pg_wrapper) picks a cluster, which may be remote,
  // from more configuration than can be checked here: PGCLUSTER, PGSYSCONFDIR, PG_CLUSTER_CONF_ROOT, ~/.postgresqlrc.
  const hostFromEnv = (): boolean => s.env.PGHOST !== undefined && allLocal([s.env.PGHOST], isLocalHost, () => true);
  const hosts = [...(hostOption === undefined ? [] : [hostOption]), ...server.host];
  if (!allLocal(hosts, isLocalHost, hostFromEnv)) return false;
  const addrFromEnv = (): boolean =>
    s.env.PGHOSTADDR === undefined ||
    allLocal(
      [s.env.PGHOSTADDR],
      (a) => LOOPBACK_ADDRS.has(a),
      () => true,
    );
  if (!allLocal(server.hostaddr, (a) => LOOPBACK_ADDRS.has(a), addrFromEnv)) return false;
  if (!readsPsqlrc) return true;
  if (s.env.PSQLRC !== undefined || s.env.PGSYSCONFDIR !== undefined) return false;
  const holds = (dir: string, prefix: string): boolean => {
    const names = s.list(dir);
    return names === null || names.some((name) => name.startsWith(prefix));
  };
  return !s.homes.some((home) => holds(home, '.psqlrc')) && !holds(PG_SYSCONFDIR, 'psqlrc');
}

/**
 * Reads the command line as psql's getopt_long does (permuted operands, bundled short options, unambiguous long
 * prefixes). Null when the call runs no script to record (`--list`, `--version`, `--help`) or the command line cannot
 * be read with certainty.
 */
export function planPsql(
  argv: readonly string[],
  posixlyCorrect = false,
  surroundings?: Surroundings,
): PsqlPlan | null {
  const sources: SqlSource[] = [];
  const operands: string[] = [];
  let dbOption: string | undefined;
  let hostOption: string | undefined;
  let readsPsqlrc = true;
  const take = (short: string, value: string): void => {
    if (short === 'c') sources.push({ kind: 'command', text: value });
    else if (short === 'f') sources.push({ kind: 'file', path: value });
    else if (short === 'd') dbOption = value;
    else if (short === 'h') hostOption = value;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      operands.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const name = a.slice(2, eq === -1 ? undefined : eq);
      const matches = Object.keys(LONG_OPTIONS).filter((n) => n === name || n.startsWith(name));
      const exact = matches.includes(name) ? name : matches.length === 1 ? matches[0] : null;
      if (!exact || (name === 'help' && eq !== -1)) return null;
      const opt = LONG_OPTIONS[exact];
      if (['l', 'V', '?'].includes(opt.short)) return null;
      if (!opt.value) {
        if (eq !== -1) return null;
        if (opt.short === 'X') readsPsqlrc = false;
        continue;
      }
      const value = eq !== -1 ? a.slice(eq + 1) : argv[++i];
      if (value === undefined) return null;
      take(opt.short, value);
    } else if (a.startsWith('-') && a !== '-') {
      for (let k = 1; k < a.length; k++) {
        const short = a[k];
        if (SHORT_WITH_VALUE.has(short)) {
          const value = k + 1 < a.length ? a.slice(k + 1) : argv[++i];
          if (value === undefined) return null;
          take(short, value);
          break;
        }
        if (!SHORT_FLAGS.has(short) || ['l', 'V', '?'].includes(short)) return null;
        if (short === 'X') readsPsqlrc = false;
      }
    } else if (posixlyCorrect) {
      // getopt stops at the first operand: every later option is an operand psql ignores.
      operands.push(...argv.slice(i));
      break;
    } else {
      operands.push(a);
    }
  }
  const target = dbOption ?? operands[0];
  const database = target === undefined ? undefined : databaseFromTarget(target);
  const local = surroundings !== undefined && provenLocal(target, hostOption, readsPsqlrc, surroundings);
  return { sources, ...(database ? { database } : {}), ...(local ? { local: true as const } : {}) };
}

function readCapped(file: string): Script {
  // A FIFO or `/dev/stdin` would be drained here and never reach psql.
  if (!fs.statSync(file, { throwIfNoEntry: false })?.isFile()) return { text: '', command: false, complete: false };
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_SQL_BYTES + 1);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    return {
      text: buf.subarray(0, Math.min(n, MAX_SQL_BYTES)).toString('utf8'),
      command: false,
      complete: n <= MAX_SQL_BYTES,
    };
  } finally {
    fs.closeSync(fd);
  }
}

interface Script {
  text: string;
  /** A `-c` command, the only kind whose tables are named. */
  command: boolean;
  /** The whole script was read: a `\c` in a part never seen would leave the database wrong. */
  complete: boolean;
}

/** Each `-c`, `-f` and stdin script is lexed on its own, as psql runs it: an unclosed comment in one never hides the next. */
function record(plan: PsqlPlan, scripts: readonly Script[], ok: boolean): void {
  const reads = scripts.map((s) => ({
    ...readPostgresSql(s.text, s.command ? 'command' : 'script'),
    command: s.command,
  }));
  if (!reads.some((r) => r.reads)) return;
  // Only a `-c` that does not start with a backslash goes to the server as written. Anything psql itself interprets can
  // switch server part way through: `\c`, `\i`, `\e` re-reading an editor's output, a variable whose value is a `\c`.
  const serverOnly = scripts.every((s) => s.command && !/^\s*\\/.test(s.text));
  if (plan.local && serverOnly) return;
  const tables = [...new Set(reads.flatMap((r) => (r.command ? r.tables : [])))];
  try {
    if ((fs.statSync(ledgerPath(), { throwIfNoEntry: false })?.size ?? 0) > MAX_LEDGER_BYTES) return;
  } catch {
    return;
  }
  // A failed call may have failed because the "database" was something else typed in its place, such as a password.
  const database = ok && !reads.some((r) => r.connects) && scripts.every((s) => s.complete) ? plan.database : undefined;
  appendLedgerEntry({
    v: 1,
    ts: new Date().toISOString(),
    recorder: 'postgres',
    ...(database ? { database } : {}),
    // A failed call read nothing, so it keeps nothing that came from its text.
    tables: ok ? tables : [],
    ok,
  });
}

const FDS_ARG = '--nanoclaw-fds=';

/** The shim's own descriptors past stderr, as it lists them in `--nanoclaw-fds=`, which psql inherits unchanged. */
function stdioFor(shimFds: readonly number[], scriptFromStdin: boolean): StdioOptions {
  const stdio: Array<'pipe' | 'inherit' | 'ignore' | number> = [
    scriptFromStdin ? 'pipe' : 'inherit',
    'inherit',
    'inherit',
  ];
  for (const fd of [...shimFds].sort((a, b) => a - b)) {
    if (!Number.isInteger(fd) || fd <= 2) continue;
    try {
      fs.fstatSync(fd);
    } catch {
      continue;
    }
    while (stdio.length < fd) stdio.push('ignore');
    stdio[fd] = fd;
  }
  return stdio;
}

function main(): void {
  const real = process.env.NANOCLAW_PSQL_REAL || '/usr/bin/psql';
  const raw = process.argv.slice(2);
  const shimFds = raw[0]?.startsWith(FDS_ARG)
    ? raw[0].slice(FDS_ARG.length).split(',').filter(Boolean).map(Number)
    : [];
  const argv = raw[0]?.startsWith(FDS_ARG) ? raw.slice(1) : raw;
  let plan: PsqlPlan | null = null;
  const parts: Script[] = [];
  try {
    plan = planPsql(argv, process.env.POSIXLY_CORRECT !== undefined, {
      env: process.env,
      homes: [
        ...new Set([
          os.homedir(),
          ((): string => {
            try {
              return os.userInfo().homedir;
            } catch {
              return os.homedir();
            }
          })(),
        ]),
      ],
      list: (dir) => {
        try {
          return fs.readdirSync(dir);
        } catch (err) {
          return (err as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
        }
      },
    });
    for (const source of plan?.sources ?? []) {
      if (source.kind === 'command') parts.push({ text: source.text, command: true, complete: true });
      else if (source.path !== '-') parts.push(readCapped(source.path));
      else if (process.stdin.isTTY) parts.push({ text: '', command: false, complete: false });
    }
  } catch {
    plan = null;
  }
  const scriptFromStdin =
    plan !== null &&
    !process.stdin.isTTY &&
    (plan.sources.length === 0 || plan.sources.some((s) => s.kind === 'file' && s.path === '-'));

  const child = spawn(real, argv, { stdio: stdioFor(shimFds, scriptFromStdin) });
  // A signal sent to this pid must reach psql. A terminal's Ctrl-C reaches psql through the process group as well, so
  // psql sees it twice; a second cancel of the same query changes nothing.
  const forwarded: NodeJS.Signals[] = ['SIGINT', 'SIGQUIT', 'SIGTERM', 'SIGHUP', 'SIGUSR1', 'SIGUSR2'];
  const forward = (signal: NodeJS.Signals): void => {
    child.kill(signal);
  };
  for (const signal of forwarded) process.on(signal, forward);

  let captured = 0;
  const stdinChunks: Buffer[] = [];
  if (scriptFromStdin && child.stdin) {
    const sink = child.stdin;
    // psql exiting before its input ends (an error under ON_ERROR_STOP) closes the pipe; the rest is not needed.
    sink.on('error', () => process.stdin.destroy());
    process.stdin.on('data', (chunk: Buffer) => {
      if (captured <= MAX_SQL_BYTES) {
        stdinChunks.push(chunk);
        captured += chunk.length;
      }
      if (!sink.write(chunk)) {
        process.stdin.pause();
        sink.once('drain', () => process.stdin.resume());
      }
    });
    process.stdin.on('end', () => sink.end());
    process.stdin.on('error', () => sink.end());
  }

  let spawnError: Error | null = null;
  child.on('error', (err) => {
    spawnError = err;
  });
  child.on('close', (code, signal) => {
    const status = spawnError ? 127 : (code ?? 1);
    try {
      if (plan && !spawnError) {
        if (scriptFromStdin) {
          const stdin = Buffer.concat(stdinChunks);
          parts.push({
            text: stdin.subarray(0, MAX_SQL_BYTES).toString('utf8'),
            command: false,
            complete: stdin.length <= MAX_SQL_BYTES,
          });
        }
        record(plan, parts, status === 0);
      }
    } catch {
      // A recorder must not fail the call it records.
    }
    if (spawnError) process.stderr.write(`psql: ${(spawnError as Error).message}\n`);
    for (const s of forwarded) process.off(s, forward);
    if (signal) {
      process.kill(process.pid, signal);
      // Bun ignores SIGPIPE, so a self-kill with it does not end the process; exit as a shell reports that death.
      process.exit(128 + (os.constants.signals[signal] ?? 0));
    }
    process.exit(status);
  });
}

if (import.meta.main) main();
