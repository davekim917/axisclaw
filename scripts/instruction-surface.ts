/**
 * Banned-pattern and `@`-import scans for the always-on instruction surface: point-in-time content, and a per-PR push cap
 * (round 3 is the agent's pr-review-loop checkpoint; a cap only yields an escalation). Kept out of
 * `fleet-drift.ts` so importing it does not load `better-sqlite3`. No byte ceilings: trimming to a number is no bar.
 */
import fs from 'node:fs';
import path from 'node:path';

const BANNED_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'iso_date', re: /\b20\d{2}-\d{2}-\d{2}\b/ },
  { name: 'issue_or_pr_ref', re: /(?:^|[\s(])#\d{2,}\b/ },
  { name: 'current_focus_header', re: /^#+\s*Current Focus/im },
  {
    name: 'push_cap',
    re: /\b(?:max(?:imum)?|at most|no more than|up to)\s+(?:\d+|one|two|three|four|five)\s+pushes\b|\b(?:\d+|one|two|three|four|five)[- ]push\s+(?:cap|limit|budget)\b/i,
  },
];

const TICKET_KEY = /^[A-Z][A-Z0-9_]*$/;

/** A tracker key is per install (`ticketKeys`, e.g. `ENG` for `ENG-123`): a built-in list would name someone's team. */
export function scanBannedPatterns(content: string, ticketKeys: readonly string[] = []): string[] {
  const hits = BANNED_PATTERNS.filter(({ re }) => re.test(content)).map(({ name }) => name);
  const keys = ticketKeys.filter((key) => TICKET_KEY.test(key));
  if (keys.length > 0 && new RegExp(`\\b(?:${keys.join('|')})-\\d+\\b`).test(content)) hits.push('ticket_ref');
  return hits;
}

/**
 * An `@` with no letter or digit before it. Claude Code reads a token at the start of any markdown text node, and a
 * node can start after any punctuation (emphasis, a link, a code span, an escape), so only an alphanumeric prefix,
 * as in an email address, or an unescaped `@` (a `\@` escape ends a node), rules a token out. The match is zero-width,
 * so a second `@` in the same run is a token too.
 */
const IMPORT_TOKEN = /(?<![A-Za-z0-9]|(?<!\\)@)@(?=((?:[^\s\\]|\\ )+))/g;
/** Characters where a markdown text node can end, so where Claude's token can end. */
const NODE_END = /[\][()*_`<>"|~!]/g;

export interface AtImport {
  line: number;
  target: string;
}

/** Claude Code's own filter on a token's path: what survives it is a file Claude tries to read. */
function importCandidate(raw: string): string | null {
  const target = raw.split('#')[0].replaceAll('\\ ', ' ');
  if (!target || target === '/') return null;
  if (target.startsWith('./') || target.startsWith('~/') || target.startsWith('/')) return target;
  if (target.startsWith('@') || /^[#%^&*()]+/.test(target) || !/^[a-zA-Z0-9._-]/.test(target)) return null;
  return target;
}

/** Path errors that mean "no such file here"; anything else (EACCES, EIO) is a real failure. */
export const MISSING_PATH_CODES = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENAMETOOLONG']);

function isRegularFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch (err) {
    if (MISSING_PATH_CODES.has((err as NodeJS.ErrnoException).code ?? '')) return false;
    throw err;
  }
}

/** The extensions Claude Code 2.1.318 will read as an import; it skips any other extension and reads a bare name. */
const IMPORTABLE_EXTENSIONS = new Set(
  [
    'md txt text json yaml yml toml xml csv html htm css scss sass less js ts tsx jsx mjs cjs mts cts py',
    'pyi pyw rb erb rake go rs java kt kts scala c cpp cc cxx h hpp hxx cs swift sh bash zsh fish ps1 bat',
    'cmd env ini cfg conf config properties sql graphql gql proto vue svelte astro ejs hbs pug jade php',
    'pl pm lua r dart ex exs erl hrl clj cljs cljc edn hs lhs elm ml mli f f90 f95 for cmake make',
    'makefile gradle sbt rst adoc asciidoc org tex latex lock log diff patch',
  ]
    .join(' ')
    .split(' ')
    .map((ext) => `.${ext}`),
);

/**
 * A target that reads as a path everywhere (home, absolute, `./` or `../`, or an importable extension) counts whether
 * or not it exists, because what exists differs by machine and checkout. Anything else counts when it exists beside
 * the file, so a mention such as `@someone` does not.
 */
function counts(target: string, baseDir: string): boolean {
  // Claude trims and resolves the path before it reads it, so `@LICENSE/` and `@LICENSE\ ` name a real file.
  const resolved = path.resolve(baseDir, target.trim());
  const extension = path.extname(resolved).toLowerCase();
  if (extension !== '' && !IMPORTABLE_EXTENSIONS.has(extension)) return false;
  if (target.startsWith('~/') || path.isAbsolute(target) || /^\.\.?\//.test(target) || extension !== '') return true;
  return isRegularFile(resolved);
}

/**
 * Every `@` token Claude Code could expand from an instruction file in `baseDir`: Codex and OpenCode read the same
 * token as literal text, so a shared instruction file must not carry one. No markdown structure is parsed, so a token
 * in code, an HTML block or a comment, which Claude skips, is reported too: the check over-reports and never misses.
 */
export function findAtImports(content: string, baseDir: string): AtImport[] {
  const found: AtImport[] = [];
  content.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(IMPORT_TOKEN)) {
      const raw = match[1];
      const cuts = [raw, ...[...raw.matchAll(NODE_END)].map((end) => raw.slice(0, end.index))];
      const target = cuts.map(importCandidate).find((t) => t !== null && counts(t, baseDir));
      if (target) found.push({ line: index + 1, target });
    }
  });
  return found;
}
