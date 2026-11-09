import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runExport, type StatusFields } from './export-flow.js';
import type { RunReport } from '../check-public-boundary.js';
import { judgeCommit } from './gate.js';
import {
  authorPublicNames,
  buildDeps,
  imageTag,
  loadAiHolds,
  loadExportPolicy,
  parseAuthor,
  policyDir,
} from './run.js';

function gitInit(dir: string): void {
  execFileSync('git', ['init', '-q', dir], {
    env: { PATH: process.env.PATH ?? '', HOME: dir, GIT_CONFIG_NOSYSTEM: '1' },
  });
}

describe('buildDeps', () => {
  it('makes an existing held-detail directory private before writing into it', () => {
    const heldDir = path.join(dir, 'logs', 'public-export');
    fs.mkdirSync(heldDir, { recursive: true, mode: 0o775 });
    fs.chmodSync(heldDir, 0o775);
    const deps = buildDeps({
      workDir: dir,
      statusFile: path.join(dir, 'logs', 'status.json'),
      heldDetailFile: path.join(heldDir, 'held.json'),
      acceptedDetailFile: path.join(heldDir, 'accepted.json'),
      publicRemote: undefined,
      install: { installRoot: dir, dbPath: '', identifiersPath: '', allowlistPath: '' },
      aiMaxChars: 1000,
      aiMaxCalls: 15,
      ai: { model: 'claude-opus-5-5', timeoutMs: 1000 },
      operatorNames: [],
      redact: [],
    });
    deps.writeHeldDetail({ sha: 'abc', aiFindings: [] });
    expect(fs.statSync(heldDir).mode & 0o777).toBe(0o700);
  });

  it('writes accepted findings for audit as a private file in a private directory', () => {
    const acceptedDetailFile = path.join(dir, 'logs', 'public-export', 'accepted.json');
    const deps = buildDeps({
      workDir: dir,
      statusFile: path.join(dir, 'logs', 'status.json'),
      heldDetailFile: path.join(dir, 'logs', 'public-export', 'held.json'),
      acceptedDetailFile,
      publicRemote: undefined,
      install: { installRoot: dir, dbPath: '', identifiersPath: '', allowlistPath: '' },
      aiMaxChars: 1000,
      aiMaxCalls: 15,
      ai: { model: 'claude-opus-5-5', timeoutMs: 1000 },
      operatorNames: [],
      redact: [],
    });
    const finding = { file: 'a.ts', line: 1, text: 'widget', why: 'looks private' };
    deps.writeAcceptedDetail([{ sha: 'abc', finding }]);
    expect(fs.statSync(path.dirname(acceptedDetailFile)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(acceptedDetailFile).mode & 0o777).toBe(0o600);
    expect(JSON.parse(fs.readFileSync(acceptedDetailFile, 'utf8'))).toMatchObject({
      accepted: [{ sha: 'abc', finding }],
    });
  });

  it('creates a private directory for the held detail file', () => {
    const heldDetailFile = path.join(dir, 'logs', 'nested', 'held.json');
    const deps = buildDeps({
      workDir: dir,
      statusFile: path.join(dir, 'logs', 'status.json'),
      heldDetailFile,
      acceptedDetailFile: path.join(dir, 'logs', 'nested', 'accepted.json'),
      publicRemote: 'file:///nonexistent',
      install: { installRoot: dir, dbPath: '', identifiersPath: '', allowlistPath: '' },
      aiMaxChars: 1000,
      aiMaxCalls: 15,
      ai: { model: 'claude-opus-5-5', timeoutMs: 1000 },
      operatorNames: [],
      redact: [],
    });
    deps.writeHeldDetail({ sha: 'abc', aiFindings: [] });
    expect(fs.statSync(path.dirname(heldDetailFile)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(heldDetailFile).mode & 0o777).toBe(0o600);
  });

  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-export-run-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('turns an identifier-loading failure into a failed status', async () => {
    gitInit(dir);
    const written: StatusFields[] = [];
    const staging: string[] = [];
    const deps = buildDeps({
      workDir: dir,
      statusFile: path.join(dir, 'status.json'),
      heldDetailFile: path.join(dir, 'held.json'),
      acceptedDetailFile: path.join(dir, 'accepted.json'),
      publicRemote: undefined,
      install: {
        installRoot: dir,
        dbPath: path.join(dir, 'missing.db'),
        identifiersPath: path.join(dir, 'missing-identifiers'),
        allowlistPath: path.join(dir, 'missing-allowlist.json'),
      },
      aiMaxChars: 1000,
      aiMaxCalls: 15,
      ai: { model: 'claude-opus-5-5', timeoutMs: 1000 },
      operatorNames: [],
      redact: [],
    });
    const code = await runExport({
      ...deps,
      writeStatus: (fields) => written.push(fields),
      clearStatus: () => {},
      stagingHead: () => staging.at(-1) ?? null,
      resetStaging: () => {},
      copybara: () => {
        staging.push('s2');
        return 0;
      },
      newCommits: () => ['s2'],
      originRev: () => 'a'.repeat(40),
    });
    expect(code).toBe(1);
    expect(written).toEqual([
      expect.objectContaining({ status: 'failed', error: expect.stringContaining('install registry') }),
    ]);
  });
});

describe('the AI hold store', () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'public-export-holds-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const config = () => ({
    workDir: dir,
    statusFile: path.join(dir, 'logs', 'status.json'),
    heldDetailFile: path.join(dir, 'logs', 'public-export', 'held.json'),
    acceptedDetailFile: path.join(dir, 'logs', 'public-export', 'accepted.json'),
    publicRemote: undefined,
    install: { installRoot: dir, dbPath: '', identifiersPath: '', allowlistPath: '' },
    aiMaxChars: 1000,
    aiMaxCalls: 15,
    ai: { model: 'claude-opus-5-5', timeoutMs: 1000 },
    operatorNames: [],
    redact: [],
  });
  const record = {
    originRev: 'a'.repeat(40),
    findings: [{ file: 'src/a.ts', text: 'use the zz-acme tile', why: 'client' }],
    texts: ['use the zz-acme tile'],
  };

  it('saves records privately beside the held detail and reads them back', () => {
    const deps = buildDeps(config());
    expect(deps.loadAiHolds()).toBeNull();
    deps.saveAiHolds([record]);
    const file = path.join(dir, 'logs', 'public-export', 'ai-holds.json');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(deps.loadAiHolds()).toEqual([record]);
  });

  it('fails the run when a store a run wrote before is missing, instead of starting empty', () => {
    const deps = buildDeps(config());
    deps.saveAiHolds([record]);
    fs.rmSync(path.join(dir, 'logs'), { recursive: true });
    expect(() => deps.loadAiHolds()).toThrow(/missing, but a run wrote it before/);
  });

  it('marks a store written before the marker existed the first time it is read', () => {
    const file = path.join(dir, 'logs', 'public-export', 'ai-holds.json');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify([record]));
    const deps = buildDeps(config());
    expect(deps.loadAiHolds()).toEqual([record]);
    fs.rmSync(path.join(dir, 'logs'), { recursive: true });
    expect(() => deps.loadAiHolds()).toThrow(/missing, but a run wrote it before/);
  });

  it('accepts a record whose commit could not be resolved', () => {
    const file = path.join(dir, 'ai-holds.json');
    fs.writeFileSync(file, JSON.stringify([{ ...record, originRev: null, texts: null }]));
    expect(loadAiHolds(file)).toEqual([{ ...record, originRev: null, texts: null }]);
  });

  it('accepts a record whose quotes are the parts of an elided finding', () => {
    const file = path.join(dir, 'ai-holds.json');
    const elided = {
      ...record,
      findings: [{ ...record.findings[0], text: 'use the zz-acme … zz-acme tile' }],
      texts: ['use the zz-acme', 'zz-acme tile'],
    };
    fs.writeFileSync(file, JSON.stringify([elided]));
    expect(loadAiHolds(file)).toEqual([elided]);
  });

  it.each([
    ['not JSON', '{'],
    ['not an array', '{}'],
    ['a record with no origin', JSON.stringify([{ ...record, originRev: 'main' }])],
    ['a record with an empty quote', JSON.stringify([{ ...record, texts: [''] }])],
    ['JSON null', 'null'],
    ['a record with quotes but no resolved commit', JSON.stringify([{ ...record, originRev: null }])],
    ['a pending record that claims quotes', JSON.stringify([{ ...record, pending: true }])],
    ['a record with no quotes to check', JSON.stringify([{ ...record, texts: [] }])],
    ["a record whose quote is not its finding's", JSON.stringify([{ ...record, texts: ['an unrelated safe quote'] }])],
    ['a record with fewer quotes than findings', JSON.stringify([{ ...record, findings: [], texts: record.texts }])],
    [
      'a record with a finding none of its quotes stands for',
      JSON.stringify([{ ...record, findings: [...record.findings, { file: 'src/b.ts', text: 'another zz-acme line' }] }]),
    ],
    ['a record with a quote too short to stand for its line', JSON.stringify([{ ...record, texts: ['zz-acme'] }])],
    ['a record quoting part of a finding that elides nothing', JSON.stringify([{ ...record, texts: ['use the zz-acme'] }])],
  ])('fails the run on a store that is %s', (_name, text) => {
    const file = path.join(dir, 'ai-holds.json');
    fs.writeFileSync(file, text);
    expect(() => loadAiHolds(file)).toThrow();
  });

  it('keeps a dry run from replacing the held detail a new store is seeded from', () => {
    const live = buildDeps({ ...config(), publicRemote: 'file:///nonexistent' });
    live.writeHeldDetail({ sha: 'abc', aiFindings: record.findings });
    buildDeps(config()).writeHeldDetail({ sha: 'dry', aiFindings: [] });
    expect(live.readHeldDetail()).toEqual({ sha: 'abc', aiFindings: record.findings });
    expect(fs.existsSync(path.join(dir, 'logs', 'public-export', 'held.dry-run.json'))).toBe(true);
  });

  it('reads the last held detail, and nothing when there is none', () => {
    const deps = buildDeps({ ...config(), publicRemote: 'file:///nonexistent' });
    expect(deps.readHeldDetail()).toBeNull();
    deps.writeHeldDetail({ sha: 'abc', aiFindings: record.findings });
    expect(deps.readHeldDetail()).toEqual({ sha: 'abc', aiFindings: record.findings });
  });
});

describe('imageTag', () => {
  it('changes whenever the Dockerfile changes, so a Copybara bump cannot reuse the old image', () => {
    const before = 'FROM x\nARG COPYBARA_RELEASE=v1\n';
    expect(imageTag(before)).toBe(imageTag(before));
    expect(imageTag(before.replace('v1', 'v2'))).not.toBe(imageTag(before));
  });
});

describe('authorPublicNames', () => {
  it('takes only the full author name and the GitHub noreply login, never a single word of the name', () => {
    expect(authorPublicNames(parseAuthor('Op Erator <123+op-erator@users.noreply.github.com>'))).toEqual([
      'Op Erator',
      'op-erator',
    ]);
  });

  it('takes no login from an address that is not a GitHub noreply address', () => {
    expect(authorPublicNames(parseAuthor('Op Erator <op@example.com>'))).toEqual(['Op Erator']);
  });
});

describe('export policy comes from the install, never from the tree being judged', () => {
  const grant = (file: string) =>
    ({
      'public-export-public-names.txt': 'Zzclientcorp\n',
      'public-export-accepted-findings.json': JSON.stringify([
        { path: 'src/leak.ts', line: 'export const zzclientcorp = 1;', reason: 'self-granted' },
      ]),
      'public-export-approved-binaries.txt': `${'a'.repeat(40)} logo.png\n`,
    })[file];
  const files = [
    'public-export-public-names.txt',
    'public-export-accepted-findings.json',
    'public-export-approved-binaries.txt',
  ];

  it('ignores exemption files a commit carries in its own tree, so it still holds', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-export-policy-'));
    try {
      const tree = path.join(root, 'tree');
      fs.mkdirSync(path.join(tree, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tree, 'src', 'leak.ts'), 'export const zzclientcorp = 1;\n');
      for (const dir of [path.join(tree, '.nanoclaw'), path.join(tree, 'scripts', 'public-export')]) {
        fs.mkdirSync(dir, { recursive: true });
        for (const file of files) fs.writeFileSync(path.join(dir, file), grant(file)!);
      }
      const install = path.join(root, 'install');
      fs.mkdirSync(policyDir(install), { recursive: true });
      gitInit(install);

      const policy = loadExportPolicy(install);
      expect(policy).toEqual({ publicNames: [], acceptedFindings: [], approvedBinaries: new Set() });

      const clean = (): RunReport => ({
        findings: [],
        mode: 'install-aware',
        registryOrigin: 'explicit',
        identifiersOrigin: 'explicit',
        registryPathsTried: [],
        identifiersPathsTried: [],
        baseline: { held: 0, heldFiles: 0, exceeded: [], below: [], counts: {}, missing: false },
        discoveryProblems: [],
        contextOnlyIdentifiers: 0,
      });
      const finding = { file: 'src/leak.ts', line: 1, text: 'zzclientcorp', why: 'client name' };
      const verdict = await judgeCommit(
        {
          sha: 'c1',
          message: 'feat: leak',
          treeDir: tree,
          addedLines: ['src/leak.ts:1: export const zzclientcorp = 1;'],
          binaries: [],
        },
        {
          scanTree: clean,
          scanMessage: clean,
          aiRead: async () => ({
            exitCode: 0,
            timedOut: false,
            stdout: JSON.stringify({
              subtype: 'success',
              is_error: false,
              structured_output: { verdict: 'hold', findings: [finding] },
            }),
          }),
          aiMaxChars: 10_000,
          approvedBinaries: policy.approvedBinaries,
          acceptedFindings: policy.acceptedFindings,
          aiBudget: { cap: 15, spent: 0 },
        },
      );
      expect(verdict).toMatchObject({ verdict: 'hold', aiFindings: [finding] });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads all three lists from the install policy directory', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-export-policy-'));
    try {
      const dir = policyDir(root);
      fs.mkdirSync(dir, { recursive: true });
      gitInit(root);
      for (const file of files) fs.writeFileSync(path.join(dir, file), grant(file)!);
      expect(loadExportPolicy(root)).toEqual({
        publicNames: ['Zzclientcorp'],
        acceptedFindings: [{ path: 'src/leak.ts', line: 'export const zzclientcorp = 1;', reason: 'self-granted' }],
        approvedBinaries: new Set(['a'.repeat(40)]),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the run when a commit force-added a policy file the install then pulled', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-export-policy-'));
    const env = { PATH: process.env.PATH ?? '', HOME: root, GIT_CONFIG_NOSYSTEM: '1' };
    try {
      fs.mkdirSync(policyDir(root), { recursive: true });
      gitInit(root);
      fs.writeFileSync(path.join(root, '.gitignore'), '.nanoclaw/\n');
      fs.writeFileSync(path.join(policyDir(root), files[1]), grant(files[1])!);
      execFileSync('git', ['-C', root, 'add', '-f', '.gitignore', `.nanoclaw/${files[1]}`], { env });
      expect(() => loadExportPolicy(root)).toThrow(/must be untracked.*public-export-accepted-findings\.json/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails the run when the install is not a git checkout it can inspect', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'public-export-policy-'));
    try {
      expect(() => loadExportPolicy(root)).toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps the policy directory out of git, so no commit can carry it', () => {
    const repo = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');
    const ignore = fs.readFileSync(path.join(repo, '.gitignore'), 'utf8').split('\n');
    expect(path.relative(repo, policyDir(repo))).toBe('.nanoclaw');
    expect(ignore).toContain('.nanoclaw/');
  });
});
