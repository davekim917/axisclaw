import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable } from 'node:stream';

import { allowSubprocess } from '../test-hermeticity.js';
import { claudeCyclePlan, runClaudeCycle } from './claude-cycle.js';

allowSubprocess(['claude-fake']);

const RING = { CLAUDE_CODE_OAUTH_TOKEN: 'dead', CLAUDE_CODE_OAUTH_TOKEN_2: 'healthy', PATH: process.env.PATH };
const ZERO = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
const REVOKED_TEXT = 'Failed to authenticate: OAuth token revoked.';
const refused = { type: 'result', is_error: true, api_error_status: 401, result: REVOKED_TEXT, usage: ZERO };
const limitedMidRun = {
  type: 'result',
  is_error: true,
  api_error_status: 429,
  result: "You've hit your session limit",
  usage: { ...ZERO, input_tokens: 900, output_tokens: 300 },
};
const success = { type: 'result', is_error: false, result: 'done', usage: { ...ZERO, input_tokens: 9 } };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A CLI that records each call, prints a stream line, then answers by which token it was handed. */
function fakeCli(badResult: unknown = refused, paddingBytes = 0) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cycle-'));
  dirs.push(dir);
  const calls = path.join(dir, 'calls');
  const cli = path.join(dir, 'claude-fake');
  fs.writeFileSync(
    cli,
    `#!${process.execPath}
import fs from 'node:fs';
const stdin = Buffer.from(await Bun.stdin.bytes()).toString('base64');
const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ token, argv: process.argv.slice(2), stdin }) + '\\n');
const good = token === 'healthy';
if (process.argv.some((arg) => arg.includes('stream-json'))) console.log(JSON.stringify({ type: 'system', subtype: 'init', from: token }));
if (${paddingBytes}) await Bun.write(Bun.stdout, 'x'.repeat(${paddingBytes}) + '\\n');
console.log(JSON.stringify(good ? ${JSON.stringify(success)} : ${JSON.stringify(badResult)}));
process.exit(good ? 0 : 1);
`,
    { mode: 0o700 },
  );
  return {
    executable: cli,
    calls: () =>
      fs
        .readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as { token: string; argv: string[]; stdin: string }),
  };
}

async function run(argv: string[], executable: string, env: NodeJS.ProcessEnv = RING, stdin = Buffer.from('prompt')) {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const out: Buffer[] = [];
  const err: Buffer[] = [];
  stdout.on('data', (chunk: Buffer) => out.push(chunk));
  stderr.on('data', (chunk: Buffer) => err.push(chunk));
  const plan = claudeCyclePlan(argv, env);
  if (!plan) throw new Error('not a cycling call');
  const code = await runClaudeCycle(plan, { executable, stdin: Readable.from([stdin]), stdout, stderr });
  return { code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') };
}

describe('claude -p across the ring', () => {
  it('prints one result in text mode and replays stdin byte for byte', async () => {
    const { executable, calls } = fakeCli();
    const prompt = Buffer.concat([Buffer.from('review\n日本語\n'), Buffer.from([0, 255])]);

    const result = await run(['-p', 'hi'], executable, RING, prompt);

    expect(result).toMatchObject({ code: 0, stdout: 'done\n' });
    expect(calls().map((c) => c.token)).toEqual(['dead', 'healthy']);
    expect(calls().map((c) => c.stdin)).toEqual(Array(2).fill(prompt.toString('base64')));
  });

  it('runs an explicit text call as json so a refusal can be read', async () => {
    const { executable, calls } = fakeCli();

    const result = await run(['-p', 'hi', '--output-format', 'text'], executable);

    expect(result).toMatchObject({ code: 0, stdout: 'done\n' });
    expect(calls()[0].argv.filter((arg) => arg === 'text' || arg === 'json')).toEqual(['json']);
  });

  it('keeps a refused attempt out of json output', async () => {
    const { executable } = fakeCli();

    const { stdout } = await run(['-p', 'hi', '--output-format', 'json'], executable);

    expect(JSON.parse(stdout)).toEqual(success);
  });

  it('keeps a refused attempt out of stream-json output', async () => {
    const { executable } = fakeCli();

    const { stdout } = await run(['-p', 'hi', '--output-format=stream-json'], executable);

    expect(stdout).toContain('"from":"healthy"');
    expect(stdout).not.toContain('"from":"dead"');
    expect(stdout.trim().split('\n')).toHaveLength(2);
  });

  it('names the slots it moved between and never a token', async () => {
    const { executable } = fakeCli();

    const { stderr } = await run(['-p', 'hi'], executable);

    expect(stderr).toContain('CLAUDE_CODE_OAUTH_TOKEN_2');
    expect(stderr).not.toContain('healthy');
    expect(stderr).not.toContain('dead');
  });

  it('stops holding a run that has clearly started, and does not retry it', async () => {
    const { executable, calls } = fakeCli(refused, 2 * 1024 * 1024);

    const { code, stdout } = await run(['-p', 'hi', '--output-format', 'stream-json'], executable);

    expect(code).toBe(1);
    expect(stdout.length).toBeGreaterThan(2 * 1024 * 1024);
    expect(calls()).toHaveLength(1);
  });

  it('never replays a run that reached inference', async () => {
    const { executable, calls } = fakeCli(limitedMidRun);

    const result = await run(['-p', 'hi'], executable);

    expect(result).toMatchObject({ code: 1, stdout: "You've hit your session limit\n" });
    expect(calls()).toHaveLength(1);
  });

  it('ends with the last refusal when every slot is refused', async () => {
    const { executable, calls } = fakeCli();
    const env = { ...RING, CLAUDE_CODE_OAUTH_TOKEN_2: 'also-dead', CLAUDE_CODE_OAUTH_TOKEN_3: 'dead-too' };

    const result = await run(['-p', 'hi'], executable, env);

    expect(result).toMatchObject({ code: 1, stdout: `${REVOKED_TEXT}\n` });
    expect(calls().map((c) => c.token)).toEqual(['dead', 'also-dead', 'dead-too']);
  });
});

describe('which calls cycle', () => {
  it.each([
    ['a print call with a ring', ['-p', 'hi'], RING, true],
    ['--print', ['--print', 'hi'], RING, true],
    ['an interactive or tooling call', ['--version'], RING, false],
    ['the stream protocol', ['--print', '--input-format', 'stream-json'], RING, false],
    ['a format it cannot read', ['-p', '--output-format', 'xml'], RING, false],
    ['a single token', ['-p', 'hi'], { CLAUDE_CODE_OAUTH_TOKEN: 'one' }, false],
    ['a Claude session shell, which has no primary', ['-p', 'hi'], { CLAUDE_CODE_OAUTH_TOKEN_2: 'two' }, false],
  ])('%s', (_name, argv, env, eligible) => {
    expect(claudeCyclePlan(argv, env) !== null).toBe(eligible);
  });
});
