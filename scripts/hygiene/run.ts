import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';

import { vendoredEngineFiles } from '../../src/design-artifact-loop-vendor.js';
import { CODEX_FAMILY_DEFAULTS, FAMILY_DEFAULTS } from '../../src/flag-parser.js';
import { findAtImports, MISSING_PATH_CODES } from '../instruction-surface.js';
import { scanComments } from './comments.js';

export interface Finding {
  check: 'knip' | 'jscpd' | 'comments' | 'instructions' | 'test-imports';
  kind: string;
  location: string;
  message: string;
}

interface JscpdPolicy {
  mirrors?: { files: string[]; reason: string }[];
  [option: string]: unknown;
}

/** A knip JSON-reporter entry; a duplicate export arrives as the list of its names. */
type KnipItem = KnipSymbol | KnipSymbol[];

interface KnipSymbol {
  name: string;
  line?: number;
}

interface JscpdFragment {
  name: string;
  start: number;
}

const REPO_ROOT = path.resolve(import.meta.dirname, '..', '..');
const TOOL_PATH = [path.join(REPO_ROOT, 'node_modules', '.bin'), process.env.PATH ?? ''].join(path.delimiter);

const KNIP_WORKSPACES = ['.', 'container/agent-runner'];
const SOURCE_ROOTS = ['src', 'setup', 'scripts', 'container/agent-runner/src', 'container/agent-runner/scripts'];
const SOURCE_FILE = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const NOT_SOURCE =
  /(?:^|\/)(?:node_modules|__fixtures__|__test-fixtures__|test-fixtures|transaction-fixtures)\/|\.test\.[cm]?[jt]sx?$/;

/**
 * Files whose findings are fixed somewhere other than this tree, so no check reports them.
 * `upstream`: upstream-owned files still byte-identical to the pinned upstream commit, per
 * src/upstream-ratchet.json and the bytes on disk now; editing one would grow the divergence
 * the ratchet tracks. `vendored`: the design-review engine, fixed in the plugin repo and
 * re-vendored.
 */
export interface Exempt {
  upstream: Set<string>;
  vendored: Set<string>;
}

/** Read and hashed here rather than through src/upstream-ratchet.ts, so what this exempts is decided in reviewed code. */
function regularFileSha256(file: string): string | null {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return stat?.isFile() ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null;
}

export function exemptFiles(root: string): Exempt {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'src', 'upstream-ratchet.json'), 'utf8')) as {
    files: Record<string, { diff: number; sha256: string | null }>;
  };
  const upstream = new Set<string>();
  for (const [file, entry] of Object.entries(manifest.files)) {
    if (entry.diff === 0 && entry.sha256 !== null && regularFileSha256(path.join(root, file)) === entry.sha256) {
      upstream.add(file);
    }
  }
  return { upstream, vendored: new Set(vendoredEngineFiles(root)) };
}

const isExempt = (exempt: Exempt, file: string) => exempt.upstream.has(file) || exempt.vendored.has(file);

function toolOptions(cwd: string) {
  return { cwd, encoding: 'utf8' as const, env: { ...process.env, PATH: TOOL_PATH }, maxBuffer: 256 * 1024 * 1024 };
}

function stdoutOf(tool: string, result: SpawnSyncReturns<string>): string {
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? `exit ${result.status ?? result.signal}`;
    throw new Error(`${tool} failed (${reason}): ${(result.stderr ?? '').trim()}`);
  }
  return result.stdout;
}

const isNonTestSource = (file: string) => SOURCE_FILE.test(file) && !NOT_SOURCE.test(file);

/** Non-test source under the scanned roots, as sorted root-relative POSIX paths. */
export function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const dir of SOURCE_ROOTS) {
    if (!fs.existsSync(path.join(root, dir))) continue;
    for (const entry of fs.readdirSync(path.join(root, dir), { recursive: true, encoding: 'utf8' })) {
      const file = path.posix.join(dir, entry.split(path.sep).join('/'));
      if (isNonTestSource(file)) files.push(file);
    }
  }
  return files.sort();
}

export function knipFindings(root: string, workspace: string): Finding[] {
  const output = stdoutOf(
    'knip',
    spawnSync(
      'knip',
      ['--config', 'knip.json', '--reporter', 'json', '--no-exit-code', '--no-progress'],
      toolOptions(path.join(root, workspace)),
    ),
  );
  const report = JSON.parse(output) as { issues: Record<string, unknown>[] };
  const findings: Finding[] = [];
  for (const row of report.issues) {
    const file = path.posix.join(workspace, String(row.file));
    for (const [kind, items] of Object.entries(row)) {
      if (kind === 'owners' || !Array.isArray(items)) continue;
      for (const item of items as KnipItem[]) {
        const symbols = [item].flat();
        const line = symbols[0]?.line;
        findings.push({
          check: 'knip',
          kind,
          location: line === undefined ? file : `${file}:${line}`,
          message: kind === 'files' ? 'unused file' : symbols.map((symbol) => symbol.name).join(' = '),
        });
      }
    }
  }
  return findings;
}

/**
 * Clones among `files`, except those between two files that `.jscpd.json` lists as one mirror
 * and those between two exempt files. A clone with one exempt side is reported at the other.
 */
export function jscpdFindings(
  root: string,
  files: string[],
  exempt: Exempt = { upstream: new Set(), vendored: new Set() },
): Finding[] {
  const { mirrors = [], ...options } = JSON.parse(
    fs.readFileSync(path.join(root, '.jscpd.json'), 'utf8'),
  ) as JscpdPolicy;
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'hygiene-jscpd-'));
  try {
    const config = path.join(out, 'config.json');
    fs.writeFileSync(config, JSON.stringify(options));
    stdoutOf(
      'jscpd',
      spawnSync(
        'jscpd',
        ['--config', config, '--reporters', 'json', '--output', out, '--absolute', '--silent', ...files],
        toolOptions(root),
      ),
    );
    const report = JSON.parse(fs.readFileSync(path.join(out, 'jscpd-report.json'), 'utf8')) as {
      duplicates: { firstFile: JscpdFragment; secondFile: JscpdFragment; lines: number }[];
    };
    const realRoot = fs.realpathSync(root);
    const where = (fragment: JscpdFragment) => path.relative(realRoot, fragment.name).split(path.sep).join('/');
    const usedMirrors = new Set<number>();
    const findings: Finding[] = [];
    for (const clone of report.duplicates) {
      const [first, second] = [where(clone.firstFile), where(clone.secondFile)];
      const mirror =
        first === second ? -1 : mirrors.findIndex((m) => m.files.includes(first) && m.files.includes(second));
      if (mirror >= 0) {
        usedMirrors.add(mirror);
        continue;
      }
      if (isExempt(exempt, first) && isExempt(exempt, second)) continue;
      const [ours, theirs] = isExempt(exempt, first)
        ? [`${second}:${clone.secondFile.start}`, `${first}:${clone.firstFile.start}`]
        : [`${first}:${clone.firstFile.start}`, `${second}:${clone.secondFile.start}`];
      findings.push({
        check: 'jscpd',
        kind: 'clone',
        location: ours,
        message: `${clone.lines} lines also at ${theirs}`,
      });
    }
    mirrors.forEach((mirror, index) => {
      if (usedMirrors.has(index)) return;
      findings.push({
        check: 'jscpd',
        kind: 'stale-mirror',
        location: '.jscpd.json',
        message: `no clone left between ${mirror.files.join(' and ')}; remove the entry`,
      });
    });
    return findings;
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

export function commentFindings(root: string, files: string[]): Finding[] {
  return files.flatMap((file) =>
    scanComments(file, fs.readFileSync(path.join(root, file), 'utf8')).findings.map((finding) => ({
      check: 'comments' as const,
      kind: finding.rule,
      location: `${file}:${finding.line}`,
      message: finding.excerpt,
    })),
  );
}

/** Trunk files composed into, or loaded as, an agent's instructions; see src/claude-md-compose.ts and container-runner.ts. */
const INSTRUCTION_FILE =
  /^container\/(?:CLAUDE\.md|spawn-template\.md|agent-runner\/src\/mcp-tools\/[^/]+\.instructions\.md|skills\/.+\/SKILL\.md)$/;

const EFFORT_LEVEL = 'low|medium|high|xhigh|max|ultra';

const MODEL_OR_EFFORT = new RegExp(
  [
    String.raw`\bclaude-(?:${Object.keys(FAMILY_DEFAULTS).join('|')})(?:[\w.\-[\]]*[\w\]])?`,
    String.raw`\bgpt-?\d(?:[\w.-]*\w)?`,
    String.raw`\bgpt-[a-z](?:[\w.-]*\w)?`,
    String.raw`\b(?:${[...Object.keys(FAMILY_DEFAULTS), ...Object.keys(CODEX_FAMILY_DEFAULTS)].join('|')})(?:[\d.-]*\d)?\b`,
    String.raw`\bo[134]-(?:mini|pro)\b`,
    String.raw`\b(?:gemini|kimi|qwen|deepseek|glm|llama|mistral|grok)-?[\w.]*\d(?:[\w.-]*\w)?`,
    String.raw`\b(?:xhigh|ultracode)\b`,
    String.raw`effort(?:[\s_]level)?[${'`'}'"]?\s*(?:[:=]|to\b|of\b|at\b)?\s*[${'`'}'"]?(?:${EFFORT_LEVEL})\b`,
    String.raw`\b(?:${EFFORT_LEVEL})[\s${'`'}'"-]{1,3}effort\b`,
  ].join('|'),
  'gi',
);

interface ModelNameExemption {
  file: string;
  names: string[];
  reason: string;
}

const MODEL_NAME_EXEMPTIONS: ModelNameExemption[] = [
  {
    file: 'container/skills/remotion/SKILL.md',
    names: ['gpt-4o-mini-tts'],
    reason: 'the OpenAI text-to-speech model the skill calls for narration, not a model an agent runs on',
  },
  {
    file: 'container/skills/pr-review-loop/SKILL.md',
    names: [
      'opus',
      'sonnet',
      'haiku',
      'fable',
      'luna',
      'terra',
      'gpt-6-astra',
      'gemini-3.8-flash',
      'gemini-3.5-flash-lite',
      'claude-opus-5',
      'deepseek-v4.1-flash',
    ],
    reason:
      "the reviewer-tier policy names the tiers codex-review.sh admits and refuses, its receipt examples and precheck-opencode.sh's default",
  },
  {
    file: 'container/skills/pr-review-loop/SKILL.md',
    names: ['gpt-6.1-sol', 'high` effort', 'effort=high', 'effort_level=high', 'effort high'],
    reason: 'a reviewer model and effort pinned in prose rather than config; tracked in issue 1580',
  },
];

function walkFiles(root: string, dir: string): string[] {
  if (!fs.existsSync(path.join(root, dir))) return [];
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = path.posix.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' || entry.name === '.git' ? [] : walkFiles(root, file);
    return entry.isFile() ? [file] : [];
  });
}

export function modelNameFindings(
  root: string,
  exempt: Exempt,
  exemptions: ModelNameExemption[] = MODEL_NAME_EXEMPTIONS,
): Finding[] {
  const used = new Set<string>();
  const findings: Finding[] = [];
  const files = walkFiles(root, 'container')
    .filter((file) => INSTRUCTION_FILE.test(file) && !isExempt(exempt, file))
    .sort();
  for (const file of files) {
    const allowed = new Set(
      exemptions.filter((e) => e.file === file).flatMap((e) => e.names.map((n) => n.toLowerCase())),
    );
    fs.readFileSync(path.join(root, file), 'utf8')
      .split('\n')
      .forEach((text, index) => {
        for (const [match] of text.matchAll(MODEL_OR_EFFORT)) {
          if (allowed.has(match.toLowerCase())) {
            used.add(`${file}\0${match.toLowerCase()}`);
            continue;
          }
          findings.push({
            check: 'instructions',
            kind: 'model-name',
            location: `${file}:${index + 1}`,
            message: match,
          });
        }
      });
  }
  for (const { file, names } of exemptions) {
    for (const name of names) {
      if (used.has(`${file}\0${name.toLowerCase()}`)) continue;
      findings.push({
        check: 'instructions',
        kind: 'stale-exemption',
        location: file,
        message: `${name} no longer appears; remove it from the list`,
      });
    }
  }
  return findings;
}

const INSTRUCTION_FILE_NAMES = new Set(['CLAUDE.md', 'AGENTS.md', 'CLAUDE.local.md']);

/** Tracked instruction files, each read once through its real path, so a link and its target are one file. */
function trackedInstructionFiles(root: string): string[] {
  const listed = git(root, ['ls-files', '-z', '--', '*CLAUDE.md', '*AGENTS.md', '*CLAUDE.local.md']);
  if (listed.error || listed.status !== 0) {
    throw new Error(`git ls-files failed in ${root}: ${listed.error?.message ?? listed.stderr.trim()}`);
  }
  const rootReal = fs.realpathSync(root);
  const files = new Map<string, string>();
  for (const file of listed.stdout.split('\0').filter((f) => INSTRUCTION_FILE_NAMES.has(path.posix.basename(f)))) {
    let real: string;
    try {
      real = fs.realpathSync(path.join(root, file));
    } catch (err) {
      if (MISSING_PATH_CODES.has((err as NodeJS.ErrnoException).code ?? '')) continue;
      throw err;
    }
    const rel = path.relative(rootReal, real).split(path.sep).join('/');
    if (!rel.startsWith('../') && !files.has(rel)) files.set(rel, real);
  }
  return [...files.keys()].sort();
}

/** An `@`-import in a hand-written instruction file reaches Claude expanded and Codex/OpenCode as literal text. */
export function atImportFindings(root: string, exempt: Exempt): Finding[] {
  return trackedInstructionFiles(root)
    .filter((file) => !isExempt(exempt, file))
    .flatMap((file) =>
      findAtImports(fs.readFileSync(path.join(root, file), 'utf8'), path.dirname(path.join(root, file))).map(
        ({ line, target }) => ({
          check: 'instructions' as const,
          kind: 'at-import',
          location: `${file}:${line}`,
          message: `@${target} is expanded by Claude only; link the doc in prose instead`,
        }),
      ),
    );
}

const TEST_ROOTS = ['src', 'setup', 'scripts', 'container', 'dashboard', 'tests', '.claude/skills'];
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const MODULE_LOADERS = new Set([
  'require',
  'require.resolve',
  'vi.mock',
  'vi.doMock',
  'vi.unmock',
  'vi.doUnmock',
  'vi.importActual',
  'vi.importMock',
  'mock.module',
]);
/** A worktree or session-scratch prefix resolves only on the machine, and in the checkout, that wrote the test. */
const AUTHORING_PATH = /\/home\/|\/tmp\/claude-/;

function moduleSpecifiers(file: string, text: string): ts.Expression[] {
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const specifiers: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
      specifiers.push(node.moduleSpecifier);
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) {
      specifiers.push(node.argument.literal);
    } else if (ts.isCallExpression(node) && node.arguments[0]) {
      const callee = node.expression;
      if (callee.kind === ts.SyntaxKind.ImportKeyword || MODULE_LOADERS.has(callee.getText(sourceFile))) {
        specifiers.push(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return specifiers;
}

const specifierText = (node: ts.Expression) =>
  ts.isStringLiteralLike(node) ? node.text : ts.isTemplateExpression(node) ? node.getText().slice(1, -1) : '';

export function testImportFindings(root: string): Finding[] {
  const files = TEST_ROOTS.flatMap((dir) => walkFiles(root, dir))
    .filter((file) => TEST_FILE.test(file))
    .sort();
  return files.flatMap((file) =>
    moduleSpecifiers(file, fs.readFileSync(path.join(root, file), 'utf8'))
      .filter((specifier) => AUTHORING_PATH.test(specifierText(specifier)))
      .map((specifier) => {
        const sourceFile = specifier.getSourceFile();
        const line = sourceFile.getLineAndCharacterOfPosition(specifier.getStart(sourceFile)).line + 1;
        return {
          check: 'test-imports' as const,
          kind: 'absolute-import',
          location: `${file}:${line}`,
          message: specifierText(specifier),
        };
      }),
  );
}

const GROWTH_BASE_REF = 'origin/main';

export interface CommentGrowth {
  base: string;
  files: { file: string; base: number; head: number }[];
}

function git(root: string, args: string[]): SpawnSyncReturns<string> {
  return spawnSync('git', args, toolOptions(root));
}

export function growthBase(root: string): string {
  const result = git(root, ['merge-base', 'HEAD', GROWTH_BASE_REF]);
  if (result.error || result.status !== 0) {
    const reason = result.error?.message ?? (result.stderr ?? '').trim();
    throw new Error(
      `hygiene: cannot find the merge base of HEAD and ${GROWTH_BASE_REF} to measure comment growth from; fetch ${GROWTH_BASE_REF} with history (${reason})`,
    );
  }
  return result.stdout.trim();
}

/** Every changed non-test TS/JS file, not only the scanned roots; uncommitted and untracked files count. */
export function commentGrowth(root: string, base: string, exempt: Exempt): CommentGrowth {
  const listed = (args: string[]) => stdoutOf('git', git(root, args)).split('\0').filter(Boolean);
  const changed = new Set([
    ...listed(['diff', '--name-only', '--no-renames', '-z', base]),
    ...listed(['ls-files', '--others', '--exclude-standard', '-z']),
  ]);
  const count = (file: string, text: string | null) => (text === null ? 0 : scanComments(file, text).commentOnlyLines);
  const files = [...changed]
    .filter((file) => isNonTestSource(file) && !isExempt(exempt, file))
    .sort()
    .map((file) => {
      const atBase = git(root, ['cat-file', 'blob', `${base}:${file}`]);
      const onDisk = fs.lstatSync(path.join(root, file), { throwIfNoEntry: false })?.isFile()
        ? fs.readFileSync(path.join(root, file), 'utf8')
        : null;
      return { file, base: count(file, atBase.status === 0 ? atBase.stdout : null), head: count(file, onDisk) };
    });
  return { base, files };
}

function printGrowth(growth: CommentGrowth): void {
  const base = growth.files.reduce((sum, file) => sum + file.base, 0);
  const head = growth.files.reduce((sum, file) => sum + file.head, 0);
  const net = head - base;
  console.log(
    `\ncomment growth since ${growth.base.slice(0, 12)} (for review, never a failure): ${growth.files.length} changed source file(s), ` +
      `comment-only lines base ${base}, head ${head}, net ${net > 0 ? '+' : ''}${net}`,
  );
  const gains = growth.files
    .map((file) => ({ file: file.file, gain: file.head - file.base }))
    .filter((file) => file.gain > 0)
    .sort((a, b) => b.gain - a.gain || a.file.localeCompare(b.file))
    .slice(0, 10);
  for (const { file, gain } of gains) console.log(`  +${gain}  ${file}`);
}

/** Every finding the tree owns: exempt files are still analysed, so knip and jscpd see their references. */
export function hygieneFindings(root: string, exempt: Exempt): Finding[] {
  const files = sourceFiles(root);
  const knip = KNIP_WORKSPACES.flatMap((workspace) => knipFindings(root, workspace)).filter(
    (finding) => !isExempt(exempt, finding.location.replace(/:\d+$/, '')),
  );
  return [
    ...knip,
    ...jscpdFindings(root, files, exempt),
    ...commentFindings(
      root,
      files.filter((file) => !isExempt(exempt, file)),
    ),
    ...modelNameFindings(root, exempt),
    ...atImportFindings(root, exempt),
    ...testImportFindings(root),
  ];
}

function print(findings: Finding[]): void {
  for (const check of ['knip', 'jscpd', 'comments', 'instructions', 'test-imports'] as const) {
    const group = findings.filter((finding) => finding.check === check);
    const kinds = new Map<string, number>();
    for (const finding of group) kinds.set(finding.kind, (kinds.get(finding.kind) ?? 0) + 1);
    const breakdown = [...kinds].map(([kind, count]) => `${kind} ${count}`).join(', ');
    console.log(`\n${check}: ${group.length} finding(s)${breakdown ? ` (${breakdown})` : ''}`);
    for (const finding of group) console.log(`  ${finding.kind}  ${finding.location}  ${finding.message}`);
  }
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== '--report')) {
    console.error('usage: pnpm exec tsx scripts/hygiene/run.ts [--report]');
    process.exit(2);
  }
  for (const workspace of KNIP_WORKSPACES) {
    if (fs.existsSync(path.join(REPO_ROOT, workspace, 'node_modules'))) continue;
    // Without installed packages knip cannot see peer dependencies and reports them as unused.
    console.error(`hygiene: install ${path.posix.join(workspace, 'node_modules')} first; knip's results depend on it`);
    process.exit(2);
  }
  const exempt = exemptFiles(REPO_ROOT);
  const growth = commentGrowth(REPO_ROOT, growthBase(REPO_ROOT), exempt);
  const findings = hygieneFindings(REPO_ROOT, exempt);
  print(findings);
  console.log(
    `\nexempt: ${exempt.upstream.size} file(s) byte-identical to upstream, ${exempt.vendored.size} vendored design-review file(s)`,
  );
  printGrowth(growth);
  const report = args.includes('--report');
  console.log(`\nhygiene: ${findings.length} finding(s)${report ? ' (report mode, not failing)' : ''}`);
  process.exitCode = findings.length > 0 && !report ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
