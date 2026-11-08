import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _resetConfig, _setConfigForTest } from './config.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getInboundDb } from './mailbox/sqlite/connection.js';
import { MEMORY_SESSION_HOOK } from './memory/session-hook.js';
import { queueWorkContinuation } from './modules/mailbox/session-state.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';
import { formatCredentialRetryPrompt, runPollLoop } from './poll-loop.js';
import { _setSdkQueryForTesting, ClaudeProvider } from './providers/claude.js';

type Outcome = 'weekly' | 'model-weekly' | 'acted-then-weekly' | 'ok';

const RING = { CLAUDE_CODE_OAUTH_TOKEN: 'a', CLAUDE_CODE_OAUTH_TOKEN_2: 'b', CLAUDE_CODE_OAUTH_TOKEN_3: 'c' };
const RESET_S = Math.floor(Date.parse('2126-01-05T06:00:00Z') / 1000);
const INSPECT = 'Before repeating side effects, inspect durable effects already produced';

let outcomes: Record<string, Outcome>;
let asked: string[];
let prompts: string[];
let home: string;
const savedHome = process.env.HOME;
const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;

function rejected(rateLimitType: string): unknown {
  return { type: 'rate_limit_event', rate_limit_info: { status: 'rejected', rateLimitType, resetsAt: RESET_S } };
}

function* recordsFor(outcome: Outcome): Generator<unknown> {
  yield { type: 'system', subtype: 'init', session_id: 'session-1' };
  if (outcome === 'weekly') {
    yield rejected('seven_day');
    return;
  }
  if (outcome === 'model-weekly') {
    yield rejected('seven_day_opus');
    return;
  }
  if (outcome === 'acted-then-weekly') {
    yield {
      type: 'assistant',
      parent_tool_use_id: null,
      message: { content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'git push' } }] },
    };
    yield rejected('seven_day');
    return;
  }
  yield {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '<message to="discord-test">answered</message>',
  };
}

const fakeSdkQuery = ((args: { prompt?: AsyncIterable<unknown>; options?: { env?: Record<string, string> } }) => {
  const credential = args.options?.env?.CLAUDE_CODE_OAUTH_TOKEN ?? '';
  asked.push(credential);
  const stream = (async function* () {
    if (args.prompt && Symbol.asyncIterator in args.prompt) {
      const first = await args.prompt[Symbol.asyncIterator]().next();
      prompts.push(JSON.stringify(first.value));
    }
    yield* recordsFor(outcomes[credential]);
  })() as unknown as Record<string, unknown>;
  stream.interrupt = async () => {};
  return stream;
}) as unknown as NonNullable<Parameters<typeof _setSdkQueryForTesting>[0]>;

function inbound(id: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', ?, 'pending', 'chan-1', 'discord', 'thread-1', ?)`,
    )
    .run(id, new Date().toISOString(), JSON.stringify({ sender: 'Operator', text: 'go' }));
}

const contents = (kind: string) =>
  getUndeliveredMessages()
    .filter((m) => m.kind === kind)
    .map((m) => m.content);
const answered = () => contents('chat').some((c) => c.includes('answered'));

async function runUntilAnswered(): Promise<void> {
  const provider = new ClaudeProvider({ env: RING });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  provider.restorePersistedCredentialSlot();
  const controller = new AbortController();
  const loop = Promise.race([
    runPollLoop({ provider, providerName: 'claude', cwd: home, signal: controller.signal }),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  const deadline = Date.now() + 8000;
  while (!answered()) {
    if (Date.now() > deadline) throw new Error(`timed out; asked ${asked.join()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  await loop.catch(() => {});
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-account-full-'));
  process.env.HOME = home;
  initTestSessionDb();
  _setConfigForTest({ provider: 'claude' });
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
  outcomes = { a: 'ok', b: 'ok', c: 'ok' };
  asked = [];
  prompts = [];
  _setSdkQueryForTesting(fakeSdkQuery);
});

afterEach(() => {
  _setSdkQueryForTesting();
  _resetConfig();
  closeSessionDb();
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  if (savedToken === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
  else process.env.CLAUDE_CODE_OAUTH_TOKEN = savedToken;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_0;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a slot refused at an account-wide limit', () => {
  it('tells the host which slot is spent until when, shows the rotation, and retries without the side-effect check', async () => {
    outcomes.a = 'weekly';
    inbound('m1');
    await runUntilAnswered();

    expect(asked).toEqual(['a', 'b']);
    expect(contents('system').map((c) => JSON.parse(c))).toContainEqual({
      action: 'claude_account_exhausted',
      slot: 'CLAUDE_CODE_OAUTH_TOKEN',
      fingerprint: createHash('sha256').update('a').digest('hex'),
      resetAt: new Date(RESET_S * 1000).toISOString(),
    });
    expect(contents('status').join('\n')).toContain('Claude credential rotating (rate_limit) → slot 2/3');
    expect(prompts[1]).toContain('refused by the API before it took any action');
    expect(prompts[1]).not.toContain(INSPECT);
  });

  it('keeps the side-effect check when the refused attempt had started a tool call', async () => {
    outcomes.a = 'acted-then-weekly';
    inbound('m1');
    await runUntilAnswered();

    expect(asked).toEqual(['a', 'b']);
    expect(prompts[1]).toContain(INSPECT);
  });
});

describe('a ring that refuses twice', () => {
  it('keeps the side-effect check after an earlier attempt acted, even when the later one did not', async () => {
    outcomes.a = 'acted-then-weekly';
    outcomes.b = 'weekly';
    inbound('m1');
    await runUntilAnswered();

    expect(asked).toEqual(['a', 'b', 'c']);
    expect(prompts[2]).toContain(INSPECT);
  });
});

describe('a durable continuation refused at an account-wide limit', () => {
  it('tells the host and shows the rotation, like a batch retry', async () => {
    outcomes.a = 'weekly';
    queueWorkContinuation('finish the report');
    const provider = new ClaudeProvider({ env: RING });
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    provider.restorePersistedCredentialSlot();
    const controller = new AbortController();
    const loop = runPollLoop({ provider, providerName: 'claude', cwd: home, signal: controller.signal });
    const deadline = Date.now() + 8000;
    while (!asked.includes('b')) {
      if (Date.now() > deadline) throw new Error(`timed out; asked ${asked.join()}`);
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    await loop.catch(() => {});

    expect(contents('system').map((c) => JSON.parse(c).action)).toContain('claude_account_exhausted');
    expect(contents('status').join('\n')).toContain('Claude credential rotating (rate_limit) → slot 2/3');
    expect(prompts[1]).not.toContain(INSPECT);
  });
});

describe('a slot refused at a model-scoped limit', () => {
  it('rotates without marking the account spent, since it still serves other models', async () => {
    outcomes.a = 'model-weekly';
    inbound('m1');
    await runUntilAnswered();

    expect(asked[0]).toBe('a');
    expect(asked).toContain('b');
    expect(contents('system').map((c) => JSON.parse(c).action)).not.toContain('claude_account_exhausted');
  });
});

describe('formatCredentialRetryPrompt', () => {
  const rotation = { rotated: true, position: 2, ringSize: 3 };

  it('asks for the side-effect check unless no attempt acted', () => {
    expect(formatCredentialRetryPrompt('the batch', [], rotation, false, true)).toContain(INSPECT);
    const quiet = formatCredentialRetryPrompt('the batch', [], rotation, false, false);
    expect(quiet).not.toContain(INSPECT);
    expect(quiet).toEndWith('the batch');
  });

  it('keeps the side-effect check on a retry that rotated nothing, acted or not', () => {
    expect(formatCredentialRetryPrompt('the batch', [], undefined, false, false)).toContain(INSPECT);
  });
});
