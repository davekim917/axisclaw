/**
 * The ledger from both ends: the TypeScript reader, and the real Python tap and `gws`/`psql` shims that write it from other
 * processes. The Python cases run a real interpreter against a stub connector package shaped like the real one
 * (`SnowflakeCursorBase.execute` in `snowflake.connector.cursor`, an async twin in `snowflake.connector.aio._cursor`).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { recordSourceCall } from './remote-mcp-bridge.js';
import {
  appendLedgerEntry,
  discardUncredited,
  ledgerPath,
  setSourceRecording,
  takeUncredited,
} from './source-ledger.js';
import { summarizeSources } from './turn-sources.js';
import {
  allowSubprocess,
  allowWritesTo,
  clearHermeticityAttempts,
  resetHermeticityAllowances,
} from './test-hermeticity.js';

const TAPS_DIR = path.resolve(import.meta.dir, '../../source-taps');
const TS = '2026-11-03T14:02:00.000Z';

let root: string;
let priorLedger: string | undefined;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'source-ledger-'));
  priorLedger = process.env.NANOCLAW_SOURCE_LEDGER;
});

afterAll(() => {
  if (priorLedger === undefined) delete process.env.NANOCLAW_SOURCE_LEDGER;
  else process.env.NANOCLAW_SOURCE_LEDGER = priorLedger;
  fs.rmSync(root, { recursive: true, force: true });
});

let caseDir: string;
beforeEach(() => {
  caseDir = fs.mkdtempSync(path.join(root, 'case-'));
  allowWritesTo(caseDir);
  process.env.NANOCLAW_SOURCE_LEDGER = path.join(caseDir, 'ledger', 'ledger.jsonl');
  setSourceRecording(true);
});

afterEach(() => {
  clearHermeticityAttempts();
  resetHermeticityAllowances();
});

describe('ledger cursor', () => {
  it('hands each entry to exactly one take', () => {
    appendLedgerEntry({ v: 1, ts: TS, recorder: 'snowflake', sql: 'select 1 from a.t', ok: true });
    expect(takeUncredited()).toHaveLength(1);
    expect(takeUncredited()).toHaveLength(0);
    appendLedgerEntry({ v: 1, ts: TS, recorder: 'snowflake', sql: 'select 2 from a.t', ok: true });
    expect(takeUncredited().map((e) => (e.recorder === 'snowflake' ? e.sql : ''))).toEqual(['select 2 from a.t']);
  });

  it('discard drops what no reply took', () => {
    appendLedgerEntry({ v: 1, ts: TS, recorder: 'snowflake', sql: 'select 1 from a.t', ok: true });
    discardUncredited();
    expect(takeUncredited()).toHaveLength(0);
  });

  it('leaves a half-written line for the next take', () => {
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    const line = JSON.stringify({ v: 1, ts: TS, recorder: 'snowflake', sql: 'select 1 from a.t', ok: true });
    fs.writeFileSync(ledgerPath(), line.slice(0, 10));
    expect(takeUncredited()).toHaveLength(0);
    fs.writeFileSync(ledgerPath(), `${line}\n`);
    expect(takeUncredited()).toHaveLength(1);
  });

  it('skips malformed and foreign lines', () => {
    fs.mkdirSync(path.dirname(ledgerPath()), { recursive: true });
    fs.writeFileSync(
      ledgerPath(),
      ['not json', '{"v":2,"ts":"x","recorder":"snowflake","sql":"s","ok":true}', '{"v":1,"recorder":"gws"}', ''].join(
        '\n',
      ),
    );
    expect(takeUncredited()).toEqual([]);
  });

  it('records nothing in a container whose group left the footer off', () => {
    setSourceRecording(false);
    appendLedgerEntry({ v: 1, ts: TS, recorder: 'snowflake', sql: 'select 1 from a.t', ok: true });
    recordSourceCall(
      { server: 'looker', origin: 'https://acme.looker.example' },
      { name: 'query', arguments: { model: 'm', explore: 'e' } },
      false,
    );
    expect(fs.existsSync(ledgerPath())).toBe(false);
  });

  it('answers empty when no recorder ever wrote', () => {
    expect(takeUncredited()).toEqual([]);
    expect(() => discardUncredited()).not.toThrow();
  });

  it('never throws when the ledger path is not a readable file', () => {
    fs.mkdirSync(ledgerPath(), { recursive: true });
    expect(takeUncredited()).toEqual([]);
    expect(() => discardUncredited()).not.toThrow();
  });

  const cursorDbPath = (): string => path.join(path.dirname(ledgerPath()), 'cursor.db');

  it('hands nothing out while another consumer holds the cursor, and keeps the entries', () => {
    appendLedgerEntry({ v: 1, ts: TS, recorder: 'snowflake', sql: 'select 1 from a.t', ok: true });
    expect(takeUncredited()).toHaveLength(1);
    appendLedgerEntry({ v: 1, ts: TS, recorder: 'snowflake', sql: 'select 2 from a.t', ok: true });
    const other = new Database(cursorDbPath());
    other.exec('BEGIN IMMEDIATE');
    expect(takeUncredited()).toEqual([]);
    other.exec('COMMIT');
    other.close();
    expect(takeUncredited()).toHaveLength(1);
  });

  it('a consumer that dies holding the cursor releases it with its process', () => {
    appendLedgerEntry({ v: 1, ts: TS, recorder: 'snowflake', sql: 'select 1 from a.t', ok: true });
    expect(takeUncredited()).toHaveLength(1);
    appendLedgerEntry({ v: 1, ts: TS, recorder: 'snowflake', sql: 'select 2 from a.t', ok: true });
    const bun = process.execPath;
    allowSubprocess([bun]);
    const died = Bun.spawnSync([
      bun,
      '-e',
      `const { Database } = require('bun:sqlite'); const db = new Database(${JSON.stringify(cursorDbPath())}); db.exec('BEGIN IMMEDIATE'); process.exit(9);`,
    ]);
    expect(died.exitCode).toBe(9);
    expect(takeUncredited()).toHaveLength(1);
  });

  it('consumes nothing with recording off', () => {
    appendLedgerEntry({ v: 1, ts: TS, recorder: 'snowflake', sql: 'select 1 from a.t', ok: true });
    setSourceRecording(false);
    expect(takeUncredited()).toEqual([]);
    expect(fs.existsSync(path.join(path.dirname(ledgerPath()), 'cursor.db'))).toBe(false);
  });
});

describe('MCP bridge recorder', () => {
  it('records a Looker call with the instance it reached, its arguments and outcome', () => {
    recordSourceCall(
      { server: 'looker', origin: 'https://acme.looker.example' },
      { name: 'query', arguments: { model: 'm', explore: 'e' } },
      false,
    );
    recordSourceCall(
      { server: 'looker', origin: 'https://acme.looker.example' },
      { name: 'run_look', arguments: { look_id: '7' } },
      true,
    );
    const entries = takeUncredited();
    expect(entries).toMatchObject([
      {
        recorder: 'mcp',
        server: 'looker',
        origin: 'https://acme.looker.example',
        tool: 'query',
        args: { model: 'm', explore: 'e' },
        ok: true,
      },
      { recorder: 'mcp', server: 'looker', tool: 'run_look', ok: false },
    ]);
  });
});

function writeStubConnector(site: string): void {
  const pkg = path.join(site, 'snowflake', 'connector');
  fs.mkdirSync(path.join(pkg, 'aio'), { recursive: true });
  fs.writeFileSync(path.join(site, 'snowflake', '__init__.py'), '');
  fs.writeFileSync(
    path.join(pkg, '__init__.py'),
    'from .cursor import SnowflakeCursor, DictCursor\n\ndef connect(**kw):\n    return Conn()\n\nclass Conn:\n    def cursor(self, cls=SnowflakeCursor):\n        return cls()\n',
  );
  fs.writeFileSync(
    path.join(pkg, 'cursor.py'),
    [
      'class SnowflakeCursorBase:',
      '    def execute(self, command, params=None, timeout=None, _exec_async=False, **kw):',
      "        if 'boom' in command:",
      "            raise RuntimeError('SQL compilation error')",
      '        return self',
      '    def describe(self, command, *args, **kwargs):',
      "        kwargs['_describe_only'] = True",
      '        return self.execute(command, *args, **kwargs)',
      '    def execute_async(self, *args, **kwargs):',
      "        kwargs['_exec_async'] = True",
      '        return self.execute(*args, **kwargs)',
      'class SnowflakeCursor(SnowflakeCursorBase):',
      '    pass',
      'class DictCursor(SnowflakeCursorBase):',
      '    pass',
      '',
    ].join('\n'),
  );
  fs.writeFileSync(path.join(pkg, 'aio', '__init__.py'), '');
  fs.writeFileSync(
    path.join(pkg, 'aio', '_cursor.py'),
    'from ..cursor import SnowflakeCursorBase as _Sync\n\nclass SnowflakeCursorBase(_Sync):\n    async def execute(self, command, *a, **kw):\n        return self\n',
  );
}

const LONG_SELECT_LIST = Array.from({ length: 30_000 }, (_, i) => `c${i}`).join(', ');

const SCRIPT = [
  'import asyncio, sys',
  'import snowflake.connector as sc',
  'from snowflake.connector import DictCursor',
  'from snowflake.connector.aio._cursor import SnowflakeCursorBase as AsyncCursor',
  'con = sc.connect()',
  "con.cursor().execute('select * from acme.analytics.fct_orders o join acme.analytics.dim_customer c on o.cid = c.id')",
  "con.cursor(DictCursor).execute(command='SELECT region FROM acme.analytics.dim_region')",
  "con.cursor().execute_async('select count(*) from acme.analytics.fct_visits')",
  "con.cursor().execute('insert into acme.scratch.t values (1)')",
  "con.cursor().execute('use warehouse w; select * from acme.analytics.fct_batch', num_statements=2)",
  "con.cursor().execute('/* units; dollars */ select * from acme.analytics.fct_commented')",
  'con.cursor().execute("insert into acme.scratch.t values (\'x; select * from acme.analytics.not_read\')")',
  "con.cursor().describe('select * from acme.analytics.dim_described')",
  'try:',
  "    con.cursor().execute('select boom from acme.analytics.fct_orders')",
  'except RuntimeError:',
  '    pass',
  "asyncio.run(AsyncCursor().execute('select * from acme.analytics.fct_async'))",
  `con.cursor().execute('select ${LONG_SELECT_LIST} from acme.analytics.fct_wide')`,
  "print('rows: 42')",
  "print('warning: slow warehouse', file=sys.stderr)",
  'sys.exit(3)',
  '',
].join('\n');

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], env: Record<string, string>, opts: { stdin?: Buffer; cwd?: string } = {}): Run {
  allowSubprocess([args[0]]);
  const proc = Bun.spawnSync(args, {
    env: { PATH: process.env.PATH ?? '', ...env },
    stderr: 'pipe',
    stdout: 'pipe',
    ...(opts.stdin ? { stdin: opts.stdin } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  return { code: proc.exitCode ?? -1, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() };
}

const SCRIPT_OUTPUT: Run = { code: 3, stdout: 'rows: 42\n', stderr: 'warning: slow warehouse\n' };

const python = Bun.which('python3');

/**
 * A venv holding the stub connector and the shipped .pth, pointed at `tapDir`: the .pth in an interpreter's own site
 * dir is how the image loads the tap.
 */
function makeVenv(dir: string, tapDir: string): string {
  allowSubprocess([python!]);
  const made = Bun.spawnSync([python!, '-m', 'venv', '--without-pip', dir], { stderr: 'pipe' });
  expect(made.exitCode).toBe(0);
  const venvPython = path.join(dir, 'bin', 'python');
  allowSubprocess([venvPython]);
  const purelib = Bun.spawnSync([venvPython, '-c', 'import sysconfig; print(sysconfig.get_paths()["purelib"])'])
    .stdout.toString()
    .trim();
  writeStubConnector(purelib);
  const shipped = fs.readFileSync(path.join(TAPS_DIR, 'python', 'nanoclaw-source-tap.pth'), 'utf8');
  expect(shipped.split('\n')[0]).toBe('/opt/nanoclaw-sources/python');
  fs.writeFileSync(
    path.join(purelib, 'nanoclaw-source-tap.pth'),
    shipped.replace('/opt/nanoclaw-sources/python', tapDir),
  );
  return venvPython;
}

describe.skipIf(!python)('Python Snowflake tap', () => {
  let venvPython: string;
  let plainSite: string;
  let script: string;
  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(root, 'py-'));
    allowWritesTo(dir);
    venvPython = makeVenv(path.join(dir, 'venv'), path.join(TAPS_DIR, 'python'));
    plainSite = path.join(dir, 'plain-site');
    writeStubConnector(plainSite);
    script = path.join(dir, 'report.py');
    fs.writeFileSync(script, SCRIPT);
  });

  /** The same script on an interpreter with the stub connector and no tap at all. */
  const baseline = (): Run => run([python!, script], { PYTHONPATH: plainSite });

  const expectRecorded = (): void => {
    const entries = takeUncredited();
    expect(
      entries.map((e) => (e.recorder === 'snowflake' ? [e.sql.slice(0, 22), e.ok, e.truncated ?? null] : null)),
    ).toEqual([
      ['select * from acme.ana', true, false],
      ['SELECT region FROM acm', true, false],
      ['select count(*) from a', true, false],
      ['use warehouse w; selec', true, false],
      ['/* units; dollars */ s', true, false],
      ['select boom from acme.', false, false],
      ['select * from acme.ana', true, false],
      ['select c0, c1, c2, c3,', true, true],
    ]);
    expect(summarizeSources(entries)?.systems).toEqual([
      {
        system: 'snowflake',
        calls: 7,
        lastAt: expect.any(String),
        objects: [
          { kind: 'table', name: 'acme.analytics.fct_orders' },
          { kind: 'table', name: 'acme.analytics.dim_customer' },
          { kind: 'table', name: 'acme.analytics.dim_region' },
          { kind: 'table', name: 'acme.analytics.fct_visits' },
          { kind: 'table', name: 'acme.analytics.fct_batch' },
          { kind: 'table', name: 'acme.analytics.fct_commented' },
          { kind: 'table', name: 'acme.analytics.fct_async' },
        ],
      },
    ]);
  };

  it('records every read a script runs through the connector, and the output is unchanged', () => {
    expect(baseline()).toEqual(SCRIPT_OUTPUT);
    expect(run([venvPython, script], { NANOCLAW_SOURCE_LEDGER: ledgerPath() })).toEqual(SCRIPT_OUTPUT);
    expectRecorded();
  });

  it('records under `python -I`, which drops the environment', () => {
    // -I ignores NANOCLAW_SOURCE_LEDGER, so the copied tap's default path points at this case.
    const tapCopy = path.join(caseDir, 'tap');
    fs.mkdirSync(tapCopy);
    for (const file of ['nanoclaw_source_tap.py', 'nanoclaw_source_tap_impl.py']) {
      fs.writeFileSync(
        path.join(tapCopy, file),
        fs
          .readFileSync(path.join(TAPS_DIR, 'python', file), 'utf8')
          .replace('"/tmp/nanoclaw-sources/ledger.jsonl"', JSON.stringify(ledgerPath())),
      );
    }
    const isolated = makeVenv(path.join(caseDir, 'venv'), tapCopy);
    expect(run([isolated, '-I', script], {})).toEqual(SCRIPT_OUTPUT);
    expectRecorded();
  });

  it('is a pass-through with the footer off: same output, cursor unpatched, nothing written', () => {
    setSourceRecording(false);
    expect(run([venvPython, script], { NANOCLAW_SOURCE_LEDGER: ledgerPath() })).toEqual(baseline());
    expect(fs.existsSync(ledgerPath())).toBe(false);

    const probe = path.join(caseDir, 'probe.py');
    fs.writeFileSync(
      probe,
      'import sys, snowflake.connector.cursor as c\nprint(getattr(c.SnowflakeCursorBase.execute, "__nanoclaw_source_tap__", False))\nprint("nanoclaw_source_tap_impl" in sys.modules)\n',
    );
    expect(run([venvPython, probe], { NANOCLAW_SOURCE_LEDGER: ledgerPath() }).stdout).toBe('False\nFalse\n');
  });

  it('leaves the script unchanged when the ledger cannot be written', () => {
    // The ledger path is a directory: the marker says record, and every write fails.
    fs.mkdirSync(ledgerPath(), { recursive: true });
    expect(run([venvPython, script], { NANOCLAW_SOURCE_LEDGER: ledgerPath() })).toEqual(baseline());
  });
});

const node = Bun.which('node');

describe.skipIf(!node)('gws shim', () => {
  function fakeGws(exitCode: number): string {
    const bin = path.join(caseDir, 'gws-real');
    fs.writeFileSync(bin, `#!/bin/sh\necho "real:$*"\necho "stderr:$#" >&2\nexit ${exitCode}\n`, { mode: 0o755 });
    return bin;
  }

  function runShim(args: string[], real: string): Run {
    return run(['/bin/sh', path.join(TAPS_DIR, 'gws-shim.sh'), ...args], {
      NANOCLAW_GWS_REAL: real,
      NANOCLAW_GWS_RECORDER: path.join(TAPS_DIR, 'gws-record.mjs'),
      NANOCLAW_SOURCE_LEDGER: ledgerPath(),
    });
  }

  const SHEETS_READ = ['sheets', '+read', '--spreadsheet', 'SHEET_ID_123', '--range', 'Summary!A2:F90'];

  it('passes output and exit status through unchanged, and records a Sheets read', () => {
    const real = fakeGws(0);
    expect(runShim(SHEETS_READ, real)).toEqual(run([real, ...SHEETS_READ], {}));
    const entries = takeUncredited();
    expect(entries).toMatchObject([{ recorder: 'gws', argv: SHEETS_READ, ok: true }]);
    expect(summarizeSources(entries)?.systems[0]).toMatchObject({ system: 'sheets', calls: 1 });
  });

  it('records a failed Sheets call as failed and keeps its exit status', () => {
    const real = fakeGws(3);
    expect(runShim(SHEETS_READ, real)).toEqual(run([real, ...SHEETS_READ], {}));
    expect(takeUncredited()).toMatchObject([{ recorder: 'gws', ok: false }]);
  });

  it('records a Sheets read behind a global option', () => {
    const real = fakeGws(0);
    const args = ['--api-version', 'v4', ...SHEETS_READ];
    expect(runShim(args, real)).toEqual(run([real, ...args], {}));
    expect(summarizeSources(takeUncredited())?.systems[0]).toMatchObject({ system: 'sheets', calls: 1 });
  });

  it('records nothing for a non-Sheets command', () => {
    const real = fakeGws(0);
    const args = ['gmail', 'users', 'messages', 'list'];
    expect(runShim(args, real)).toEqual(run([real, ...args], {}));
    expect(takeUncredited()).toEqual([]);
  });

  it('execs the real binary untouched with the footer off', () => {
    setSourceRecording(false);
    const real = fakeGws(2);
    expect(runShim(SHEETS_READ, real)).toEqual(run([real, ...SHEETS_READ], {}));
    expect(fs.existsSync(ledgerPath())).toBe(false);
  });

  it('leaves the command unchanged when the ledger cannot be written', () => {
    const real = fakeGws(0);
    fs.mkdirSync(ledgerPath(), { recursive: true });
    expect(runShim(SHEETS_READ, real)).toEqual(run([real, ...SHEETS_READ], {}));
  });
});

describe.skipIf(!Bun.which('bun'))('psql shim', () => {
  /**
   * Stands in for psql: echoes its arguments, any `/dev/fd` file it names, its stdin when asked to read a script, and
   * one env var; then exits with `exitCode` or dies of `FAKE_SIGNAL`.
   */
  function fakePsql(exitCode: number): string {
    const bin = path.join(caseDir, 'psql-real');
    fs.writeFileSync(
      bin,
      [
        '#!/bin/sh',
        `printf 'arg:%s\\n' "$@"`,
        'for a in "$@"; do case "$a" in /dev/fd/*) cat "$a" ;; esac; done',
        'echo "pw:${PGPASSWORD-unset}"',
        'if [ -n "$PGPASSFILE" ]; then cat "$PGPASSFILE"; fi',
        'if [ "$FAKE_READS_STDIN" = 1 ]; then cat; fi',
        'echo "stderr:$#" >&2',
        'if [ -n "$FAKE_SIGNAL" ]; then kill -s "$FAKE_SIGNAL" $$; fi',
        `exit ${exitCode}`,
        '',
      ].join('\n'),
      { mode: 0o755 },
    );
    return bin;
  }

  function runShim(
    args: string[],
    real: string,
    opts: { stdin?: Buffer; cwd?: string; env?: Record<string, string> } = {},
  ): Run {
    return run(
      ['/bin/sh', path.join(TAPS_DIR, 'psql-shim.sh'), ...args],
      {
        NANOCLAW_PSQL_REAL: real,
        NANOCLAW_PSQL_RECORDER: path.join(import.meta.dir, 'psql-record.ts'),
        NANOCLAW_SOURCE_LEDGER: ledgerPath(),
        ...opts.env,
      },
      opts,
    );
  }

  function runReal(
    args: string[],
    real: string,
    opts: { stdin?: Buffer; cwd?: string; env?: Record<string, string> } = {},
  ): Run {
    return run([real, ...args], { ...opts.env }, opts);
  }

  const ledgerText = (): string => (fs.existsSync(ledgerPath()) ? fs.readFileSync(ledgerPath(), 'utf8') : '');

  it('passes output and exit status through unchanged, and records a read with its database', () => {
    const real = fakePsql(0);
    const args = ['-XAtc', 'select count(*) from public.orders', 'app_dev'];
    expect(runShim(args, real)).toEqual(runReal(args, real));
    const entries = takeUncredited();
    expect(entries).toMatchObject([{ recorder: 'postgres', database: 'app_dev', tables: ['public.orders'], ok: true }]);
    expect(summarizeSources(entries)?.systems).toEqual([
      {
        system: 'postgres',
        calls: 1,
        lastAt: entries[0].ts,
        objects: [{ kind: 'table', name: 'public.orders', database: 'app_dev' }],
      },
    ]);
  });

  const PASSWORD = 'Pw9-xQ7tr/Zk';
  const USER = 'zz_reader_role';
  const HOST = 'fixture.pg-7f3a.example';
  const URL = `postgres://${USER}:${encodeURIComponent(PASSWORD)}@${HOST}:6543/app_dev?sslmode=require`;
  const RAW_URL = `postgresql://${USER}:${PASSWORD}@${HOST}/app_dev`;
  const CONNINFO = `host=${HOST} port=6543 user=${USER} password='${PASSWORD}' dbname=app_dev`;
  const SECRET_PARTS = [PASSWORD, encodeURIComponent(PASSWORD), 'Pw9-xQ7tr', 'Zk', USER, HOST, '6543', 'sslmode'];

  it.each([
    ['a URI with the password inline', [URL, '-c', 'select * from public.orders']],
    ['a raw URI whose password holds a slash', [RAW_URL, '-c', 'select * from public.orders']],
    ['a conninfo string', ['-d', CONNINFO, '-c', 'select * from public.orders']],
    [
      'separate host and user options',
      ['-h', HOST, '-p', '6543', '-U', USER, '-c', 'select * from public.orders', 'app_dev'],
    ],
    ['a script that reconnects with a URI', [URL, '-c', `\\c ${RAW_URL}`, '-c', 'select * from public.orders']],
    ['a secret inside the SQL', [URL, '-c', `select * from public.orders where note <> '${PASSWORD}' -- ${USER}`]],
  ])('never stores, sends or renders any part of the connection: %s', (_name, args) => {
    const real = fakePsql(0);
    const out = runShim(args, real, { env: { PGPASSWORD: PASSWORD } });
    expect(out).toEqual(runReal(args, real, { env: { PGPASSWORD: PASSWORD } }));
    const stored = ledgerText();
    const sent = JSON.stringify(summarizeSources(takeUncredited()));
    expect(stored).toContain('public.orders');
    for (const part of SECRET_PARTS) {
      expect(stored).not.toContain(part);
      expect(sent).not.toContain(part);
    }
  });

  it('counts a read from a script file with its database, naming tables only from -c', () => {
    const real = fakePsql(0);
    const file = path.join(caseDir, 'q.sql');
    fs.writeFileSync(file, '-- weekly\nselect * from app.weekly_sales;\n');
    const args = ['-d', 'app_dev', '-f', file, '-c', 'select * from app.named_t'];
    expect(runShim(args, real)).toEqual(runReal(args, real));
    expect(takeUncredited()).toMatchObject([{ recorder: 'postgres', database: 'app_dev', tables: ['app.named_t'] }]);
    fs.writeFileSync(file, 'insert into app.t values (1);\n');
    runShim(['-d', 'app_dev', '-f', file], real);
    expect(takeUncredited()).toEqual([]);
  });

  it('counts a heredoc read on stdin, names no table from it, and hands psql the same bytes', () => {
    const real = fakePsql(0);
    const stdin = Buffer.from('\\set ON_ERROR_STOP on\nselect * from app.events where kind = $$a;b$$;\n');
    const opts = { stdin, env: { FAKE_READS_STDIN: '1' } };
    expect(runShim(['app_dev'], real, opts)).toEqual(runReal(['app_dev'], real, opts));
    expect(takeUncredited()).toMatchObject([{ recorder: 'postgres', database: 'app_dev', tables: [] }]);
  });

  it('streams a script larger than the parse cap through untouched, counting it but naming nothing', () => {
    const real = fakePsql(0);
    const stdin = Buffer.from(`select * from app.big_t;\n${'-- padding line\n'.repeat(200_000)}`);
    const opts = { stdin, env: { FAKE_READS_STDIN: '1' } };
    expect(runShim([], real, opts)).toEqual(runReal([], real, opts));
    expect(takeUncredited()).toMatchObject([{ recorder: 'postgres', tables: [], ok: true }]);
  });

  it('records a failed call as failed, keeps its exit status, and stores no database or table for it', () => {
    const real = fakePsql(2);
    // `-W` takes no value, so psql reads the password typed after it as the database.
    const args = ['-h', 'fixture.pghost.example', '-W', 'pwSegA', '-c', 'select * from app.t'];
    expect(runShim(args, real)).toEqual(runReal(args, real));
    expect(ledgerText()).not.toContain('pwSegA');
    expect(takeUncredited()).toEqual([expect.objectContaining({ recorder: 'postgres', tables: [], ok: false })]);
  });

  it('forwards a SIGINT sent to the wrapper itself', () => {
    const script = path.join(caseDir, 'sigint.sh');
    // psql stand-in that waits; the wrapper is signalled by pid, as `timeout -s INT` does.
    fs.writeFileSync(path.join(caseDir, 'slow-psql'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 });
    fs.writeFileSync(
      script,
      `"$@" -c 'select * from app.t' & pid=$!\nsleep 1\nkill -INT $pid\nwait $pid\necho "status:$?"\n`,
    );
    const env = {
      NANOCLAW_PSQL_REAL: path.join(caseDir, 'slow-psql'),
      NANOCLAW_PSQL_RECORDER: path.join(import.meta.dir, 'psql-record.ts'),
      NANOCLAW_SOURCE_LEDGER: ledgerPath(),
    };
    const started = Date.now();
    const out = run(['/bin/sh', script, '/bin/sh', path.join(TAPS_DIR, 'psql-shim.sh')], env);
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(out.stdout).toContain('status:130');
  });

  it('names no database when any script switches database, even in a separate -c', () => {
    const real = fakePsql(0);
    const args = ['-d', 'app_dev', '-c', '\\c other_db', '-c', 'select * from public.orders'];
    expect(runShim(args, real)).toEqual(runReal(args, real));
    const [entry] = takeUncredited();
    expect(entry).toMatchObject({ recorder: 'postgres', tables: ['public.orders'] });
    expect(entry).not.toHaveProperty('database');
  });

  it('dies of the signal that killed psql, and reports SIGPIPE as the shell would', () => {
    const real = fakePsql(0);
    const args = ['-c', 'select * from app.t'];
    const term = { env: { FAKE_SIGNAL: 'TERM' } };
    expect(runShim(args, real, term)).toEqual(runReal(args, real, term));
    const pipe = runShim(args, real, { env: { FAKE_SIGNAL: 'PIPE' } });
    expect(pipe).toEqual({ ...runReal(args, real, { env: { FAKE_SIGNAL: 'PIPE' } }), code: 141 });
  });

  it('never names a password psql reads from a stdin script, at the first prompt or a reconnect', () => {
    const real = fakePsql(0);
    for (const [args, script] of [
      [['-W', '-d', 'app_dev'], 'select * from pwSegA;\nselect * from app.orders;\n'],
      [['-d', 'app_dev'], 'table"pwSegB"\nselect * from app.orders;\n'],
      [['-d', 'app_dev'], "pwSeg'C\nselect 1 where a = '; select * from pwSegD; ';\n"],
      [['-W', '-d', 'app_dev'], 'first_pw\n\\connect other_db\nselect * from pwSegE;\nselect * from app.orders;\n'],
    ] as const) {
      const opts = { stdin: Buffer.from(script), env: { FAKE_READS_STDIN: '1' } };
      expect(runShim([...args], real, opts)).toEqual(runReal([...args], real, opts));
    }
    expect(ledgerText().toLowerCase()).not.toContain('pwseg');
  });

  it('hands psql a descriptor named only in its environment', () => {
    const real = fakePsql(0);
    const script = path.join(caseDir, 'passfile.sh');
    fs.writeFileSync(path.join(caseDir, 'pgpass'), 'fixture.pghost.example:5432:app_dev:zz_reader:pwSegA\n');
    fs.writeFileSync(
      script,
      `PGPASSFILE=/dev/fd/7 "$@" -c 'select * from app.t' 7< "${path.join(caseDir, 'pgpass')}"\n`,
    );
    const env = {
      NANOCLAW_PSQL_REAL: real,
      NANOCLAW_PSQL_RECORDER: path.join(import.meta.dir, 'psql-record.ts'),
      NANOCLAW_SOURCE_LEDGER: ledgerPath(),
    };
    const viaShim = run(['/bin/sh', script, '/bin/sh', path.join(TAPS_DIR, 'psql-shim.sh')], env);
    expect(viaShim).toEqual(run(['/bin/sh', script, real], {}));
    expect(viaShim.stdout).toContain('app_dev:zz_reader');
    expect(ledgerText()).not.toContain('pwSegA');
  });

  it('hands psql a descriptor its command line names, as process substitution does', () => {
    const real = fakePsql(0);
    const script = path.join(caseDir, 'procsub.sh');
    fs.writeFileSync(script, `"$@" -f /dev/fd/7 7< "${path.join(caseDir, 'q.sql')}"\n`);
    fs.writeFileSync(path.join(caseDir, 'q.sql'), 'select * from app.from_fd;\n');
    const env = {
      NANOCLAW_PSQL_REAL: real,
      NANOCLAW_PSQL_RECORDER: path.join(import.meta.dir, 'psql-record.ts'),
      NANOCLAW_SOURCE_LEDGER: ledgerPath(),
    };
    const viaShim = run(['/bin/sh', script, '/bin/sh', path.join(TAPS_DIR, 'psql-shim.sh')], env);
    expect(viaShim).toEqual(run(['/bin/sh', script, real], {}));
    expect(viaShim.stdout).toContain('select * from app.from_fd;');
  });

  it('records nothing for a write, a catalog lookup or a database list', () => {
    const real = fakePsql(0);
    for (const args of [
      ['-c', 'insert into app.t values (1)', 'app_dev'],
      ['-c', 'select * from information_schema.tables', 'app_dev'],
      ['-l'],
    ]) {
      expect(runShim(args, real)).toEqual(runReal(args, real));
    }
    expect(takeUncredited()).toEqual([]);
  });

  it("keeps the caller's environment and loads nothing from its directory", () => {
    const real = fakePsql(0);
    fs.writeFileSync(path.join(caseDir, '.env'), 'PGPASSWORD=from-dotenv\n');
    fs.writeFileSync(path.join(caseDir, 'bunfig.toml'), 'preload = ["./pre.ts"]\n');
    fs.writeFileSync(path.join(caseDir, 'pre.ts'), 'console.log("preload ran")\n');
    const args = ['-c', 'select * from app.t'];
    const out = runShim(args, real, { cwd: caseDir });
    expect(out).toEqual(runReal(args, real, { cwd: caseDir }));
    expect(out.stdout).toContain('pw:unset');
  });

  it('names no database when a script was not read to its end, since a \\c may sit past the cut', () => {
    const real = fakePsql(0);
    const file = path.join(caseDir, 'big.sql');
    fs.writeFileSync(file, `${'-- padding line\n'.repeat(80_000)}\\connect other_db\n`);
    const args = ['-d', 'app_dev', '-f', file, '-c', 'select * from app.orders'];
    expect(runShim(args, real)).toEqual(runReal(args, real));
    const [entry] = takeUncredited();
    expect(entry).toMatchObject({ recorder: 'postgres', tables: ['app.orders'] });
    expect(entry).not.toHaveProperty('database');
  });

  it('runs psql unrecorded when BUN_OPTIONS could stop the recorder starting', () => {
    const real = fakePsql(0);
    const args = ['-c', 'select * from app.t', 'app_dev'];
    const env = { env: { BUN_OPTIONS: '--preload=/nonexistent-preload.ts' } };
    expect(runShim(args, real, env)).toEqual(runReal(args, real, env));
    expect(takeUncredited()).toEqual([]);
  });

  it('hands psql bytes that are not UTF-8 unchanged, in its arguments and environment', () => {
    const real = fakePsql(0);
    const script = path.join(caseDir, 'latin1.sh');
    // JavaScript strings cannot carry these bytes, so the shell makes them and the output is compared as hex.
    fs.writeFileSync(
      script,
      [
        `PGOPTIONS="$(printf 'x\\351')" "$@" -c "$(printf "select 'caf\\351' from app.t")" | od -An -tx1`,
        // One character cut across two arguments is valid UTF-8 only once they are joined.
        `"$@" -c "select * from app.t" "$(printf 'a\\303')" "$(printf '\\251b')" | od -An -tx1`,
        '',
      ].join('\n'),
    );
    const env = {
      NANOCLAW_PSQL_REAL: real,
      NANOCLAW_PSQL_RECORDER: path.join(import.meta.dir, 'psql-record.ts'),
      NANOCLAW_SOURCE_LEDGER: ledgerPath(),
    };
    const viaShim = run(['/bin/sh', script, '/bin/sh', path.join(TAPS_DIR, 'psql-shim.sh')], env);
    expect(viaShim).toEqual(run(['/bin/sh', script, real], {}));
    expect(viaShim.stdout.replace(/\s+/g, '')).toContain('636166e9');
  });

  it('execs the real binary untouched with the footer off', () => {
    setSourceRecording(false);
    const real = fakePsql(3);
    const args = ['-c', 'select * from app.t', 'app_dev'];
    expect(runShim(args, real)).toEqual(runReal(args, real));
    expect(fs.existsSync(ledgerPath())).toBe(false);
  });

  it('leaves the command unchanged when the ledger cannot be written', () => {
    const real = fakePsql(0);
    fs.mkdirSync(ledgerPath(), { recursive: true });
    const args = ['-c', 'select * from app.t', 'app_dev'];
    expect(runShim(args, real)).toEqual(runReal(args, real));
  });

  it('reports a missing psql the way a shell would, with nothing recorded', () => {
    const out = runShim(['-c', 'select * from app.t'], path.join(caseDir, 'no-such-psql'));
    expect(out.code).toBe(127);
    expect(takeUncredited()).toEqual([]);
  });
});
