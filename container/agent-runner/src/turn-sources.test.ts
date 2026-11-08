import { describe, expect, it } from 'bun:test';

import type { LedgerEntry } from './source-ledger.js';
import { readPostgresSql, readTablesFromSql, summarizeSources } from './turn-sources.js';

const TS = '2026-11-03T14:02:00.000Z';

describe('readTablesFromSql', () => {
  // Expected tables are written by hand from the SQL, not derived from the parser.
  const cases: Array<[string, string, string[] | null]> = [
    ['plain select', 'select * from analytics.fct_orders', ['analytics.fct_orders']],
    [
      'three-part name and alias',
      'SELECT o.id FROM ACME.ANALYTICS.FCT_ORDERS o WHERE o.x = 1',
      ['ACME.ANALYTICS.FCT_ORDERS'],
    ],
    [
      'joins of every flavour',
      'select 1 from a.t1 x left join a.t2 y on x.id = y.id inner join a.t3 using (id) cross join a.t4',
      ['a.t1', 'a.t2', 'a.t3', 'a.t4'],
    ],
    ['comma join', 'select * from a.t1 x, a.t2 as y where x.k = y.k', ['a.t1', 'a.t2']],
    [
      'CTE names are not tables',
      'with recent as (select * from a.orders where d > 1), agg as (select count(*) from recent) select * from agg join a.customers c on true',
      ['a.orders', 'a.customers'],
    ],
    [
      'subquery in FROM',
      'select * from (select id from a.inner_t) s join a.outer_t o on s.id = o.id',
      ['a.inner_t', 'a.outer_t'],
    ],
    ['quoted identifier', 'select * from "My DB"."Sch"."Odd Table"', ['My DB.Sch.Odd Table']],
    ['table name inside a string literal is ignored', "select 'from a.fake' as x from a.real_t", ['a.real_t']],
    ['table name inside comments is ignored', '-- from a.c1\nselect /* join a.c2 */ 1 from a.real_t', ['a.real_t']],
    ['table function is not a table', 'select * from a.t, lateral flatten(input => t.arr)', ['a.t']],
    ['same table twice counts once, case-insensitively', 'select * from a.T union all select * from A.t', ['a.T']],
    ['leading parenthesis', '(select * from a.t)', ['a.t']],
    ['DDL is not a read', 'create or replace table a.t as select * from a.src', null],
    ['DML is not a read', 'insert into a.t select * from a.src', null],
    ['session command is not a read', 'use warehouse wh', null],
    ['SHOW is metadata, not a read', 'show tables in schema a', null],
    [
      'FROM inside an expression is not a table',
      "select extract(year from order_date), trim(both ' ' from name), substring(code from 2) from analytics.orders",
      ['analytics.orders'],
    ],
    ['a subquery inside a function call counts', 'select coalesce((select max(x) from a.orders), 0)', ['a.orders']],
    [
      'subqueries inside expressions still count',
      'select * from a.t where exists (select 1 from a.u where d = extract(year from a.t.d))',
      ['a.t', 'a.u'],
    ],
  ];

  it.each(cases)('%s', (_name, sql, expected) => {
    const read = readTablesFromSql(sql);
    if (expected === null) expect(read).toBeNull();
    else expect(read?.tables).toEqual(expected);
  });

  it.each([
    ['a dynamic table name', 'select * from identifier($tbl)', []],
    ['a select of no table', 'select current_version()', []],
    ['IS DISTINCT FROM is an operator', 'select null is distinct from null', []],
    ['IS NOT DISTINCT FROM is an operator', 'select 1 from a.t where x is not distinct from y', ['a.t']],
    [
      'comment and quote marks inside a quoted name',
      'select * from "tenant--archive".orders, a."order\'s"',
      ['tenant--archive.orders', "a.order's"],
    ],
    ['a quoted CTE name holding a dot is still the CTE', 'with "a.b" as (select 1 as n) select * from "a.b"', []],
    ['a double-dot name is partial and names nothing', 'select * from warehouse_db..orders', []],
    ['a quoted lowercase name is not an unquoted CTE', 'with x as (select 1) select * from "x" join x on true', ['x']],
    [
      'a quoted CTE matches only its exact case',
      'with "Recent" as (select 1) select * from "Recent", recent',
      ['recent'],
    ],
  ])('%s', (_name, sql, expected) => {
    expect(readTablesFromSql(sql)?.tables).toEqual(expected);
  });
});

describe('readPostgresSql', () => {
  // Expected tables are written by hand from the SQL, not derived from the parser; null means the script reads nothing.
  const cases: Array<[string, string, string[] | null]> = [
    [
      'unquoted names fold to lower case, quoted ones are exact',
      'select * from Public.Orders o join "Sales"."Line Items" l on true',
      ['public.orders', 'Sales.Line Items'],
    ],
    ['one name in two cases is one table', 'select * from app.T union all select * from APP.t', ['app.t']],
    ['information_schema is the catalog', "select * from information_schema.columns where table_name = 'x'", null],
    [
      'a join of catalog relations, unqualified pg_ names included, is metadata',
      'select p.proname from pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace',
      null,
    ],
    [
      'catalog joined to data counts, naming the data',
      'select * from app.orders o join pg_class c on c.relname = o.src',
      ['app.orders'],
    ],
    ['a connection probe reads nothing', 'select 1; select current_user, version()', null],
    ['DML is not a read', 'insert into app.t select * from app.src', null],
    ['a data-modifying CTE writes', 'with d as (delete from app.jobs returning *) select * from d', null],
    ['SELECT INTO creates a table', 'select * into app.orders_copy from app.orders', null],
    ['session commands are not reads', "set search_path = app; set statement_timeout = '5s'", null],
    [
      'a script counts when any statement reads data',
      'set statement_timeout = 0; select * from app.a; insert into app.b values (1)',
      ['app.a'],
    ],
    ['block comments nest', '/* outer /* inner */ from app.fake_one */ select * from app.real_t', ['app.real_t']],
    [
      'a tagged dollar quote is a literal',
      'select $body$ x from app.fake_one $body$ as note from app.real_t',
      ['app.real_t'],
    ],
    ['a positional parameter is not a dollar quote', 'select * from app.t where id = $1 and k = $2', ['app.t']],
    [
      'a literal ending in a backslash names only what both string readings agree on',
      "select 'C:\\' as p from app.real_t where q = ' from app.fake_one'",
      [],
    ],
    [
      'a backslash escapes a quote in an E string',
      "select E'it\\'s from app.fake_one' from app.real_t",
      ['app.real_t'],
    ],
    [
      'psql meta-commands are dropped and end the statement before them',
      'select * from app.a \\gx\n\\set ON_ERROR_STOP on\n\\x\nselect * from app.b',
      ['app.a', 'app.b'],
    ],
    [
      'a \\copy of a query is a read',
      "\\copy (select * from app.export_src where d > '2026-01-01') to 'out.csv' csv header\nselect 1",
      ['app.export_src'],
    ],
    ['a \\copy of a table to a file is a read', '\\copy app.events (id, kind) to stdout', ['app.events']],
    ['a \\copy into a table is a write', "\\copy app.events from 'in.csv' csv", null],
    ['COPY TO is a read', 'copy (select * from app.s) to stdout; copy app.t to stdout', ['app.s', 'app.t']],
    ['COPY FROM is a write', 'copy app.t from stdin', null],
    ['TABLE is a read', 'table app.t', ['app.t']],
    [
      'COPY FROM STDIN data is not SQL, even when a row holds a quote',
      "COPY app.t (a, b) FROM stdin;\nO'Brien\tselect * from fake_data_t\n\\.\nselect 1 where n = '; select * from app.fake_two';\nselect * from app.real_t",
      ['app.real_t'],
    ],
    [
      '\\copy FROM STDIN data is not SQL',
      '\\copy app.t from stdin\nselect * from fake_data_t\n\\.\nselect * from app.real_t',
      ['app.real_t'],
    ],
    [
      'ONLY is not a table',
      'select * from only app.orders o join only app.lines l on true',
      ['app.orders', 'app.lines'],
    ],
    [
      'a MATERIALIZED CTE is a CTE',
      'with q as materialized (select * from app.orders), r as not materialized (select 1) select * from q, r',
      ['app.orders'],
    ],
    ['ROWS FROM reads no table', 'select * from rows from (generate_series(1, 3)) g', null],
    [
      'a set-returning function with an alias column list reads nothing',
      'select * from generate_series(1, 3) as g(n)',
      null,
    ],
    ['VALUES reads nothing', 'select * from (values (1), (2)) v(n)', null],
    ['a function then a table counts the table', 'select * from generate_series(1, 3) g(n), app.t', ['app.t']],
    ['a derived table then a comma', 'select * from (select * from app.a) s, app.b', ['app.b', 'app.a']],
    ['a CTE over the catalog is metadata', 'with c as (select * from pg_class) select * from c', null],
    ['UPDATE after CTEs writes', 'with q as (select 1) update app.t set x = 1', null],
    ['DELETE after CTEs writes', 'with q as (select * from app.orders) delete from app.archive using q', null],
    [
      'FOR UPDATE locks without writing',
      'select * from app.jobs for update skip locked; select * from app.runs for no key update',
      ['app.jobs', 'app.runs'],
    ],
    [
      'a dollar quote with a tag past ASCII is a literal',
      'select $é$ from fake_secret $é$ as note from app.orders',
      ['app.orders'],
    ],
    [
      'a long dollar-quote tag is a literal',
      `select $${'t'.repeat(70)}$ from fake_secret $${'t'.repeat(70)}$ from app.orders`,
      ['app.orders'],
    ],
    [
      'statements inside a \\if block may never run',
      '\\if :flag\nselect * from app.maybe;\n\\else\nselect * from app.other;\n\\endif\nselect * from app.always',
      ['app.always'],
    ],
    ['a name past ASCII is one name', 'select * from app.café', ['app.café']],
    [
      'COPY FROM STDIN sent with \\g takes the next lines as data',
      'COPY app.imports FROM STDIN\n\\g\nselect * from pwSegA\n\\.\nselect * from app.orders;',
      ['app.orders'],
    ],
    [
      'COPY data inside a \\if block is data too',
      "\\if :x\nCOPY app.t FROM stdin;\nit's\n\\.\n\\endif\nselect 1 where a = '\n\\endif\nselect * from literal_text_tbl\n';\nselect * from app.after",
      ['app.after'],
    ],
    [
      '\\copy from pstdin reads psql stdin, not the script',
      '\\copy app.t from pstdin\nselect * from app.real_after',
      ['app.real_after'],
    ],
    [
      'with standard strings possibly off, only names both readings agree on count',
      "SET standard_conforming_strings=off;\nSELECT 'x\\' FROM pwSegA ' AS p FROM app.orders;",
      [],
    ],
    [
      'a mention of standard strings alone loses nothing',
      'set standard_conforming_strings = on; select * from app.orders',
      ['app.orders'],
    ],
    ['\\r discards the statement before it', 'select * from app.never\n\\r\nselect * from app.t;', ['app.t']],
    ['\\q ends the script', 'select * from app.a;\n\\q\nselect * from app.never;', ['app.a']],
    ['a schema-qualified function reads no table', 'select * from app.synthetic_rows()', null],
    ['a qualified function then a table', 'select * from app.rows_of(1) r, app.t', ['app.t']],
    ['ONLY with parentheses', 'select * from only (app.orders)', ['app.orders']],
    ['locking aliases are not relations', 'select * from app.jobs a, app.jobs b for update of a, b', ['app.jobs']],
    ['DML words as column names are still a read', 'select insert, update from app.audit_flags', ['app.audit_flags']],
    [
      'a recursive CTE with a CYCLE clause before a DELETE writes',
      'with recursive t(id) as (select 1) cycle id set is_cycle using path delete from app.victims',
      null,
    ],
    [
      'a quoted meta-command argument holds no command',
      "select * from app.orders\n\\echo 'message \\r text'\n\\g",
      ['app.orders'],
    ],
    ['\\q drops the statement it never sent', 'select * from app.never\n\\q', null],
    ['WITH ... TABLE reads the table', 'with q as (select 1) table app.orders', ['app.orders']],
    ['a dollar quote may open right after a number', 'select 1$$ from lit_after_digit $$ from app.t', ['app.t']],
    ['an identifier may hold dollar signs', 'select a1$$ from app.t', ['app.t']],
    ['a dollar quote may open right after another closes', 'select $$a$$$$ from pwSegA $$ from app.t', ['app.t']],
    ['a dollar quote may open right after a parameter', 'select $1$$ from pwSegA $$ from app.t', ['app.t']],
  ];

  it.each(cases)('%s', (_name, sql, expected) => {
    expect(readPostgresSql(sql)).toEqual(
      expected === null
        ? { reads: false, tables: [], connects: false }
        : { reads: true, tables: expected, connects: false },
    );
  });

  it('reads a -c as the server does: a backslash in it is text, unless it opens the command', () => {
    expect(readPostgresSql("select * from app.a where p = 'x' or q ~ '\\\\q'", 'command').tables).toEqual(['app.a']);
    expect(readPostgresSql("\\setenv PGPASSWORD 'first\nselect * from pwSegA;\nlast'", 'command').tables).toEqual([]);
    expect(readPostgresSql("\\copy (select * from app.export_src) to 'out.csv'", 'command')).toEqual({
      reads: true,
      tables: [],
      connects: false,
    });
  });

  it('says when the script switched database, and never reads the connection target', () => {
    expect(
      readPostgresSql('\\c postgres://zz_reader:Pw9xQ7tr@fixture.pghost.example/other_db\nselect * from app.t'),
    ).toEqual({ reads: true, tables: ['app.t'], connects: true });
  });

  it('never names text that only one string reading takes for a table, wherever the other finds it', () => {
    const sql = [
      'SET standard_conforming_strings=off;',
      "SELECT 'x\\' FROM pwSegA ' AS p FROM app.orders; -- '",
      'SET standard_conforming_strings=on;',
      "SELECT 'x\\' AS p FROM app.orders; -- ' FROM pwSegA --",
    ].join('\n');
    const read = readPostgresSql(sql);
    expect(read.reads).toBe(true);
    expect(read.tables.join(' ').toLowerCase()).not.toContain('pwsega');
  });

  it.each([
    ['a reconnect after another meta-command on its line', '\\set quiet on \\connect other_db\nselect * from app.t'],
    ['a reconnect with no space before it', '\\set quiet on\\connect other_db\nselect * from app.t'],
    ['an included file, which may reconnect', '\\i setup.sql\nselect * from app.t'],
  ])('drops the database for %s', (_name, sql) => {
    expect(readPostgresSql(sql)).toEqual({ reads: true, tables: ['app.t'], connects: true });
  });
});

const ORIGIN = 'https://acme.looker.example';
const looker = (tool: string, args: unknown, ok = true, origin: string | null = ORIGIN): LedgerEntry => ({
  v: 1,
  ts: TS,
  recorder: 'mcp',
  server: 'looker',
  ...(origin ? { origin } : {}),
  tool,
  args,
  ok,
});
const snow = (sql: string, ok = true, ts = TS): LedgerEntry => ({ v: 1, ts, recorder: 'snowflake', sql, ok });
const gws = (argv: string[], ok = true): LedgerEntry => ({ v: 1, ts: TS, recorder: 'gws', argv, ok });
const pg = (tables: string[], database?: string, ok = true): LedgerEntry => ({
  v: 1,
  ts: TS,
  recorder: 'postgres',
  ...(database ? { database } : {}),
  tables,
  ok,
});

describe('summarizeSources', () => {
  it('returns null when nothing recorded a data call', () => {
    expect(summarizeSources([])).toBeNull();
    expect(
      summarizeSources([
        looker('get_explores', { model: 'm' }),
        looker('query_sql', { model: 'm', explore: 'e' }),
        looker('query', { model: 'm', explore: 'e' }, false),
        snow('select * from a.t', false),
        snow('insert into a.t values (1)'),
        gws(['gmail', 'users', 'messages', 'list']),
        gws(['sheets', 'spreadsheets', 'values', 'update', '--params', '{}']),
        gws(['sheets', '+read', '--spreadsheet', 'ID1234567890', '--range', 'A1', '--dry-run']),
      ]),
    ).toBeNull();
  });

  it('counts each data call and lists each object once, systems in a fixed order', () => {
    const out = summarizeSources([
      gws(['sheets', '+read', '--spreadsheet', 'SHEET_ID_123', '--range', 'Summary!A2:F90']),
      snow('select * from a.fct_orders join a.dim_customer using (id)', true, '2026-11-03T14:05:00.000Z'),
      looker('query', { model: 'acme_retail', explore: 'web_sessions', fields: ['x'] }),
      looker('query', { model: 'acme_retail', explore: 'web_sessions' }),
      looker('run_look', { look_id: 42 }),
      looker('run_dashboard', { dashboard_id: 'acme_retail::kpis' }),
      snow('select * from a.fct_orders'),
      gws([
        'sheets',
        'spreadsheets',
        'values',
        'batchGet',
        '--params',
        JSON.stringify({ spreadsheetId: 'SHEET_ID_123', ranges: ['Tab!A1:B2', 'Summary!A2:F90'] }),
      ]),
      gws(['sheets', 'spreadsheets', 'values', 'get', '--params', '{"spreadsheetId":"OTHER_ID_99","range":"X!A1"}']),
    ]);
    expect(out).toEqual({
      version: 1,
      systems: [
        {
          system: 'looker',
          origin: ORIGIN,
          calls: 4,
          lastAt: TS,
          objects: [
            { kind: 'explore', model: 'acme_retail', explore: 'web_sessions' },
            { kind: 'look', id: '42' },
            { kind: 'dashboard', id: 'acme_retail::kpis' },
          ],
        },
        {
          system: 'snowflake',
          calls: 2,
          lastAt: '2026-11-03T14:05:00.000Z',
          objects: [
            { kind: 'table', name: 'a.fct_orders' },
            { kind: 'table', name: 'a.dim_customer' },
          ],
        },
        {
          system: 'sheets',
          calls: 3,
          lastAt: TS,
          objects: [
            { kind: 'range', spreadsheetId: 'SHEET_ID_123', range: 'Summary!A2:F90' },
            { kind: 'range', spreadsheetId: 'SHEET_ID_123', range: 'Tab!A1:B2' },
            { kind: 'range', spreadsheetId: 'OTHER_ID_99', range: 'X!A1' },
          ],
        },
      ],
    });
  });

  it('treats a read of only catalog views as metadata: not counted, not named', () => {
    expect(
      summarizeSources([
        snow("select table_name from ANALYTICS.INFORMATION_SCHEMA.TABLES where table_schema = 'CORE'"),
        snow('select query_text from SNOWFLAKE.ACCOUNT_USAGE.QUERY_HISTORY limit 5'),
      ]),
    ).toBeNull();
  });

  it('keeps a read whose other relation cannot be named, and a quoted table that only looks like a catalog view', () => {
    expect(
      summarizeSources([
        snow('select o.* from ANALYTICS.INFORMATION_SCHEMA.TABLES t join identifier($tbl) o on true'),
        snow('select * from ANALYTICS.INFORMATION_SCHEMA.TABLES t join ANALYTICS..ORDERS o on true'),
        snow('select * from PUBLIC."INFORMATION_SCHEMA.ORDERS"'),
      ])?.systems,
    ).toEqual([
      {
        system: 'snowflake',
        calls: 3,
        lastAt: TS,
        objects: [{ kind: 'table', name: 'PUBLIC.INFORMATION_SCHEMA.ORDERS' }],
      },
    ]);
  });

  it('suppresses a read only when every relation in it is a catalog view', () => {
    const out = summarizeSources([
      snow('select o.* from table($tbl) o cross join ANALYTICS.INFORMATION_SCHEMA.TABLES t'),
      snow(
        'select o.* from ANALYTICS.INFORMATION_SCHEMA.TABLES t cross join (ANALYTICS.CORE.ORDERS o join ANALYTICS.CORE.CUSTOMERS c on o.id = c.id)',
      ),
      snow(
        'select o.* from ORDERS o cross join (with ORDERS as (select * from ANALYTICS.INFORMATION_SCHEMA.TABLES) select * from ORDERS) m',
      ),
    ]);
    expect(out?.systems[0].calls).toBe(3);
  });

  it('suppresses only a single-relation catalog lookup; a join of catalog views, or one with data after it, counts', () => {
    expect(
      summarizeSources([
        snow('select o.* from INFORMATION_SCHEMA.TABLES t cross join INFORMATION_SCHEMA.COLUMNS c, CORE.ORDERS o'),
        snow('select c.* from A.INFORMATION_SCHEMA.TABLES t join A.INFORMATION_SCHEMA.COLUMNS c using (table_name)'),
      ])?.systems[0].calls,
    ).toBe(2);
  });

  it('keeps a read whose FROM list continues past a modifier it does not parse', () => {
    expect(
      summarizeSources([
        snow('select o.* from ANALYTICS.INFORMATION_SCHEMA.TABLES t sample (100), ANALYTICS.CORE.ORDERS o'),
        snow('select * from ANALYTICS.INFORMATION_SCHEMA.TABLES t (a, b), ANALYTICS.CORE.ORDERS o'),
      ])?.systems[0].calls,
    ).toBe(2);
  });

  it('counts a read that mixes catalog views with data, naming only the data', () => {
    expect(
      summarizeSources([
        snow(
          'select o.* from ANALYTICS.CORE.ORDERS o join ANALYTICS.INFORMATION_SCHEMA.TABLES t on t.table_name = o.src',
        ),
      ])?.systems,
    ).toEqual([
      { system: 'snowflake', calls: 1, lastAt: TS, objects: [{ kind: 'table', name: 'ANALYTICS.CORE.ORDERS' }] },
    ]);
  });

  it('counts a batch that holds a read, and not one that holds none', () => {
    expect(summarizeSources([snow("use warehouse w; select * from a.orders where note = 'x;y'")])?.systems).toEqual([
      { system: 'snowflake', calls: 1, lastAt: TS, objects: [{ kind: 'table', name: 'a.orders' }] },
    ]);
    expect(summarizeSources([snow('use warehouse w; insert into a.t values (1)')])).toBeNull();
  });

  it('counts every read, naming no object where no table can be read from it', () => {
    expect(summarizeSources([snow('select * from identifier($t)'), snow('select current_version()')])?.systems).toEqual(
      [{ system: 'snowflake', calls: 2, lastAt: TS, objects: [] }],
    );
  });

  it('keeps calls to two Looker instances apart, and ignores a call with no recorded instance', () => {
    const out = summarizeSources([
      looker('query', { model: 'm', explore: 'e' }),
      looker('query', { model: 'x', explore: 'y' }, true, 'https://other.looker.example'),
      looker('query', { model: 'z', explore: 'w' }, true, null),
    ]);
    expect(out?.systems.map((s) => [s.origin, s.calls])).toEqual([
      [ORIGIN, 1],
      ['https://other.looker.example', 1],
    ]);
  });

  it('counts a cut-off statement even when its table is past the cut', () => {
    expect(
      summarizeSources([{ v: 1, ts: TS, recorder: 'snowflake', sql: 'select c1, c2, c3', ok: true, truncated: true }])
        ?.systems,
    ).toEqual([{ system: 'snowflake', calls: 1, lastAt: TS, objects: [] }]);
  });

  it('counts a statement cut at the cap but names nothing from it, since its last name may be partial', () => {
    const cut = { v: 1, ts: TS, recorder: 'snowflake', ok: true, truncated: true } as const;
    expect(summarizeSources([{ ...cut, sql: 'select * from a.orders o join a."customer det' }])?.systems).toEqual([
      { system: 'snowflake', calls: 1, lastAt: TS, objects: [] },
    ]);
    expect(summarizeSources([{ ...cut, sql: '/* a very long comment that the cap cut' }])?.systems).toEqual([
      { system: 'snowflake', calls: 1, lastAt: TS, objects: [] },
    ]);
  });

  it('reads a Sheets command behind global options and a versioned service', () => {
    const out = summarizeSources([
      gws(['--format', 'csv', 'sheets', '+read', '--spreadsheet', 'S_ID_0000001', '--range', 'A1:B2']),
      gws(['sheets:v4', 'spreadsheets', 'values', 'get', '--params={"spreadsheetId":"S_ID_0000002","range":"T!A1"}']),
    ]);
    expect(out?.systems[0].objects).toEqual([
      { kind: 'range', spreadsheetId: 'S_ID_0000001', range: 'A1:B2' },
      { kind: 'range', spreadsheetId: 'S_ID_0000002', range: 'T!A1' },
    ]);
  });

  it('credits nothing to a version-only gws call', () => {
    expect(
      summarizeSources([gws(['--version', 'sheets', '+read', '--spreadsheet', 'S_ID_0000001', '--range', 'A1'])]),
    ).toBeNull();
  });

  it('names Postgres tables with their database, lists a database alone only when no table of it is named', () => {
    expect(
      summarizeSources([
        pg(['public.orders'], 'app_dev'),
        pg(['public.orders', 'public.Line'], 'app_dev'),
        pg([], 'app_dev'),
        pg([], 'reporting'),
        pg(['public.events']),
        pg(['public.secret_t'], 'app_dev', false),
        snow('select * from a.t'),
      ])?.systems,
    ).toEqual([
      { system: 'snowflake', calls: 1, lastAt: TS, objects: [{ kind: 'table', name: 'a.t' }] },
      {
        system: 'postgres',
        calls: 5,
        lastAt: TS,
        objects: [
          { kind: 'table', name: 'public.orders', database: 'app_dev' },
          { kind: 'table', name: 'public.Line', database: 'app_dev' },
          { kind: 'database', name: 'reporting' },
          { kind: 'table', name: 'public.events' },
        ],
      },
    ]);
  });

  it('ignores another MCP server even when it has a tool named query', () => {
    expect(
      summarizeSources([{ v: 1, ts: TS, recorder: 'mcp', server: 'amplitude', tool: 'query', args: {}, ok: true }]),
    ).toBeNull();
  });
});
