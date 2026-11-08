import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _resetConfig, _setConfigForTest } from './config.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getInboundDb } from './mailbox/sqlite/connection.js';
import { MEMORY_SESSION_HOOK } from './memory/session-hook.js';
import { getCredentialSlot, queueWorkContinuation, setCredentialSlot } from './modules/mailbox/session-state.js';
import { closeSessionDb, initTestSessionDb } from './modules/mailbox/testing.js';
import { runPollLoop } from './poll-loop.js';
import { _setSdkQueryForTesting, ClaudeProvider } from './providers/claude.js';

type Outcome = 'revoked' | 'limited' | 'overloaded' | 'ok';

const REVOKED_TEXT = 'Failed to authenticate: OAuth token revoked. Please log in again or contact your administrator.';
const LIMITED_TEXT = "You've hit your session limit · resets 2:40pm (America/New_York)";
const OVERLOADED_TEXT = 'API Error: Request rejected (429)';
const ZERO_USAGE = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };

const RING = { CLAUDE_CODE_OAUTH_TOKEN: 'a', CLAUDE_CODE_OAUTH_TOKEN_2: 'b', CLAUDE_CODE_OAUTH_TOKEN_3: 'c' };

let outcomes: Record<string, Outcome>;
let asked: string[];
let cliEnvNames: string[];
let onAsk: () => void;
let home: string;
const savedHome = process.env.HOME;
const savedToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
const savedKey = process.env.ANTHROPIC_API_KEY;

/** The records the CLI emits for each outcome; the revoked pair is the shape it renders for a real 401. */
function* recordsFor(outcome: Outcome): Generator<unknown> {
  yield { type: 'system', subtype: 'init', session_id: 'session-1' };
  if (outcome === 'revoked') {
    yield {
      type: 'assistant',
      parent_tool_use_id: null,
      error: 'authentication_failed',
      is_api_error_message: true,
      api_error_status: 401,
      message: { model: '<synthetic>', content: [{ type: 'text', text: REVOKED_TEXT }] },
    };
    yield {
      type: 'result',
      subtype: 'success',
      is_error: true,
      api_error_status: 401,
      result: REVOKED_TEXT,
      usage: ZERO_USAGE,
    };
    return;
  }
  if (outcome === 'limited') {
    yield { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: LIMITED_TEXT };
    return;
  }
  if (outcome === 'overloaded') {
    yield { type: 'result', subtype: 'success', is_error: true, api_error_status: 429, result: OVERLOADED_TEXT };
    return;
  }
  yield { type: 'result', subtype: 'success', is_error: false, result: '<message to="discord-test">answered</message>' };
}

const fakeSdkQuery = ((args: { options?: { env?: Record<string, string> } }) => {
  const env = args.options?.env ?? {};
  const credential = env.ANTHROPIC_API_KEY ?? env.CLAUDE_CODE_OAUTH_TOKEN;
  asked.push(credential);
  cliEnvNames = Object.keys(env);
  onAsk();
  const records = recordsFor(outcomes[credential]);
  const stream = (async function* () {
    yield* records;
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

function chat(): string[] {
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => m.content);
}

function spawnProvider(env: Record<string, string> = RING): ClaudeProvider {
  const provider = new ClaudeProvider({ env });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  provider.restorePersistedCredentialSlot();
  return provider;
}

/** Runs the real loop until `done`, then long enough that a retry loop would show up in `asked`. */
async function runUntil(provider: ClaudeProvider, done: () => boolean): Promise<void> {
  const controller = new AbortController();
  const loop = Promise.race([
    runPollLoop({ provider, providerName: 'claude', cwd: home, signal: controller.signal }),
    new Promise((resolve) => setTimeout(resolve, 10_000)),
  ]);
  const deadline = Date.now() + 8000;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`timed out; asked ${asked.join()}; chat ${chat().join()}`);
    await new Promise((r) => setTimeout(r, 25));
  }
  await new Promise((r) => setTimeout(r, 300));
  controller.abort();
  await loop.catch(() => {});
}

const answered = () => chat().some((c) => c.includes('answered'));

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'credential-rejection-'));
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
  cliEnvNames = [];
  onAsk = () => {};
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
  if (savedKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = savedKey;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_0;
  delete process.env.ANTHROPIC_API_KEY_0;
  fs.rmSync(home, { recursive: true, force: true });
});

describe('a saved slot the API refuses', () => {
  it('moves the turn to the next slot, saves that slot, and the next spawn starts there', async () => {
    setCredentialSlot('claude', 'CLAUDE_CODE_OAUTH_TOKEN_2');
    outcomes.b = 'revoked';
    inbound('m1');

    await runUntil(spawnProvider(), answered);

    expect(asked).toEqual(['b', 'c']);
    expect(getCredentialSlot('claude')).toBe('CLAUDE_CODE_OAUTH_TOKEN_3');
    expect(chat().join()).not.toContain('Failed to authenticate');
    // The CLI strips only the name it reads, so the kept primary must never reach its children.
    expect(cliEnvNames).not.toContain('CLAUDE_CODE_OAUTH_TOKEN_0');

    asked = [];
    inbound('m2');
    await runUntil(spawnProvider(), () => asked.length > 0);
    expect(asked).toEqual(['c']);
  });
});

describe('a rate-limit rotation that lands on a refused slot', () => {
  it('goes on to a working slot and saves that one', async () => {
    outcomes = { a: 'limited', b: 'revoked', c: 'ok' };
    inbound('m1');

    await runUntil(spawnProvider(), answered);

    expect(asked).toEqual(['a', 'b', 'c']);
    expect(getCredentialSlot('claude')).toBe('CLAUDE_CODE_OAUTH_TOKEN_3');
    expect(chat().join()).not.toContain('Failed to authenticate');
  });

  it('with nowhere left to go, is not a recovery and saves nothing', async () => {
    const { CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN_2 } = RING;
    const env = { CLAUDE_CODE_OAUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN_2 };
    outcomes = { a: 'limited', b: 'revoked' };
    inbound('m1');
    const provider = spawnProvider(env);

    await runUntil(provider, () => chat().length > 0);

    expect(asked).toEqual(['a', 'b']);
    expect(getCredentialSlot('claude')).toBeUndefined();
    expect(chat().join()).toContain('hit your session limit');
    expect(chat().join()).not.toContain('Failed to authenticate');

    // The limit lifts: the next turn walks off the refused slot rather than staying on it.
    outcomes.a = 'ok';
    asked = [];
    inbound('m2');
    await runUntil(provider, answered);
    expect(asked).toEqual(['b', 'a']);
    expect(getCredentialSlot('claude')).toBe('CLAUDE_CODE_OAUTH_TOKEN');
  });

  it('never tries that slot again in this container', async () => {
    outcomes = { a: 'limited', b: 'revoked', c: 'ok' };
    inbound('m1');
    const provider = spawnProvider();
    await runUntil(provider, answered);

    outcomes = { a: 'limited', b: 'ok', c: 'limited' };
    asked = [];
    inbound('m2');
    await runUntil(provider, () => chat().length > 1);

    expect(asked).toEqual(['c', 'a']);
  });
});

describe('when no slot can take the turn', () => {
  it('ends every-slot-refused with the error, once each, and saves nothing', async () => {
    outcomes = { a: 'revoked', b: 'revoked', c: 'revoked' };
    inbound('m1');

    await runUntil(spawnProvider(), () => chat().length > 0);

    expect(asked).toEqual(['a', 'b', 'c']);
    expect(chat()).toHaveLength(1);
    expect(chat()[0]).toContain(REVOKED_TEXT);
    expect(getCredentialSlot('claude')).toBeUndefined();
  });

  it.each([
    ['a lone OAuth token', { CLAUDE_CODE_OAUTH_TOKEN: 'a' }],
    ['API-key auth with a fallback key', { ANTHROPIC_API_KEY: 'a', ANTHROPIC_API_KEY_2: 'b' }],
  ])('leaves %s to fail the way it did', async (_name, env) => {
    outcomes.a = 'revoked';
    inbound('m1');

    await runUntil(spawnProvider(env), () => chat().length > 0);

    expect(asked).toEqual(['a']);
    expect(chat()[0]).toContain(REVOKED_TEXT);
  });
});

describe('a durable continuation', () => {
  it.each([
    ['refused', 'revoked'],
    ['rate-limited', 'limited'],
  ] as const)('retries on the next slot when its slot is %s', async (_name, outcome) => {
    outcomes.a = outcome;
    queueWorkContinuation('finish the report');

    await runUntil(spawnProvider(), () => asked.includes('b'));

    expect(asked).toEqual(['a', 'b']);
    expect(getCredentialSlot('claude')).toBe('CLAUDE_CODE_OAUTH_TOKEN_2');
  });

  it('stays on its slot through a server overload, which says the credential is fine', async () => {
    outcomes.a = 'overloaded';
    queueWorkContinuation('finish the report');

    await runUntil(spawnProvider(), () => asked.length > 0);

    expect(asked).toEqual(['a']);
    expect(getCredentialSlot('claude')).toBeUndefined();
  });

  it('does not start another attempt once a repository fence has landed', async () => {
    outcomes.a = 'limited';
    onAsk = () =>
      getInboundDb()
        .prepare("INSERT INTO repo_ingress_fence (id, epoch, generation, state) VALUES (1, 'epoch-1', 'gen-1', 'active')")
        .run();
    queueWorkContinuation('finish the report');

    await runUntil(spawnProvider(), () => asked.length > 0);

    expect(asked).toEqual(['a']);
  });

  it('stops at the end of the ring instead of cycling it', async () => {
    outcomes = { a: 'limited', b: 'limited', c: 'limited' };
    queueWorkContinuation('finish the report');

    await runUntil(spawnProvider(), () => asked.length >= 3);

    expect(asked).toEqual(['a', 'b', 'c']);
  });
});
