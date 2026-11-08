/**
 * Turns recorded ledger entries into the `sources` field of a reply. Only calls that returned data count: a failed
 * call, a metadata lookup (`get_explores`), Looker's `query_sql` (it returns SQL, not rows), a write and a SELECT that
 * reads no table all leave no trace. Objects come only from what the call itself sent; nothing here reads the model's
 * prose.
 */
import type { LedgerEntry } from './source-ledger.js';

type SourceObject =
  | { kind: 'explore'; model: string; explore: string }
  | { kind: 'look'; id: string }
  | { kind: 'dashboard'; id: string }
  | { kind: 'table'; name: string; database?: string }
  | { kind: 'database'; name: string }
  | { kind: 'range'; spreadsheetId: string; range: string };

type SourceSystem = 'looker' | 'snowflake' | 'postgres' | 'sheets';

interface SystemSources {
  system: SourceSystem;
  /** Looker only: the instance the bridge reached, which the host matches against the group's own. */
  origin?: string;
  calls: number;
  lastAt: string;
  objects: SourceObject[];
}

export interface SourcesPayload {
  version: 1;
  systems: SystemSources[];
}

interface Recognized {
  system: SourceSystem;
  origin?: string;
  objects: SourceObject[];
}

const SYSTEM_ORDER: SourceSystem[] = ['looker', 'snowflake', 'postgres', 'sheets'];

function str(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function recognizeLooker(tool: string, args: unknown): Recognized | null {
  const a = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
  if (tool === 'query') {
    const model = str(a.model);
    const explore = str(a.explore);
    return { system: 'looker', objects: model && explore ? [{ kind: 'explore', model, explore }] : [] };
  }
  if (tool === 'run_look') {
    const id = str(a.look_id);
    return { system: 'looker', objects: id ? [{ kind: 'look', id }] : [] };
  }
  if (tool === 'run_dashboard') {
    const id = str(a.dashboard_id);
    return { system: 'looker', objects: id ? [{ kind: 'dashboard', id }] : [] };
  }
  return null;
}

/** gws options that take a value as the next argument; the value is not a command word. */
const GWS_VALUE_FLAGS = new Set([
  '--params',
  '--json',
  '--spreadsheet',
  '--range',
  '--format',
  '--api-version',
  '--sanitize',
  '--output',
  '-o',
  '--page-limit',
  '--page-delay',
  '--upload',
]);

function parseGwsArgv(argv: string[]): { words: string[]; flags: Map<string, string> } {
  const words: string[] = [];
  const flags = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('-')) {
      const eq = a.indexOf('=');
      if (eq !== -1) flags.set(a.slice(0, eq), a.slice(eq + 1));
      else if (GWS_VALUE_FLAGS.has(a)) flags.set(a, argv[++i] ?? '');
      else flags.set(a, '');
    } else {
      words.push(a);
    }
  }
  return { words, flags };
}

function parseParams(raw: string | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function recognizeGws(argv: string[]): Recognized | null {
  const { words: all, flags } = parseGwsArgv(argv);
  if (['--dry-run', '--help', '-h', '--version', '-V'].some((f) => flags.has(f))) return null;
  // `sheets` or a versioned `sheets:v4`; anything before it is a global option's leftover.
  const at = all.findIndex((w) => w === 'sheets' || w.startsWith('sheets:'));
  if (at === -1) return null;
  const words = all.slice(at);
  if (words[1] === '+read') {
    const spreadsheetId = flags.get('--spreadsheet');
    const range = flags.get('--range');
    return { system: 'sheets', objects: spreadsheetId && range ? [{ kind: 'range', spreadsheetId, range }] : [] };
  }
  if (words[1] !== 'spreadsheets' || words[2] !== 'values') return null;
  const params = parseParams(flags.get('--params'));
  const spreadsheetId = str(params.spreadsheetId);
  if (words[3] === 'get') {
    const range = str(params.range);
    return { system: 'sheets', objects: spreadsheetId && range ? [{ kind: 'range', spreadsheetId, range }] : [] };
  }
  if (words[3] === 'batchGet') {
    const ranges = Array.isArray(params.ranges) ? params.ranges : [params.ranges];
    const objects: SourceObject[] = [];
    for (const r of ranges) {
      const range = str(r);
      if (spreadsheetId && range) objects.push({ kind: 'range', spreadsheetId, range });
    }
    return { system: 'sheets', objects };
  }
  return null;
}

/** Index of the quote closing the one at `open` (a doubled quote is part of the text), or the end of `sql`. */
function closingQuote(sql: string, open: number, backslashEscapes: boolean): number {
  const q = sql[open];
  let j = open + 1;
  while (j < sql.length) {
    if (backslashEscapes && sql[j] === '\\') j += 2;
    else if (sql[j] === q && sql[j + 1] === q) j += 2;
    else if (sql[j] === q) break;
    else j += 1;
  }
  return j;
}

/** Comments and string literals blanked out, so a table name inside either is never read as one. */
function stripSqlNoise(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
      out += ' ';
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += ' ';
    } else if (c === '$' && next === '$') {
      const end = sql.indexOf('$$', i + 2);
      i = end === -1 ? sql.length : end + 2;
      out += " '' ";
    } else if (c === '"') {
      // A quoted identifier may hold `--`, `/*` or `'`: copy it whole so the lexer sees it as one name.
      const j = closingQuote(sql, i, false);
      out += sql.slice(i, j + 1);
      i = j + 1;
    } else if (c === "'") {
      i = closingQuote(sql, i, true) + 1;
      out += " '' ";
    } else {
      out += c;
      i += 1;
    }
  }
  return out;
}

/** `at` is the token's offset in the text it was read from; -1 for one the reader made up. */
type Token =
  | { kind: 'word'; text: string; upper: string; at: number }
  | { kind: 'quoted'; text: string; at: number }
  | { kind: 'punct'; text: string; at: number };

const SNOWFLAKE_TOKEN = /"((?:[^"]|"")*)"|([A-Za-z_][A-Za-z0-9_$]*)|(\S)/g;
/** Postgres takes any character past ASCII as a letter in an unquoted name. */
const POSTGRES_TOKEN = /"((?:[^"]|"")*)"|([A-Za-z_\u0080-\uffff][A-Za-z0-9_$\u0080-\uffff]*)|(\S)/g;

function tokenize(sql: string, pattern: RegExp = SNOWFLAKE_TOKEN, base = 0): Token[] {
  const tokens: Token[] = [];
  const re = new RegExp(pattern.source, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const at = base + m.index;
    if (m[1] !== undefined) tokens.push({ kind: 'quoted', text: m[1].replace(/""/g, '"'), at });
    else if (m[2] !== undefined) tokens.push({ kind: 'word', text: m[2], upper: m[2].toUpperCase(), at });
    else tokens.push({ kind: 'punct', text: m[3], at });
  }
  return tokens;
}

const CLAUSE_END = new Set([
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'QUALIFY',
  'UNION',
  'EXCEPT',
  'MINUS',
  'INTERSECT',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'ON',
  'USING',
  'WINDOW',
  'PIVOT',
  'UNPIVOT',
  'SAMPLE',
  'TABLESAMPLE',
  'MATCH_RECOGNIZE',
  'SELECT',
  'FETCH',
  'OFFSET',
  'AT',
  'BEFORE',
  'CHANGES',
  'CONNECT',
  'START',
]);

/** Words that end a FROM list; any other CLAUSE_END word only modifies the relation before it. */
const LIST_END = new Set([
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'LIMIT',
  'QUALIFY',
  'UNION',
  'EXCEPT',
  'MINUS',
  'INTERSECT',
  'JOIN',
  'INNER',
  'LEFT',
  'RIGHT',
  'FULL',
  'CROSS',
  'NATURAL',
  'ON',
  'USING',
  'WINDOW',
  'SELECT',
  'FETCH',
  'OFFSET',
]);

function isWord(t: Token | undefined, upper: string): boolean {
  return t?.kind === 'word' && t.upper === upper;
}

function isIdent(t: Token | undefined): t is Extract<Token, { kind: 'word' | 'quoted' }> {
  return t !== undefined && (t.kind === 'word' || t.kind === 'quoted');
}

type Ident = Extract<Token, { kind: 'word' | 'quoted' }>;

interface Dialect {
  /** How the database resolves the name: one case for unquoted names, exact for quoted ones. */
  key(t: Ident): string;
  isCatalog(keys: readonly string[]): boolean;
  /** The name the footer shows, from the name parts as written and as resolved. */
  display(parts: readonly string[], keys: readonly string[]): string;
  /** Postgres only: `ONLY t`, `ROWS FROM (...)`, an alias column list `g(n)` and a function's arguments are followed. */
  postgresSyntax: boolean;
}

/**
 * Catalog views (`<db>.INFORMATION_SCHEMA.*`, `SNOWFLAKE.ACCOUNT_USAGE.*`) are metadata, like Looker's get_dimensions.
 * Judged on resolved name components, so a quoted table named `"INFORMATION_SCHEMA.ORDERS"` is still data.
 */
function isCatalogView(keys: readonly string[]): boolean {
  const schema = keys.length >= 2 ? keys[keys.length - 2] : null;
  const database = keys.length >= 3 ? keys[keys.length - 3] : null;
  return schema === 'INFORMATION_SCHEMA' || (database === 'SNOWFLAKE' && schema === 'ACCOUNT_USAGE');
}

/**
 * Postgres resolves an unqualified `pg_*` name in `pg_catalog` before any schema on the search path, so `pg_class`
 * alone is the catalog.
 */
function isPostgresCatalog(keys: readonly string[]): boolean {
  const schema = keys.length >= 2 ? keys[keys.length - 2] : null;
  return schema === 'information_schema' || schema === 'pg_catalog' || (keys.length === 1 && keys[0].startsWith('pg_'));
}

const SNOWFLAKE: Dialect = {
  key: (t) => (t.kind === 'quoted' ? t.text : t.upper),
  isCatalog: isCatalogView,
  display: (parts) => parts.join('.'),
  postgresSyntax: false,
};

const POSTGRES: Dialect = {
  key: (t) => (t.kind === 'quoted' ? t.text : t.text.toLowerCase()),
  isCatalog: isPostgresCatalog,
  display: (_parts, keys) => keys.join('.'),
  postgresSyntax: true,
};

export interface SqlRead {
  /** Data tables, catalog views excluded. */
  tables: string[];
  /** Every place a data table is named, by the offset of its first name part. */
  occurrences: Array<{ name: string; at: number }>;
  /** True only when the statement reads exactly one relation and it is a catalog view: then it is metadata. */
  catalogOnly: boolean;
  /**
   * Relations that may hold data: neither a catalog view nor one computed in the statement itself (a function, VALUES,
   * a derived table or CTE, whose own FROMs are counted where they appear).
   */
  dataRelations: number;
  /** The scan met syntax after a relation that it did not follow, so the list may hold more than it counted. */
  unresolved: boolean;
  /** A data-modifying CTE, a main UPDATE/DELETE/INSERT/MERGE after the CTEs, or `SELECT ... INTO`. */
  writes: boolean;
}

/**
 * Tables a read statement names after FROM/JOIN, minus its own CTEs. Null for anything that is not a SELECT/WITH:
 * DDL, DML and session commands are not sources of an answer.
 */
export function readTablesFromSql(sql: string): SqlRead | null {
  return readStatement(tokenize(stripSqlNoise(sql)), SNOWFLAKE);
}

const DML_LEAD = new Set(['INSERT', 'UPDATE', 'DELETE', 'MERGE']);
const STATEMENT_LEAD = new Set(['SELECT', 'VALUES', 'TABLE', ...DML_LEAD]);

function readStatement(tokens: Token[], dialect: Dialect): SqlRead | null {
  let first = 0;
  while (tokens[first]?.kind === 'punct' && tokens[first].text === '(') first++;
  const lead = tokens[first];
  if (!lead || lead.kind !== 'word' || (lead.upper !== 'SELECT' && lead.upper !== 'WITH')) return null;

  const ctes = new Set<string>();
  for (let i = 0; i < tokens.length - 2; i++) {
    const t = tokens[i];
    const prev = tokens[i - 1];
    const prevIsWith = prev?.kind === 'word' && (prev.upper === 'WITH' || prev.upper === 'RECURSIVE');
    const prevIsComma = prev?.kind === 'punct' && prev.text === ',';
    if (!isIdent(t) || !(prevIsWith || prevIsComma)) continue;
    let j = i + 1;
    if (tokens[j]?.kind === 'punct' && tokens[j].text === '(') {
      let depth = 0;
      for (; j < tokens.length; j++) {
        if (tokens[j].text === '(') depth++;
        else if (tokens[j].text === ')' && --depth === 0) break;
      }
      j++;
    }
    const as = tokens[j];
    if (as?.kind !== 'word' || as.upper !== 'AS') continue;
    let body = j + 1;
    if (isWord(tokens[body], 'NOT')) body++;
    if (isWord(tokens[body], 'MATERIALIZED')) body++;
    if (tokens[body]?.text === '(') ctes.add(dialect.key(t));
  }

  const tables: string[] = [];
  const occurrences: Array<{ name: string; at: number }> = [];
  const seen = new Set<string>();
  let catalogViews = 0;
  let derived = 0;
  let relations = 0;
  let unresolved = false;

  const afterGroup = (open: number): number => {
    let depth = 0;
    for (let k = open; k < tokens.length; k++) {
      if (tokens[k].text === '(') depth++;
      else if (tokens[k].text === ')' && --depth === 0) return k + 1;
    }
    return tokens.length;
  };

  const readName = (from: number): { name: string | null; key: string; single: boolean; next: number; at?: number } => {
    let start = from;
    let closeOnly = false;
    if (dialect.postgresSyntax && isWord(tokens[start], 'ONLY')) {
      start += 1;
      // `ONLY (t)` puts the name in parentheses.
      if (tokens[start]?.text === '(' && isIdent(tokens[start + 1])) {
        start += 1;
        closeOnly = true;
      }
    }
    const t = tokens[start];
    if (t?.kind === 'punct' && t.text === '(') {
      derived += 1;
      return { name: null, key: '', single: false, next: dialect.postgresSyntax ? afterGroup(start) : start + 1 };
    }
    if (dialect.postgresSyntax && isWord(t, 'ROWS') && isWord(tokens[start + 1], 'FROM')) {
      derived += 1;
      return { name: null, key: '', single: false, next: start + 2 };
    }
    if (t?.kind === 'word' && t.upper === 'IDENTIFIER' && tokens[start + 1]?.text === '(') {
      return { name: null, key: '', single: false, next: start + 2 };
    }
    if (t?.kind === 'punct' && t.text === '$') {
      return { name: null, key: '', single: false, next: start + 2 };
    }
    if (!isIdent(t)) return { name: null, key: '', single: false, next: start + 1 };
    if (t.kind === 'word' && (t.upper === 'LATERAL' || t.upper === 'TABLE' || t.upper === 'VALUES')) {
      derived += 1;
      return { name: null, key: '', single: false, next: start + 1 };
    }
    // A function call (`FLATTEN(`, `GENERATOR(`) is not a table.
    if (tokens[start + 1]?.text === '(') {
      derived += 1;
      return { name: null, key: '', single: false, next: dialect.postgresSyntax ? afterGroup(start + 1) : start + 1 };
    }
    const parts = [t.text];
    const keys = [dialect.key(t)];
    let k = start + 1;
    while (tokens[k]?.text === '.' && isIdent(tokens[k + 1])) {
      const part = tokens[k + 1] as Ident;
      parts.push(part.text);
      keys.push(dialect.key(part));
      k += 2;
    }
    // `db..orders` (schema omitted) leaves a dot unread: the name is partial, so it is not named at all.
    if (tokens[k]?.text === '.') return { name: null, key: '', single: false, next: k };
    // A schema-qualified function call (`app.rows_of(...)`) is not a table either.
    if (dialect.postgresSyntax && tokens[k]?.text === '(') {
      derived += 1;
      return { name: null, key: '', single: false, next: afterGroup(k) };
    }
    if (closeOnly && tokens[k]?.text === ')') k += 1;
    if (dialect.isCatalog(keys)) {
      catalogViews += 1;
      return { name: null, key: '', single: false, next: k };
    }
    return {
      name: dialect.display(parts, keys),
      key: keys.join('.'),
      single: parts.length === 1,
      next: k,
      at: t.at,
    };
  };

  const add = (name: string, key: string, single: boolean, at: number): void => {
    if (single && ctes.has(key)) {
      derived += 1;
      return;
    }
    occurrences.push({ name, at });
    if (seen.has(key)) return;
    seen.add(key);
    tables.push(name);
  };

  // Per token: whether every enclosing parenthesis opens a subquery. `EXTRACT(YEAR FROM d)` and
  // `TRIM(BOTH FROM s)` use FROM as expression syntax inside a group that does not start with SELECT/WITH.
  const inQuery: boolean[] = [];
  const stack: boolean[] = [];
  let writes = false;
  // After a CTE list (and any SEARCH/CYCLE clause) the first statement word at the top level is the statement itself.
  let main = lead.upper === 'SELECT';
  let tableLead = -1;
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind === 'punct' && t.text === '(') {
      const next = tokens[i + 1];
      const subquery = next?.kind === 'word' && (next.upper === 'SELECT' || next.upper === 'WITH');
      if (next?.kind === 'word' && DML_LEAD.has(next.upper)) writes = true;
      stack.push(subquery);
    } else if (t.kind === 'punct' && t.text === ')') {
      stack.pop();
    } else if (t.kind === 'word' && t.upper === 'INTO' && stack.length === 0) {
      writes = true;
    } else if (t.kind === 'word' && !main && stack.length === 0 && STATEMENT_LEAD.has(t.upper)) {
      main = true;
      if (DML_LEAD.has(t.upper)) writes = true;
      if (t.upper === 'TABLE') tableLead = i;
    }
    inQuery.push(stack.length === 0 || stack[stack.length - 1]);
  }

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    const readsOne = t.kind === 'word' && (t.upper === 'JOIN' || i === tableLead);
    if (t.kind !== 'word' || (t.upper !== 'FROM' && !readsOne)) continue;
    if (!inQuery[i]) continue;
    const before = tokens[i - 1];
    const beforeThat = tokens[i - 2];
    if (
      t.upper === 'FROM' &&
      before?.kind === 'word' &&
      before.upper === 'DISTINCT' &&
      beforeThat?.kind === 'word' &&
      (beforeThat.upper === 'IS' || beforeThat.upper === 'NOT')
    )
      continue;
    let k = i + 1;
    for (;;) {
      relations += 1;
      const { name, key, single, next, at } = readName(k);
      if (name) add(name, key, single, at ?? -1);
      k = next;
      if (readsOne) break;
      while (k < tokens.length) {
        const cur = tokens[k];
        if (cur.kind === 'punct' && (cur.text === ',' || cur.text === ')' || cur.text === ';')) break;
        // A locking clause (`FOR UPDATE OF a, b`) ends the list; its commas separate aliases, not relations.
        if (dialect.postgresSyntax && isWord(cur, 'FOR')) break;
        if (cur.kind === 'word' && CLAUSE_END.has(cur.upper)) {
          // SAMPLE, AT, PIVOT and the like modify a relation without ending the list: what follows is not read here.
          if (!LIST_END.has(cur.upper)) unresolved = true;
          break;
        }
        if (cur.kind === 'punct' && cur.text === '(') {
          // A subquery inside the group is read where its own FROM appears; an alias column list holds no relation.
          if (dialect.postgresSyntax) {
            k = afterGroup(k);
            continue;
          }
          unresolved = true;
          break;
        }
        k++;
      }
      if (tokens[k]?.text !== ',') break;
      k++;
    }
  }
  // Provable only for the simple shape agents use to look things up: one relation, and it is a catalog view. Any join,
  // list or modifier the scan cannot fully follow keeps the read counted.
  return {
    tables,
    occurrences,
    catalogOnly: !unresolved && relations === 1 && catalogViews === 1,
    dataRelations: relations - catalogViews - derived,
    unresolved,
    writes,
  };
}

/**
 * Every read statement counts, whether or not a table name can be read from it, so a parse gap never drops the call.
 * Names are best effort and never invented: a statement cut at the tap's cap names nothing, since its last name may be
 * partial (the tap classified the whole text as a read before cutting it).
 */
function recognizeSnowflake(sql: string, truncated: boolean): Recognized | null {
  if (truncated) return { system: 'snowflake', objects: [] };
  // A batch (`num_statements`) counts when any statement in it is a read of data, not only of the catalog.
  const reads = splitStatements(sql)
    .map(readTablesFromSql)
    .filter((r): r is SqlRead => r !== null)
    .filter((r) => !r.catalogOnly);
  if (reads.length === 0) return null;
  return { system: 'snowflake', objects: reads.flatMap((r) => r.tables).map((name) => ({ kind: 'table', name })) };
}

/** Top-level statements, split on `;` outside comments, string literals and quoted identifiers. */
function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let start = 0;
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === '-' && next === '-') {
      const end = sql.indexOf('\n', i);
      i = end === -1 ? sql.length : end;
    } else if (c === '/' && next === '*') {
      const end = sql.indexOf('*/', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === '$' && next === '$') {
      const end = sql.indexOf('$$', i + 2);
      i = end === -1 ? sql.length : end + 2;
    } else if (c === "'" || c === '"') {
      let j = i + 1;
      while (j < sql.length) {
        if (c === "'" && sql[j] === '\\') j += 2;
        else if (sql[j] === c && sql[j + 1] === c) j += 2;
        else if (sql[j] === c) break;
        else j += 1;
      }
      i = j + 1;
    } else if (c === ';') {
      out.push(sql.slice(start, i));
      start = i + 1;
      i += 1;
    } else {
      i += 1;
    }
  }
  out.push(sql.slice(start));
  return out.filter((part) => part.trim());
}

const IDENT_CHAR = /[A-Za-z0-9_$\u0080-\uffff]/;

const DOLLAR_TAG = /\$(?:[A-Za-z_\u0080-\uffff][A-Za-z0-9_\u0080-\uffff]*)?\$/y;
const COPY_FROM_STDIN = /^\s*copy\b[\s\S]*\bfrom\s+stdin\b/i;
/** Meta-commands that may change which database later statements run on, or run text the recorder never sees. */
const RECONNECTS = new Set(['c', 'connect', 'i', 'include', 'ir', 'include_relative']);

/**
 * Postgres's and psql's lexical rules, which differ from Snowflake's: block comments nest, a dollar quote may carry a
 * tag (`$fn$ ... $fn$`), and a backslash outside a quote starts psql meta-commands that run to the end of the line.
 * A backslash escapes inside an `E'...'` string, and inside every string when `standardStrings` is false (the server
 * setting `standard_conforming_strings=off`).
 *
 * Meta-commands are dropped and end the statement before them, except `\copy`, whose line is SQL. `\r` discards the
 * statement, `\q` ends the script, and the lines after a `COPY ... FROM STDIN`, however it is sent, up to `\.` are
 * data. Anything inside a `\if` block is dropped, since psql may skip it. `connects` says the script may have
 * switched database (`\c`) or run a file it names (`\i`).
 *
 * The result has the input's length, every kept character at its own offset, so two readings of one text can be
 * compared by where they found a name.
 */
function stripPostgresNoise(
  sql: string,
  standardStrings: boolean,
  psqlScript: boolean,
): { text: string; connects: boolean } {
  let out = '';
  let current = '';
  let statementAt = 0;
  let connects = false;
  let copyLine: number | null = null;
  let conditional = 0;
  // The run of identifier characters just kept: a `$$` continues a name (`a$$`) but opens a quote after a number, a
  // parameter (`$1`), or anything that is not a name, a just-closed quote included.
  let run: 'none' | 'name' | 'other' = 'none';
  let i = 0;
  const lineEnd = (from: number): number => {
    const end = sql.indexOf('\n', from);
    return end === -1 ? sql.length : end;
  };
  const blank = (length: number): string => ' '.repeat(Math.max(0, length));
  /** Source text kept as SQL, or blanked when psql may skip it. */
  const keep = (text: string): void => {
    current += text;
    out += conditional === 0 ? text : blank(text.length);
  };
  /** Source text that is not SQL, stood in for by `stand` padded to the same length. */
  const replace = (length: number, stand = ''): void => {
    const text = (stand + blank(length)).slice(0, length);
    current += text;
    out += conditional === 0 ? text : blank(length);
  };
  const endStatement = (length: number): void => {
    replace(length, ';');
    current = '';
    statementAt = out.length;
  };
  const dropStatement = (): void => {
    out = out.slice(0, statementAt) + blank(out.length - statementAt);
    current = '';
  };
  /** The end of the `\.` line after the line holding `from`, or of the script. */
  const copyDataEnd = (from: number): number => {
    let k = lineEnd(from) + 1;
    while (k < sql.length) {
      const end = lineEnd(k);
      if (sql.slice(k, end).replace(/\r$/, '') === '\\.') return end;
      k = end + 1;
    }
    return sql.length;
  };
  const skipTo = (to: number): void => {
    out += blank(to - out.length);
    i = to;
  };
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    const before: 'none' | 'name' | 'other' = run;
    run = 'none';
    const prevIsIdent = before === 'name';
    DOLLAR_TAG.lastIndex = i;
    const tag = c === '$' && !prevIsIdent ? DOLLAR_TAG.exec(sql)?.[0] : undefined;
    if (c === '\n' && copyLine !== null) {
      const copiesIn = /\bfrom\s+stdin\b/i.test(current.slice(copyLine));
      copyLine = null;
      endStatement(1);
      i += 1;
      if (copiesIn) skipTo(copyDataEnd(i - 1));
    } else if (c === ';') {
      const copiesIn = psqlScript && COPY_FROM_STDIN.test(current);
      copyLine = null;
      endStatement(1);
      i += 1;
      if (copiesIn) skipTo(copyDataEnd(i - 1));
    } else if (c === '-' && next === '-') {
      const end = lineEnd(i);
      replace(end - i);
      i = end;
    } else if (c === '/' && next === '*') {
      let depth = 1;
      let j = i + 2;
      while (j < sql.length && depth > 0) {
        if (sql[j] === '/' && sql[j + 1] === '*') {
          depth += 1;
          j += 2;
        } else if (sql[j] === '*' && sql[j + 1] === '/') {
          depth -= 1;
          j += 2;
        } else {
          j += 1;
        }
      }
      j = Math.min(j, sql.length);
      replace(j - i);
      i = j;
    } else if (tag) {
      const close = sql.indexOf(tag, i + tag.length);
      const j = close === -1 ? sql.length : close + tag.length;
      replace(j - i, "''");
      i = j;
    } else if (c === '"') {
      const j = Math.min(closingQuote(sql, i, false) + 1, sql.length);
      keep(sql.slice(i, j));
      i = j;
    } else if (c === "'") {
      const prefixed = i > 0 && (sql[i - 1] === 'E' || sql[i - 1] === 'e') && !(i > 1 && IDENT_CHAR.test(sql[i - 2]));
      const j = Math.min(closingQuote(sql, i, prefixed || !standardStrings) + 1, sql.length);
      replace(j - i, "''");
      i = j;
    } else if (c === '\\' && psqlScript) {
      const end = lineEnd(i);
      // psql starts another command at any unquoted backslash; a quoted argument may hold one that is only text.
      const unquoted = sql.slice(i, end).replace(/'(?:[^'\\]|\\.)*'|"[^"]*"|`[^`]*`/g, ' ');
      const names = [...unquoted.matchAll(/\\([A-Za-z_]*)/g)].map((m) => m[1].toLowerCase());
      if (names[0] === 'copy' && conditional === 0) {
        endStatement(1);
        copyLine = current.length;
        keep(sql.slice(i + 1, i + 5));
        i += 5;
        continue;
      }
      // A meta-command such as `\g` sends the buffer as `;` does, COPY included.
      const copiesIn = COPY_FROM_STDIN.test(current);
      let quits = false;
      for (const name of names) {
        if (RECONNECTS.has(name)) connects = true;
        if (name === 'r' || name === 'reset') dropStatement();
        if (name === 'q' || name === 'quit') quits = true;
        if (name === 'if') conditional += 1;
        if (name === 'endif') conditional = Math.max(0, conditional - 1);
      }
      if (quits) {
        // psql quits without sending the statement still in its buffer.
        dropStatement();
        skipTo(sql.length);
        break;
      }
      endStatement(end - i);
      i = end;
      if (copiesIn) skipTo(copyDataEnd(i));
    } else {
      if (IDENT_CHAR.test(c)) run = before !== 'none' ? before : /[0-9$]/.test(c) ? 'other' : 'name';
      keep(c);
      i += 1;
    }
  }
  return { text: out.length === sql.length ? out : '', connects };
}

/** Splits text whose comments and literals are already blanked, on `;` outside quoted identifiers. */
function splitBlanked(text: string): Array<{ text: string; at: number }> {
  const out: Array<{ text: string; at: number }> = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') quoted = !quoted;
    else if (text[i] === ';' && !quoted) {
      out.push({ text: text.slice(start, i), at: start });
      start = i + 1;
    }
  }
  out.push({ text: text.slice(start), at: start });
  return out.filter((part) => part.text.trim());
}

const word = (text: string): Token => ({ kind: 'word', text, upper: text.toUpperCase(), at: -1 });
const SELECT_ALL_FROM: Token[] = [word('select'), { kind: 'punct', text: '*', at: -1 }, word('from')];

/** `TABLE t` and `COPY t TO` / `COPY (query) TO` read like the SELECT they stand for; `COPY ... FROM` writes. */
function readPostgresStatement(tokens: Token[]): SqlRead | null {
  if (isWord(tokens[0], 'TABLE')) return readStatement([...SELECT_ALL_FROM, ...tokens.slice(1)], POSTGRES);
  if (!isWord(tokens[0], 'COPY')) return readStatement(tokens, POSTGRES);
  if (tokens[1]?.text === '(') {
    let depth = 0;
    for (let k = 1; k < tokens.length; k++) {
      if (tokens[k].text === '(') depth++;
      else if (tokens[k].text === ')' && --depth === 0) {
        return isWord(tokens[k + 1], 'TO') ? readStatement(tokens.slice(2, k), POSTGRES) : null;
      }
    }
    return null;
  }
  const direction = tokens.findIndex((t) => isWord(t, 'TO') || isWord(t, 'FROM'));
  if (direction === -1 || !isWord(tokens[direction], 'TO')) return null;
  const columns = tokens.findIndex((t) => t.text === '(');
  const name = tokens.slice(1, columns !== -1 && columns < direction ? columns : direction);
  return readStatement([...SELECT_ALL_FROM, ...name], POSTGRES);
}

export interface PostgresRead {
  /** Some statement in the script reads data. */
  reads: boolean;
  /** Data tables named by the reads, as Postgres resolves them: unquoted names in lower case. */
  tables: string[];
  /** The script switched database part way through, so the database it was started on is not the only one. */
  connects: boolean;
}

/**
 * What a psql script, or one `-c` command, reads. Writes, DDL, session commands, a SELECT of nothing stored (a probe
 * like `select 1`, a function or VALUES) and a read of catalog relations alone are not reads. psql sends a `-c` to the
 * server as it stands, so backslashes in one start no meta-command, unless its very first character is a backslash:
 * then the whole command is meta-commands, which name nothing.
 */
export function readPostgresSql(sql: string, source: 'script' | 'command' = 'script'): PostgresRead {
  const slashCommand = source === 'command' && sql.startsWith('\\');
  const psqlScript = source === 'script' || slashCommand;
  // `standard_conforming_strings` may be off from a server, role or connection default the text never shows, so the
  // text is read both ways. A table counts only where both readings find it at the same offset: under the wrong
  // reading a literal's text reads as SQL, and it cannot sit at a place the right reading also takes for a name.
  const readings = [true, false].map((standardStrings) => {
    const { text, connects } = stripPostgresNoise(sql, standardStrings, psqlScript);
    const reads = splitBlanked(text)
      .map((stmt) => readPostgresStatement(tokenize(stmt.text, POSTGRES_TOKEN, stmt.at)))
      .filter((r): r is SqlRead => r !== null && !r.writes && (r.dataRelations > 0 || r.unresolved));
    const found = new Set(reads.flatMap((r) => r.occurrences.map((o) => `${o.at}:${o.name}`)));
    return { reads: reads.length > 0, occurrences: reads.flatMap((r) => r.occurrences), found, connects };
  });
  const [first, second] = readings;
  const agreed = first.occurrences.filter((o) => o.at >= 0 && second.found.has(`${o.at}:${o.name}`));
  return {
    reads: first.reads && second.reads,
    tables: slashCommand ? [] : [...new Set(agreed.map((o) => o.name))],
    connects: first.connects || second.connects,
  };
}

function recognizePostgres(database: string | undefined, tables: readonly string[]): Recognized {
  const objects: SourceObject[] = tables.map((name) => ({ kind: 'table', name, ...(database ? { database } : {}) }));
  if (objects.length === 0 && database) objects.push({ kind: 'database', name: database });
  return { system: 'postgres', objects };
}

function recognize(entry: LedgerEntry): Recognized | null {
  if (!entry.ok) return null;
  if (entry.recorder === 'mcp') {
    if (entry.server !== 'looker' || !entry.origin) return null;
    const hit = recognizeLooker(entry.tool, entry.args);
    return hit && { ...hit, origin: entry.origin };
  }
  if (entry.recorder === 'snowflake') return recognizeSnowflake(entry.sql, entry.truncated === true);
  if (entry.recorder === 'postgres') return recognizePostgres(entry.database, entry.tables);
  return recognizeGws(entry.argv);
}

function objectKey(system: SourceSystem, o: SourceObject): string {
  switch (o.kind) {
    case 'database':
      return `database:${o.name}`;
    case 'explore':
      return `explore:${o.model}/${o.explore}`;
    case 'look':
    case 'dashboard':
      return `${o.kind}:${o.id}`;
    case 'table':
      // A Postgres name arrives already resolved, so its case is significant; Snowflake's is folded here.
      return system === 'postgres' ? `table:${o.database ?? ''}/${o.name}` : `table:${o.name.toUpperCase()}`;
    case 'range':
      return `range:${o.spreadsheetId}!${o.range}`;
  }
}

/** A database is listed on its own only when no table read from it is. */
function withoutNamedDatabases(objects: SourceObject[]): SourceObject[] {
  const named = new Set(objects.flatMap((o) => (o.kind === 'table' && o.database ? [o.database] : [])));
  return objects.filter((o) => o.kind !== 'database' || !named.has(o.name));
}

/** Null when no entry recorded a data call: such a reply carries no footer. */
export function summarizeSources(entries: readonly LedgerEntry[]): SourcesPayload | null {
  const groups = new Map<
    string,
    { system: SourceSystem; origin?: string; calls: number; lastAt: string; objects: Map<string, SourceObject> }
  >();
  for (const entry of entries) {
    const hit = recognize(entry);
    if (!hit) continue;
    const key = `${hit.system}|${hit.origin ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      group = { system: hit.system, origin: hit.origin, calls: 0, lastAt: entry.ts, objects: new Map() };
      groups.set(key, group);
    }
    group.calls += 1;
    if (entry.ts > group.lastAt) group.lastAt = entry.ts;
    for (const o of hit.objects) {
      const key = objectKey(hit.system, o);
      if (!group.objects.has(key)) group.objects.set(key, o);
    }
  }
  if (groups.size === 0) return null;
  const systems = [...groups.values()]
    .sort((a, b) => SYSTEM_ORDER.indexOf(a.system) - SYSTEM_ORDER.indexOf(b.system))
    .map(
      (g): SystemSources => ({
        system: g.system,
        ...(g.origin ? { origin: g.origin } : {}),
        calls: g.calls,
        lastAt: g.lastAt,
        objects: withoutNamedDatabases([...g.objects.values()]),
      }),
    );
  return { version: 1, systems };
}
