import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { databaseFromTarget, planPsql, type Surroundings } from './psql-record.js';
import { allowSubprocess, allowWritesTo, resetHermeticityAllowances } from './test-hermeticity.js';

describe('databaseFromTarget', () => {
  // A password may hold `/`, `?` or `#`; a looser parse would put part of it where the database name goes.
  it.each([
    ['a URI', 'postgresql://zz_reader:Pw9xQ7tr@fixture.pghost.example:6543/app_dev', 'app_dev'],
    ['a URI with parameters', 'postgres://fixture.pghost.example/app_dev?sslmode=require&password=Pw9xQ7tr', 'app_dev'],
    ['a URI with no database', 'postgres://zz_reader:Pw9xQ7tr@fixture.pghost.example:6543', undefined],
    ['a password holding a slash', 'postgres://zz_reader:pwSegA/pwSegB@fixture.pghost.example/app_dev', undefined],
    [
      'a password holding a slash and a query mark',
      'postgres://zz_reader:pwSegA/pwSegB?x@fixture.pghost.example/app_dev',
      undefined,
    ],
    ['a password holding a query mark', 'postgres://zz_reader:pwSegA?pwSegB@fixture.pghost.example/app_dev', undefined],
    ['a password holding a hash', 'postgres://zz_reader:pwSegA#pwSegB@fixture.pghost.example/app_dev', undefined],
    ['a percent-encoded name', 'postgres://fixture.pghost.example/app%5Fdev', undefined],
    ['a conninfo string', "host=fixture.pghost.example password='Pw 9\\'x' dbname = 'app_dev'", 'app_dev'],
    ['a conninfo password that spells dbname=', 'host=fixture.pghost.example password=dbname=Pw9xQ7tr', undefined],
    ['a malformed conninfo string', 'host=fixture.pghost.example dbname', undefined],
    [
      'a conninfo password holding a no-break space, which libpq keeps in the value',
      'dbname=app_dev password=first dbname=pwSegA',
      'app_dev',
    ],
    [
      'a URI whose query overrides the database',
      'postgres://fixture.pghost.example/app_dev?dbname=other_db',
      undefined,
    ],
    [
      'a URI whose encoded query overrides it',
      'postgres://fixture.pghost.example/app_dev?%64bname=other_db',
      undefined,
    ],
    ['a plain name', 'app_dev', 'app_dev'],
    ['a name with a space', 'app dev', undefined],
  ])('%s', (_name, target, expected) => {
    expect(databaseFromTarget(target)).toBe(expected);
  });
});

describe('planPsql', () => {
  it.each([
    [
      'bundled short options with the command last, database as an operand',
      ['-XAtc', 'select 1', 'app_dev'],
      { sources: [{ kind: 'command', text: 'select 1' }], database: 'app_dev' },
    ],
    [
      '-d names the database; the operand after it is the user',
      ['-d', 'app_dev', 'zz_reader'],
      { sources: [], database: 'app_dev' },
    ],
    [
      'long options, an unambiguous prefix and an attached value, in order',
      ['--dbname=app_dev', '--comm', 'select 1', '-fq.sql', '-f', '-'],
      {
        sources: [
          { kind: 'command', text: 'select 1' },
          { kind: 'file', path: 'q.sql' },
          { kind: 'file', path: '-' },
        ],
        database: 'app_dev',
      },
    ],
    [
      'an option value is not an operand',
      ['-v', 'ON_ERROR_STOP=1', '-h', 'fixture.pghost.example', 'app_dev'],
      { sources: [], database: 'app_dev' },
    ],
    ['everything after -- is an operand', ['--', '-weird'], { sources: [] }],
  ])('%s', (_name, argv, expected) => {
    expect(planPsql(argv)).toEqual(expected as ReturnType<typeof planPsql>);
  });

  it.each([
    ['--list', ['-l']],
    ['--version', ['--version']],
    ['help', ['-?']],
    ['help on a topic', ['--help=commands']],
    ['an unknown option', ['-Z', 'app_dev']],
    ['an ambiguous long prefix', ['--no', 'app_dev']],
    ['a missing value', ['-c']],
  ])('records nothing for %s', (_name, argv) => {
    expect(planPsql(argv)).toBeNull();
  });

  it('stops at the first operand under POSIXLY_CORRECT, as getopt does', () => {
    expect(planPsql(['-X', '-U', 'zz_reader', 'app_dev', '-c', 'select * from app.t'], true)).toEqual({
      sources: [],
      database: 'app_dev',
    });
  });
});

interface Call {
  argv: string[];
  env?: Record<string, string>;
  /** Directory listings; null for one that exists but cannot be listed. */
  dirs?: Record<string, string[] | null>;
}

const HOME = '/home/fixture-user';
const REMOTE = 'fixture.pghost.example';

function isLocal(call: Call): boolean {
  const surroundings: Surroundings = {
    env: call.env ?? {},
    homes: [HOME],
    list: (dir) => (call.dirs && dir in call.dirs ? call.dirs[dir] : []),
  };
  return planPsql([...call.argv, '-c', 'select * from app.orders'], false, surroundings)?.local === true;
}

describe('a server proven local', () => {
  // Each row pairs a call that can only reach this machine with the nearest one that may not.
  it.each<[string, Call, Call]>([
    ['a host option', { argv: ['-h', 'localhost'] }, { argv: ['-h', REMOTE] }],
    ['a loopback address', { argv: ['-h', '127.0.0.1'] }, { argv: ['-h', '127.0.0.2'] }],
    ['an IPv6 loopback address', { argv: ['--host=::1'] }, { argv: ['--host=::2'] }],
    ['a socket directory', { argv: ['-h/var/run/postgresql'] }, { argv: ['-hvar/run/postgresql'] }],
    ['only the exact spelling of localhost', { argv: ['-h', 'localhost'] }, { argv: ['-h', 'LOCALHOST'] }],
    ['every host of a list', { argv: ['-h', 'localhost,/tmp/pgfix'] }, { argv: ['-h', `localhost,${REMOTE}`] }],
    [
      'a URI with its password inline',
      { argv: ['postgresql://zz_reader:Pw9xQ7tr@127.0.0.1:55432/app_dev'] },
      { argv: [`postgresql://zz_reader:Pw9xQ7tr@${REMOTE}:55432/app_dev`] },
    ],
    [
      'a URI with an IPv6 host',
      { argv: ['postgresql://[::1]:55432/app_dev'] },
      { argv: ['postgresql://[fd00::1]:55432/app_dev'] },
    ],
    [
      'every host of a URI',
      { argv: ['postgresql://%2Ftmp%2Fpgfix,localhost/app_dev'] },
      { argv: [`postgresql://%2Ftmp%2Fpgfix,${REMOTE}/app_dev`] },
    ],
    [
      'a host in a URI query, which libpq also applies',
      { argv: ['postgresql:///app_dev?host=%2Ftmp%2Fpgfix'] },
      { argv: [`postgresql://localhost/app_dev?host=${REMOTE}`] },
    ],
    [
      'a URI password holding a slash, which libpq reads as a host name',
      { argv: ['postgresql://zz_reader:pwSegA@127.0.0.1/app_dev'] },
      { argv: ['postgresql://zz_reader:pwSegA/pwSegB@127.0.0.1/app_dev'] },
    ],
    [
      'a URI password holding an @',
      { argv: ['postgresql://zz_reader:pwSegA@127.0.0.1/app_dev'] },
      { argv: ['postgresql://zz_reader:pw@SegA@127.0.0.1/app_dev'] },
    ],
    [
      'the URI scheme in lower case only, as libpq matches it: otherwise it is a database name',
      { argv: ['postgresql://localhost/app_dev'], env: { PGHOST: REMOTE } },
      { argv: ['POSTGRESQL://localhost/app_dev'], env: { PGHOST: REMOTE } },
    ],
    [
      'a URI host that cannot be decoded',
      { argv: ['postgresql://%2Ftmp/app_dev'] },
      { argv: ['postgresql://%zz/app_dev'] },
    ],
    [
      'a URI naming a service',
      { argv: ['postgresql://localhost/app_dev'] },
      { argv: ['postgresql://localhost/app_dev?service=fixture_svc'] },
    ],
    ['a conninfo host', { argv: ['host=localhost dbname=app_dev'] }, { argv: [`host=${REMOTE} dbname=app_dev`] }],
    [
      'a conninfo host, which overrides -h',
      { argv: ['-h', 'localhost', 'host=/tmp/pgfix dbname=app_dev'] },
      { argv: ['-h', 'localhost', `host=${REMOTE} dbname=app_dev`] },
    ],
    [
      'both -h and the target, whichever psql applies',
      { argv: ['-h', '/tmp/pgfix', 'postgresql://127.0.0.1/app_dev'] },
      { argv: ['-h', REMOTE, 'postgresql://127.0.0.1/app_dev'] },
    ],
    [
      'a conninfo hostaddr, which libpq connects to instead of the host',
      { argv: ['host=localhost hostaddr=127.0.0.1 dbname=app_dev'] },
      { argv: ['host=localhost hostaddr=192.0.2.10 dbname=app_dev'] },
    ],
    [
      'PGHOSTADDR',
      { argv: ['-h', 'localhost'], env: { PGHOSTADDR: '::1' } },
      { argv: ['-h', 'localhost'], env: { PGHOSTADDR: '192.0.2.10' } },
    ],
    ['a malformed conninfo string', { argv: ['host=localhost dbname=app_dev'] }, { argv: ['host=localhost dbname'] }],
    [
      'a conninfo service',
      { argv: ['host=localhost dbname=app_dev'] },
      { argv: ['host=localhost service=fixture_svc dbname=app_dev'] },
    ],
    ['PGSERVICE', { argv: ['-h', 'localhost'] }, { argv: ['-h', 'localhost'], env: { PGSERVICE: 'fixture_svc' } }],
    [
      'PGHOST when no host is given',
      { argv: ['app_dev'], env: { PGHOST: '/tmp/pgfix' } },
      { argv: ['app_dev'], env: { PGHOST: REMOTE } },
    ],
    [
      'an explicit host, which PGHOST does not override',
      { argv: ['-h', 'localhost'], env: { PGHOST: REMOTE } },
      { argv: [], env: { PGHOST: REMOTE } },
    ],
    [
      'an empty host, which falls back to PGHOST',
      { argv: ['-h', ''], env: { PGHOST: '/tmp/pgfix' } },
      { argv: ['-h', ''], env: { PGHOST: REMOTE } },
    ],
    [
      'no host at all, which leaves the choice to pg_wrapper unless PGHOST is set',
      { argv: ['app_dev'], env: { PGHOST: '/var/run/postgresql' } },
      { argv: ['app_dev'] },
    ],
    [
      'a psqlrc in the home directory, which may \\connect elsewhere',
      { argv: ['-X', '-h', 'localhost'], dirs: { [HOME]: ['.psqlrc-15'] } },
      { argv: ['-h', 'localhost'], dirs: { [HOME]: ['.psqlrc-15'] } },
    ],
    [
      'the system psqlrc',
      { argv: ['--no-psqlrc', '-h', 'localhost'], dirs: { '/etc/postgresql-common': ['psqlrc'] } },
      { argv: ['-h', 'localhost'], dirs: { '/etc/postgresql-common': ['psqlrc'] } },
    ],
    [
      'a home directory that cannot be listed, which may hold a psqlrc',
      { argv: ['-h', 'localhost'], dirs: { [HOME]: [] } },
      { argv: ['-h', 'localhost'], dirs: { [HOME]: null } },
    ],
    [
      'PSQLRC',
      { argv: ['-X', '-h', 'localhost'], env: { PSQLRC: '/tmp/rc' } },
      { argv: ['-h', 'localhost'], env: { PSQLRC: '/tmp/rc' } },
    ],
    [
      'PGSYSCONFDIR',
      { argv: ['-X', '-h', 'localhost'], env: { PGSYSCONFDIR: '/tmp/etc' } },
      { argv: ['-h', 'localhost'], env: { PGSYSCONFDIR: '/tmp/etc' } },
    ],
  ])('%s', (_name, local, notLocal) => {
    expect([isLocal(local), isLocal(notLocal)]).toEqual([true, false]);
  });
});

describe.skipIf(!Bun.which('bun'))('psql recorder', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'psql-record-'));
    allowWritesTo(dir);
    fs.mkdirSync(path.join(dir, 'ledger'));
    fs.writeFileSync(path.join(dir, 'ledger', 'enabled'), '');
    fs.writeFileSync(path.join(dir, 'psql-real'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  });
  afterEach(() => {
    resetHermeticityAllowances();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function record(args: string[], stdin?: string): void {
    const bun = Bun.which('bun')!;
    allowSubprocess([bun]);
    const proc = Bun.spawnSync([bun, path.join(import.meta.dir, 'psql-record.ts'), ...args], {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: dir,
        NANOCLAW_PSQL_REAL: path.join(dir, 'psql-real'),
        NANOCLAW_SOURCE_LEDGER: path.join(dir, 'ledger', 'ledger.jsonl'),
      },
      ...(stdin === undefined ? {} : { stdin: Buffer.from(stdin) }),
    });
    expect(proc.exitCode).toBe(0);
  }

  const recorded = (): string[] => {
    const file = path.join(dir, 'ledger', 'ledger.jsonl');
    if (!fs.existsSync(file)) return [];
    return fs
      .readFileSync(file, 'utf8')
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as { tables: string[] }).tables.join(','));
  };

  it('skips a local read only when every command goes to the server as written', () => {
    const script = path.join(dir, 'plain.sql');
    fs.writeFileSync(script, 'select col::text from app.weekly;\n');
    record(['-X', '-h', '127.0.0.1', '-c', 'select * from app.local_only', '-c', 'select col::text from app.t']);
    // psql interprets a backslash command, a script and stdin itself, and each can switch server: \c, \e, a variable.
    record(['-X', '-h', '127.0.0.1', '-c', `\\c app_dev ${REMOTE}`, '-c', 'select * from app.after_connect']);
    record(['-X', '-h', '127.0.0.1', '-f', script, '-c', 'select * from app.beside_script']);
    record(['-X', '-h', '127.0.0.1'], 'select * from app.weekly;\n');
    record(['-X', '-h', REMOTE, '-c', 'select * from app.remote']);
    // A script names no tables, so the stdin call shows as an entry with none.
    expect(recorded()).toEqual(['app.after_connect', 'app.beside_script', '', 'app.remote']);
  });
});
