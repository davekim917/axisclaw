import fs from 'fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const logMock = vi.hoisted(() => ({ warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('./log.js', () => ({ log: logMock, setLogScrubber: vi.fn() }));

import {
  checkNeutralReviewerRepos,
  malformedNeutralReviewerRepos,
  neutralReviewerReposEnvArgs,
} from './neutral-reviewer-repos.js';

const KEY = 'CODEX_REVIEW_NEUTRAL_REVIEWER_REPOS';

describe('neutral reviewer repos at spawn', () => {
  it('forwards the host value verbatim when set', () => {
    expect(neutralReviewerReposEnvArgs({ [KEY]: 'ExampleOrg/web, ExampleOrg/data' })).toEqual([
      '-e',
      `${KEY}=ExampleOrg/web, ExampleOrg/data`,
    ]);
  });

  it('forwards a malformed value too, so the skill can fail closed on it', () => {
    expect(neutralReviewerReposEnvArgs({ [KEY]: 'ExampleOrg' })).toEqual(['-e', `${KEY}=ExampleOrg`]);
  });

  it('adds nothing when unset, empty or blank', () => {
    expect(neutralReviewerReposEnvArgs({})).toEqual([]);
    expect(neutralReviewerReposEnvArgs({ [KEY]: '' })).toEqual([]);
    expect(neutralReviewerReposEnvArgs({ [KEY]: '  ' })).toEqual([]);
  });

  it('is emitted by the agent spawn branch, after the restricted wiki branch returns', () => {
    // buildContainerArgs makes live OneCLI calls and cannot run here, so the call site is pinned in source.
    const src = fs.readFileSync(new URL('./container-runner.ts', import.meta.url), 'utf8');
    const calls = [...src.matchAll(/args\.push\(\.\.\.neutralReviewerReposEnvArgs\(\)\);/g)];
    expect(calls).toHaveLength(1);
    const wikiReturn = src.indexOf("args.push('--entrypoint', 'bash', CONTAINER_IMAGE");
    expect(wikiReturn).toBeGreaterThan(-1);
    expect(calls[0]!.index).toBeGreaterThan(wikiReturn);
  });
});

describe('malformedNeutralReviewerRepos', () => {
  it('names each entry that is not owner/repo, ignoring blanks and whitespace', () => {
    expect(malformedNeutralReviewerRepos(' ExampleOrg/web ,, example.org/data-2 ')).toEqual([]);
    expect(
      malformedNeutralReviewerRepos('ExampleOrg,https://github.com/ExampleOrg/web,ExampleOrg/*,a/b/c,ExampleOrg/ok'),
    ).toEqual(['ExampleOrg', 'https://github.com/ExampleOrg/web', 'ExampleOrg/*', 'a/b/c']);
  });

  it("uses the same owner/repo pattern as the skill's receipt check", () => {
    const skill = fs.readFileSync(
      new URL('../container/skills/pr-review-loop/scripts/codex-review.sh', import.meta.url),
      'utf8',
    );
    const src = fs.readFileSync(new URL('./neutral-reviewer-repos.ts', import.meta.url), 'utf8');
    const skillPattern = skill.match(/\[\[ "\$entry" =~ (\S+) \]\]/)?.[1];
    const hostPattern = src.match(/const OWNER_REPO = \/(\S+)\/;/)?.[1]?.replace(/\\\//g, '/');
    expect(skillPattern).toBeDefined();
    expect(hostPattern).toBe(skillPattern);
  });
});

describe('checkNeutralReviewerRepos at boot', () => {
  beforeEach(() => {
    logMock.warn.mockReset();
  });

  it('warns and DMs the owner once on a malformed value', async () => {
    const notify = vi.fn().mockResolvedValue({ code: 0, message: 'ok' });
    await checkNeutralReviewerRepos({ [KEY]: 'ExampleOrg/web,ExampleOrg' }, notify);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    expect(logMock.warn.mock.calls[0]![1]).toEqual({ malformed: ['ExampleOrg'] });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify.mock.calls[0]![0].body).toContain('ExampleOrg');
  });

  it('logs a failed DM rather than throwing', async () => {
    const notify = vi.fn().mockResolvedValue({ code: 2, message: 'no owner DM' });
    await checkNeutralReviewerRepos({ [KEY]: 'ExampleOrg' }, notify);
    expect(logMock.warn).toHaveBeenCalledTimes(2);
    expect(logMock.warn.mock.calls[1]![1]).toEqual({ code: 2, message: 'no owner DM' });
  });

  it('runs at boot after .env is loaded, so a value set only in .env is checked', () => {
    const main = fs.readFileSync(new URL('./main.ts', import.meta.url), 'utf8');
    const load = main.indexOf('  loadEnvIntoProcess();');
    const check = main.indexOf('  await checkNeutralReviewerRepos();');
    expect(load).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(load);
  });

  it('stays silent on a valid or absent value', async () => {
    const notify = vi.fn();
    await checkNeutralReviewerRepos({ [KEY]: 'ExampleOrg/web, ExampleOrg/data' }, notify);
    await checkNeutralReviewerRepos({}, notify);
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
  });
});
