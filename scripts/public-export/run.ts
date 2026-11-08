import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { notifyOwner } from '../../src/notify-owner.js';
import { alertOwner, type AlertDeps } from './alert.js';
import {
  failedStatus,
  isAiHoldRecord,
  redactText,
  runExport,
  type AiHoldRecord,
  type ExportDeps,
  type Status,
  type StatusFields,
} from './export-flow.js';
import {
  gateCommits,
  knownPrivateNames,
  messageIsClean,
  loadAcceptedFindings,
  loadApprovedBinaries,
  loadPublicNames,
  loadStagingCommit,
  stagingCommitDiff,
  stagingFileAt,
  stagingMentions,
  stagingOriginRev,
  realAiRead,
  realScanners,
  type AcceptedFinding,
  type AiFinding,
  type AiReadOptions,
  type InstallPaths,
} from './gate.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_AI_MAX_CHARS = 400_000;
const DEFAULT_AI_MODEL = 'claude-opus-5-5';
const DEFAULT_AI_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_AI_MAX_CALLS = 15;

export function imageTag(dockerfile: string): string {
  return `nanoclaw-public-export:${createHash('sha256').update(dockerfile).digest('hex').slice(0, 16)}`;
}

const IMAGE = imageTag(fs.readFileSync(path.join(HERE, 'Dockerfile'), 'utf8'));

function git(gitDir: string, args: string[]): string {
  return execFileSync('git', ['--git-dir', gitDir, ...args], { encoding: 'utf8' }).trim();
}

function headOf(gitDir: string): string | null {
  const result = spawnSync('git', ['--git-dir', gitDir, 'rev-parse', '--verify', '-q', 'refs/heads/main'], {
    encoding: 'utf8',
  });
  return result.status === 0 ? result.stdout.trim() : null;
}

export interface Author {
  name: string;
  email: string;
}

export function parseAuthor(raw: string | undefined): Author {
  const match = /^([^<>"\n]+?)\s*<([^<>"\s]+@[^<>"\s]+)>$/.exec(raw?.trim() ?? '');
  if (!match) throw new Error('PUBLIC_EXPORT_AUTHOR must be set to "Name <email>"');
  return { name: match[1], email: match[2] };
}

/** The identity every public commit already carries: the full author name and a GitHub noreply login. */
export function authorPublicNames(author: Author): string[] {
  const names = [author.name];
  const login = /^(?:\d+\+)?([A-Za-z0-9-]+)@users\.noreply\.github\.com$/i.exec(author.email)?.[1];
  if (login) names.push(login);
  return [...new Set(names.filter(Boolean))];
}

function ensureImage(): void {
  if (spawnSync('docker', ['image', 'inspect', IMAGE], { stdio: 'ignore' }).status === 0) return;
  execFileSync('docker', ['build', '-q', '-t', IMAGE, HERE], {
    stdio: 'inherit',
    env: { ...process.env, DOCKER_BUILDKIT: '1' },
  });
}

function copybara(workDir: string, workflow: string, extra: string[]): number {
  const uid = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  const result = spawnSync(
    'docker',
    [
      'run',
      '--rm',
      '-u',
      uid,
      '-e',
      `HOME=${workDir}/home`,
      '-v',
      `${workDir}:${workDir}`,
      '-w',
      workDir,
      IMAGE,
      'migrate',
      'copy.bara.sky',
      workflow,
      'main',
      '--ignore-noop',
      ...extra,
    ],
    { stdio: 'inherit' },
  );
  return result.status ?? 1;
}

function prepareWorkDir(workDir: string, privateUrl: string, publicRemote: string | undefined, author: Author): void {
  fs.mkdirSync(path.join(workDir, 'home'), { recursive: true });
  fs.writeFileSync(
    path.join(workDir, 'home', '.gitconfig'),
    `[user]\n\tname = ${author.name}\n\temail = ${author.email}\n`,
  );
  const origin = path.join(workDir, 'origin.git');
  if (!fs.existsSync(origin))
    execFileSync('git', ['clone', '-q', '--bare', '--single-branch', '-b', 'main', privateUrl, origin]);
  git(origin, ['fetch', '-q', privateUrl, '+refs/heads/main:refs/heads/main']);
  const staging = path.join(workDir, 'staging.git');
  if (!fs.existsSync(staging)) {
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', staging]);
    if (publicRemote) {
      const fetched = spawnSync('git', [
        '--git-dir',
        staging,
        'fetch',
        '-q',
        publicRemote,
        '+refs/heads/main:refs/heads/main',
      ]);
      if (fetched.status !== 0)
        process.stderr.write('public remote has no main yet; starting from an empty staging repo\n');
    }
  }
  const config = fs
    .readFileSync(path.join(HERE, 'copy.bara.sky'), 'utf8')
    .replaceAll('__ORIGIN_URL__', pathToFileURL(origin).href)
    .replaceAll('__STAGING_URL__', pathToFileURL(staging).href)
    .replaceAll('__AUTHOR__', `${author.name} <${author.email}>`);
  fs.writeFileSync(path.join(workDir, 'copy.bara.sky'), config);
}

export interface RunConfig {
  workDir: string;
  statusFile: string;
  heldDetailFile: string;
  acceptedDetailFile: string;
  publicRemote: string | undefined;
  install: InstallPaths;
  aiMaxChars: number;
  aiMaxCalls: number;
  ai: AiReadOptions;
  operatorNames: string[];
  redact: string[];
}

const POLICY_FILES = {
  publicNames: 'public-export-public-names.txt',
  acceptedFindings: 'public-export-accepted-findings.json',
  approvedBinaries: 'public-export-approved-binaries.txt',
} as const;

export function policyDir(installRoot: string): string {
  return path.join(installRoot, '.nanoclaw');
}

/**
 * The install is the checkout that pulls the private repository, so a policy file a commit force-adds under
 * `.nanoclaw/` would arrive there and grant its own exemption; only untracked files count as policy.
 */
export function loadExportPolicy(installRoot: string): {
  publicNames: string[];
  acceptedFindings: AcceptedFinding[];
  approvedBinaries: Set<string>;
} {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  const tracked = execFileSync('git', ['-C', installRoot, 'ls-files', '-z', '--', '.nanoclaw'], {
    encoding: 'utf8',
    env,
  })
    .split('\0')
    .filter(Boolean);
  if (tracked.length > 0) throw new Error(`export policy must be untracked, but git tracks: ${tracked.join(', ')}`);
  const dir = policyDir(installRoot);
  return {
    publicNames: loadPublicNames(path.join(dir, POLICY_FILES.publicNames)),
    acceptedFindings: loadAcceptedFindings(path.join(dir, POLICY_FILES.acceptedFindings)),
    approvedBinaries: loadApprovedBinaries(path.join(dir, POLICY_FILES.approvedBinaries)),
  };
}

/** Held and accepted findings may quote private text, so they stay in a private directory on the host. */
function writePrivate(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.chmodSync(path.dirname(file), 0o700);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600, flush: true });
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}

/** Undefined only when the file does not exist; anything unreadable throws. */
function readJson(file: string): unknown {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${file}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

/** A record that cannot be read would let its commit be read again, so a malformed store fails the run. */
export function loadAiHolds(file: string): AiHoldRecord[] | null {
  const parsed = readJson(file);
  if (parsed === undefined) return null;
  const valid = Array.isArray(parsed) && parsed.every(isAiHoldRecord);
  if (!valid) throw new Error(`${file}: expected an array of AI hold records`);
  return parsed as AiHoldRecord[];
}

export function buildDeps(config: RunConfig): ExportDeps {
  const aiHoldsFile = path.join(path.dirname(config.heldDetailFile), 'ai-holds.json');
  // Kept apart from the store, so losing the store's directory cannot also erase the sign that it existed.
  const storeWritten = path.join(config.workDir, 'ai-holds.written');
  // held.json seeds a store that does not exist yet, so a run that publishes nothing must not replace it.
  const dryRunHeldDetailFile = path.join(path.dirname(config.heldDetailFile), 'held.dry-run.json');
  const origin = path.join(config.workDir, 'origin.git');
  const staging = path.join(config.workDir, 'staging.git');
  const remote = config.publicRemote ?? '';
  const aiBudget = { cap: config.aiMaxCalls, spent: 0 };
  return {
    publicRemote: config.publicRemote !== undefined,
    redact: config.redact,
    writeStatus: (fields: StatusFields) => {
      fs.mkdirSync(path.dirname(config.statusFile), { recursive: true });
      const full: Status = { at: new Date().toISOString(), dryRun: config.publicRemote === undefined, ...fields };
      fs.writeFileSync(config.statusFile, JSON.stringify(full, null, 2) + '\n');
    },
    clearStatus: () => fs.rmSync(config.statusFile, { force: true }),
    writeHeldDetail: (detail) =>
      writePrivate(config.publicRemote === undefined ? dryRunHeldDetailFile : config.heldDetailFile, detail),
    writeAcceptedDetail: (accepted) =>
      writePrivate(config.acceptedDetailFile, { at: new Date().toISOString(), accepted }),
    stagingHead: () => headOf(staging),
    resetStaging: (sha) =>
      sha
        ? git(staging, ['update-ref', 'refs/heads/main', sha])
        : git(staging, ['update-ref', '-d', 'refs/heads/main']),
    copybara: (workflow, initHistory) =>
      copybara(config.workDir, workflow, initHistory ? ['--init-history', '--force'] : []),
    newCommits: (base, head) =>
      git(staging, ['rev-list', '--reverse', base ? `${base}..${head}` : head])
        .split('\n')
        .filter(Boolean),
    fileAt: (sha, file) => stagingFileAt(staging, sha, file),
    mentions: (sha, texts) => stagingMentions(staging, sha, texts),
    originRev: (sha) => stagingOriginRev(staging, sha),
    originContains: (head, rev) =>
      spawnSync('git', ['--git-dir', origin, 'merge-base', '--is-ancestor', rev, head]).status === 0,
    loadAiHolds: () => {
      const records = loadAiHolds(aiHoldsFile);
      if (records === null && fs.existsSync(storeWritten)) {
        throw new Error(`${aiHoldsFile} is missing, but a run wrote it before; restore it rather than lose its holds`);
      }
      if (records !== null) fs.writeFileSync(storeWritten, '');
      return records;
    },
    saveAiHolds: (records) => {
      writePrivate(aiHoldsFile, records);
      fs.writeFileSync(storeWritten, '');
    },
    readHeldDetail: () => {
      const detail = readJson(config.heldDetailFile) as { sha?: unknown; aiFindings?: unknown } | null | undefined;
      if (detail === undefined) return null;
      if (typeof detail?.sha !== 'string' || !Array.isArray(detail.aiFindings)) {
        throw new Error(`${config.heldDetailFile}: expected { sha, aiFindings }`);
      }
      return { sha: detail.sha, aiFindings: detail.aiFindings as AiFinding[] };
    },
    gate: async (shas, watch) => {
      const policy = loadExportPolicy(config.install.installRoot);
      const publicNames = [...policy.publicNames, ...config.operatorNames];
      const names = knownPrivateNames(config.install, publicNames);
      const scanners = realScanners(config.install);
      try {
        return await gateCommits(
          shas,
          (sha) => loadStagingCommit(staging, sha),
          {
            scanTree: scanners.scanTree,
            scanMessage: scanners.scanMessage,
            aiRead: realAiRead(names, config.ai, publicNames),
            aiMaxChars: config.aiMaxChars,
            approvedBinaries: policy.approvedBinaries,
            acceptedFindings: policy.acceptedFindings,
            aiBudget,
          },
          (sha) => stagingCommitDiff(staging, sha),
          watch,
        );
      } finally {
        scanners.dispose();
      }
    },
    remoteHead: () => {
      if (!git(staging, ['ls-remote', remote, 'refs/heads/main'])) return null;
      git(staging, ['fetch', '-q', remote, '+refs/heads/main:refs/remotes/public/main']);
      return git(staging, ['rev-parse', 'refs/remotes/public/main']);
    },
    push: (sha) => {
      git(staging, ['push', '-q', remote, `${sha}:refs/heads/main`]);
    },
  };
}

function alertDeps(config: RunConfig): AlertDeps {
  const origin = path.join(config.workDir, 'origin.git');
  return {
    recordFile: path.join(path.dirname(config.statusFile), 'public-export-alert.json'),
    heldDetailLabel: path.relative(config.install.installRoot, config.heldDetailFile),
    origin: (sha) => {
      try {
        const rev = stagingOriginRev(path.join(config.workDir, 'staging.git'), sha);
        if (!rev) return null;
        return { rev, subject: redactText(git(origin, ['log', '-1', '--format=%s', rev]), config.redact) };
      } catch {
        return null;
      }
    },
    quotes: () => {
      const texts = (findings: unknown): string[] =>
        Array.isArray(findings)
          ? findings.flatMap((finding: { text?: unknown } | null) =>
              typeof finding?.text === 'string' ? [finding.text] : [],
            )
          : [];
      const detail = readJson(config.heldDetailFile) as { aiFindings?: unknown } | undefined;
      const records = loadAiHolds(path.join(path.dirname(config.heldDetailFile), 'ai-holds.json')) ?? [];
      return [
        ...texts(detail?.aiFindings),
        ...records.flatMap((record) => [...(record.texts ?? []), ...texts(record.findings)]),
      ];
    },
    isClean: (text) => {
      const scanners = realScanners(config.install);
      try {
        return messageIsClean(scanners.scanMessage(text));
      } finally {
        scanners.dispose();
      }
    },
    notify: (title, body) =>
      notifyOwner({ title, body, dbPath: config.install.dbPath, rootDir: config.install.installRoot }),
  };
}

async function alert(config: RunConfig): Promise<void> {
  try {
    let status: Status | null = null;
    try {
      status = (readJson(config.statusFile) as Status | undefined) ?? null;
    } catch {
      status = null;
    }
    const outcome = await alertOwner(status, config.publicRemote === undefined, alertDeps(config));
    if (outcome === 'undelivered') process.stderr.write('public export: the owner alert was not delivered\n');
  } catch (error) {
    process.stderr.write(
      `public export: owner alert failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}

async function main(): Promise<number> {
  const installRoot = path.resolve(process.env.NANOCLAW_DIR ?? path.join(HERE, '..', '..'));
  const logDir = path.resolve(process.env.PUBLIC_EXPORT_LOG_DIR ?? path.join(installRoot, 'logs'));
  const config: RunConfig = {
    workDir: path.resolve(process.env.PUBLIC_EXPORT_WORKDIR ?? path.join(installRoot, 'data', 'public-export')),
    statusFile: path.join(logDir, 'public-export-status.json'),
    heldDetailFile: path.join(logDir, 'public-export', 'held.json'),
    acceptedDetailFile: path.join(logDir, 'public-export', 'accepted.json'),
    publicRemote: process.env.PUBLIC_EXPORT_REMOTE || undefined,
    install: {
      installRoot,
      dbPath: path.join(installRoot, 'data', 'v2.db'),
      identifiersPath: path.join(policyDir(installRoot), 'public-boundary-identifiers'),
      allowlistPath: path.join(installRoot, '.public-boundary-allowlist.json'),
    },
    aiMaxChars: Number(process.env.PUBLIC_EXPORT_AI_MAX_CHARS ?? DEFAULT_AI_MAX_CHARS),
    aiMaxCalls: Number(process.env.PUBLIC_EXPORT_AI_MAX_CALLS ?? DEFAULT_AI_MAX_CALLS),
    ai: {
      model: process.env.PUBLIC_EXPORT_AI_MODEL || DEFAULT_AI_MODEL,
      timeoutMs: Number(process.env.PUBLIC_EXPORT_AI_TIMEOUT_MS ?? DEFAULT_AI_TIMEOUT_MS),
    },
    operatorNames: [],
    redact: [process.env.PUBLIC_EXPORT_REMOTE ?? '', process.env.PUBLIC_EXPORT_PRIVATE_URL ?? ''],
  };

  try {
    if (!Number.isInteger(config.ai.timeoutMs) || config.ai.timeoutMs <= 0) {
      throw new Error('PUBLIC_EXPORT_AI_TIMEOUT_MS must be a positive integer');
    }
    if (!Number.isInteger(config.aiMaxCalls) || config.aiMaxCalls <= 0) {
      throw new Error('PUBLIC_EXPORT_AI_MAX_CALLS must be a positive integer');
    }
    const author = parseAuthor(process.env.PUBLIC_EXPORT_AUTHOR);
    config.operatorNames = authorPublicNames(author);
    const privateUrl =
      process.env.PUBLIC_EXPORT_PRIVATE_URL ??
      execFileSync('git', ['-C', installRoot, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
    config.redact.push(privateUrl);
    ensureImage();
    prepareWorkDir(config.workDir, privateUrl, config.publicRemote, author);
  } catch (error) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const full: Status = {
        at: new Date().toISOString(),
        dryRun: config.publicRemote === undefined,
        ...failedStatus(error, config.redact),
      };
      fs.writeFileSync(config.statusFile, JSON.stringify(full, null, 2) + '\n');
    } catch {
      fs.rmSync(config.statusFile, { force: true });
    }
    await alert(config);
    return 1;
  }

  const code = await runExport(buildDeps(config));
  await alert(config);
  return code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
