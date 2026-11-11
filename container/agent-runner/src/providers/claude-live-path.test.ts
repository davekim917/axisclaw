/**
 * Live path `provider-claude`: the real ClaudeProvider drives the real Claude Agent SDK, which spawns the Claude Code
 * CLI it bundles, against a local fake of the Anthropic Messages API. Nothing between the provider and the socket is
 * mocked, so a bump of either package that changes what reaches the API, or how a streamed reply becomes a turn,
 * fails here.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import { closeSessionDb, initTestSessionDb } from '../modules/mailbox/testing.js';
import { allowNetwork, allowSubprocess, allowWritesTo } from '../test-hermeticity.js';
import { ClaudeProvider, IMAGE_CLAUDE_CODE_EXECUTABLE, _setClaudeCodeExecutableForTesting } from './claude.js';
import { claudeCyclePlan } from '../cli/claude-cycle.js';
import { getCredentialSlot } from '../modules/mailbox/session-state.js';
import type { ProviderEvent } from './types.js';

const SDK = '@anthropic-ai/claude-agent-sdk';
// bun's mock.module lasts for the rest of the process, so in a run that also loads a test mocking the SDK
// (`bun test src/providers`) this file would drive the mock, not the CLI. Compared by source, since the unmocked
// copy is a second instance of the same module.
const sdkMocked =
  String((await import(SDK)).query) !==
  String((await import(`${Bun.resolveSync(SDK, import.meta.dir)}?unmocked`)).query);
const SDK_MOCKED_REASON = `${SDK} is mocked in this process by another test file; run \`bun run test:live-path\``;
// `test:live-path` runs only live-path files, so a mock there is a defect, never a reason to skip.
if (sdkMocked && process.env.LIVE_PATH_STRICT === '1')
  throw new Error(`provider-claude live path: ${SDK_MOCKED_REASON}`);
if (sdkMocked) console.warn(`provider-claude live path skipped: ${SDK_MOCKED_REASON}`);

type MessagesRequest = {
  model?: string;
  stream?: boolean;
  thinking?: { type?: string };
  output_config?: { effort?: string };
  system?: Array<{ type: string; text: string }> | string;
  tools?: Array<{ name: string }>;
  messages?: Array<{ role: string; content: unknown }>;
};

type Reply = { text: string } | { toolUse: { id: string; name: string; input: Record<string, unknown> } };

function sse(model: string, reply: Reply): string {
  const ev = (type: string, data: Record<string, unknown>) =>
    `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  const block =
    'text' in reply
      ? { start: { type: 'text', text: '' }, delta: { type: 'text_delta', text: reply.text } }
      : {
          start: { type: 'tool_use', id: reply.toolUse.id, name: reply.toolUse.name, input: {} },
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(reply.toolUse.input) },
        };
  return [
    ev('message_start', {
      message: {
        id: `msg_${Math.random().toString(36).slice(2)}`,
        type: 'message',
        role: 'assistant',
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 11, output_tokens: 0 },
      },
    }),
    ev('content_block_start', { index: 0, content_block: block.start }),
    ev('content_block_delta', { index: 0, delta: block.delta }),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', {
      delta: { stop_reason: 'text' in reply ? 'end_turn' : 'tool_use', stop_sequence: null },
      usage: { output_tokens: 7 },
    }),
    ev('message_stop', {}),
  ].join('');
}

/** The streamed main-loop requests, in order; side requests (titles, classifiers) are answered but not recorded. */
const turns: MessagesRequest[] = [];
const REVOKED_TOKEN = 'revoked-live-path-token';
let script: Reply[] = [];
let server: ReturnType<typeof Bun.serve>;
let home = '';

beforeAll(() => {
  allowNetwork();
  allowSubprocess(['claude']);
  initTestSessionDb();
  server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (req.method !== 'POST' || url.pathname !== '/v1/messages') return Response.json({}, { status: 404 });
      if (req.headers.get('authorization') === `Bearer ${REVOKED_TOKEN}`) {
        return Response.json(
          {
            type: 'error',
            error: { type: 'authentication_error', message: 'OAuth access token has been revoked.' },
            request_id: 'req_live_path',
          },
          { status: 401 },
        );
      }
      const body = (await req.json()) as MessagesRequest;
      const model = body.model ?? 'unknown';
      if (!body.stream) {
        return Response.json({
          id: 'msg_side',
          type: 'message',
          role: 'assistant',
          model,
          content: [{ type: 'text', text: 'ok' }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 1, output_tokens: 1 },
        });
      }
      turns.push(body);
      const reply = script.shift() ?? { text: 'unscripted' };
      return new Response(sse(model, reply), { headers: { 'content-type': 'text/event-stream' } });
    },
  });
  _setClaudeCodeExecutableForTesting(undefined);
});

afterAll(() => {
  server.stop(true);
  closeSessionDb();
  _setClaudeCodeExecutableForTesting(IMAGE_CLAUDE_CODE_EXECUTABLE);
});

afterEach(() => {
  turns.length = 0;
  script = [];
  if (home) fs.rmSync(home, { recursive: true, force: true });
  home = '';
});

function liveProvider(auth: Record<string, string>): ClaudeProvider {
  home ||= fs.mkdtempSync(path.join(os.tmpdir(), 'claude-live-path-'));
  allowWritesTo(home);
  fs.mkdirSync(path.join(home, 'work'), { recursive: true });
  const p = new ClaudeProvider({
    env: {
      PATH: process.env.PATH,
      HOME: home,
      CLAUDE_CONFIG_DIR: path.join(home, '.claude'),
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.port}`,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ...auth,
    },
  });
  p.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return p;
}

async function runTurn(
  input: Omit<Parameters<ClaudeProvider['query']>[0], 'cwd'>,
  provider = liveProvider({ ANTHROPIC_API_KEY: 'sk-ant-live-path-fake' }),
): Promise<Extract<ProviderEvent, { type: 'result' }>> {
  const q = provider.query({ ...input, cwd: path.join(home, 'work') });
  try {
    for await (const event of q.events) {
      if (event.type === 'result') return event;
    }
    throw new Error('the query ended without a result');
  } finally {
    q.end();
    q.abort();
  }
}

function systemText(req: MessagesRequest): string {
  return typeof req.system === 'string' ? req.system : (req.system ?? []).map((b) => b.text).join('\n');
}

describe.skipIf(sdkMocked)('provider-claude live path', () => {
  it('runs the Claude Code release the image pins', () => {
    // The image runs its own install of that pin (/pnpm/claude); this test can only run the SDK's bundled build.
    const pin = /^ARG CLAUDE_CODE_VERSION=(\S+)$/m.exec(
      fs.readFileSync(path.join(import.meta.dir, '../../../Dockerfile'), 'utf8'),
    )?.[1];
    const platformPackage = require.resolve(
      `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`,
    );
    const version = Bun.spawnSync([path.join(path.dirname(platformPackage), 'claude'), '--version']);
    expect(pin).toBeDefined();
    expect(version.stdout.toString().trim().split(' ')[0]).toBe(pin!);
  });

  it('sends the resolved model, effort and adaptive thinking, and returns the streamed reply as the turn', async () => {
    script = [{ text: 'pong from the fake' }];
    const result = await runTurn({
      prompt: 'ping',
      model: 'claude-sonnet-5-5',
      effort: 'low',
      systemContext: { instructions: 'LIVE-PATH-INSTRUCTIONS-MARKER' },
    });

    expect(result.isError ?? false).toBe(false);
    expect(result.text).toContain('pong from the fake');
    expect(turns).toHaveLength(1);
    expect(turns[0].model).toBe('claude-sonnet-5-5');
    expect(turns[0].output_config?.effort).toBe('low');
    expect(turns[0].thinking?.type).toBe('adaptive');
    expect(systemText(turns[0])).toContain('LIVE-PATH-INSTRUCTIONS-MARKER');
    expect(JSON.stringify(turns[0].messages)).toContain('ping');
  }, 60_000);

  it('runs a tool the model calls and sends its output back in the next request', async () => {
    script = [
      {
        toolUse: {
          id: 'toolu_live_1',
          name: 'Bash',
          input: { command: 'echo live-path-tool-output', description: 'echo' },
        },
      },
      { text: 'tool done' },
    ];
    const result = await runTurn({ prompt: 'run the echo', model: 'claude-sonnet-5-5' });

    expect(result.text).toContain('tool done');
    expect(turns).toHaveLength(2);
    expect(turns[0].tools?.map((t) => t.name)).toContain('Bash');
    const followUp = JSON.stringify(turns[1].messages);
    expect(followUp).toContain('toolu_live_1');
    expect(followUp).toContain('live-path-tool-output');
  }, 60_000);

  it('turns the real CLI rendering of a revoked OAuth token into a rotation', async () => {
    script = [{ text: 'served by the next slot' }];
    const provider = liveProvider({
      CLAUDE_CODE_OAUTH_TOKEN: REVOKED_TOKEN,
      CLAUDE_CODE_OAUTH_TOKEN_2: 'healthy-live-path-token',
    });
    provider.resetRotationCycle();

    const failure = await runTurn({ prompt: 'ping', model: 'claude-sonnet-5-5' }, provider).catch((err) => err);
    expect(provider.isRetryable(failure)).toBe(true);
    expect((failure as Error).message).toContain('OAuth token revoked');

    expect(provider.rotateApiKey()).toMatchObject({ rotated: true, slot: 'CLAUDE_CODE_OAUTH_TOKEN_2' });
    const result = await runTurn({ prompt: 'ping', model: 'claude-sonnet-5-5' }, provider);
    expect(result.text).toContain('served by the next slot');
    expect(getCredentialSlot('claude')).toBe('CLAUDE_CODE_OAUTH_TOKEN_2');
  }, 60_000);

  it('spawns the CLI in a form the claude launcher leaves to the provider', async () => {
    const dir = (home = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-live-path-')));
    const recorded = path.join(dir, 'argv');
    const probe = path.join(dir, 'argv-probe');
    fs.writeFileSync(probe, `#!/bin/sh\nprintf '%s\\n' "$@" > '${recorded}'\nexit 1\n`, { mode: 0o700 });
    allowSubprocess(['argv-probe']);
    _setClaudeCodeExecutableForTesting(probe);
    try {
      await runTurn({ prompt: 'ping' }, liveProvider({ ANTHROPIC_API_KEY: 'sk-ant-live-path-fake' })).catch(() => {});
    } finally {
      _setClaudeCodeExecutableForTesting(undefined);
    }

    const argv = fs.readFileSync(recorded, 'utf8').trim().split('\n');
    expect(argv).toContain('--input-format');
    expect(claudeCyclePlan(argv, { CLAUDE_CODE_OAUTH_TOKEN: 'one', CLAUDE_CODE_OAUTH_TOKEN_2: 'two' })).toBeNull();
  }, 60_000);
  // The spawn env sets CLAUDE_CODE_SUBAGENT_MODEL as a fleet default; it is only safe while the CLI ranks it below a
  // model the Agent call names and below an agent definition's `model`, `inherit` included.
  describe('subagent model precedence', () => {
    const MAIN = 'claude-fable-5-2[1m]';
    const SUBAGENT_DEFAULT = 'claude-opus-5-5[1m]';
    const cases: Array<{ name: string; agentInput: Record<string, unknown>; env: boolean; want: string }> = [
      {
        name: 'an unnamed model takes the env default',
        agentInput: { subagent_type: 'general-purpose' },
        env: true,
        want: 'claude-opus-5-5',
      },
      {
        name: 'without the env an unnamed model inherits the main model',
        agentInput: { subagent_type: 'general-purpose' },
        env: false,
        want: 'claude-fable-5-2',
      },
      {
        name: 'a definition model beats the env default',
        agentInput: { subagent_type: 'probe-haiku' },
        env: true,
        want: 'claude-haiku-5-5',
      },
      {
        name: 'a definition `inherit` beats the env default',
        agentInput: { subagent_type: 'probe-inherit' },
        env: true,
        want: 'claude-fable-5-2',
      },
      {
        name: 'a model named on the Agent call beats the env default',
        agentInput: { subagent_type: 'general-purpose', model: 'sonnet' },
        env: true,
        want: 'claude-sonnet-5-5',
      },
    ];
    for (const c of cases) {
      it(
        c.name,
        async () => {
          home ||= fs.mkdtempSync(path.join(os.tmpdir(), 'claude-live-path-'));
          allowWritesTo(home);
          const agents = path.join(home, 'work', '.claude', 'agents');
          fs.mkdirSync(agents, { recursive: true });
          for (const m of ['haiku', 'inherit']) {
            fs.writeFileSync(
              path.join(agents, `probe-${m}.md`),
              `---\nname: probe-${m}\ndescription: probe\nmodel: ${m}\n---\nSUBAGENT-PROBE-MARKER\n`,
            );
          }
          script = [
            {
              toolUse: {
                id: 'toolu_agent_1',
                name: 'Agent',
                input: { description: 'probe', prompt: 'SUBAGENT-TASK-MARKER', ...c.agentInput },
              },
            },
            { text: 'sub done' },
            { text: 'main done' },
          ];
          const provider = liveProvider({
            ANTHROPIC_API_KEY: 'sk-ant-live-path-fake',
            ANTHROPIC_DEFAULT_OPUS_MODEL: SUBAGENT_DEFAULT,
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'claude-sonnet-5-5',
            ANTHROPIC_DEFAULT_HAIKU_MODEL: 'claude-haiku-5-5',
            ANTHROPIC_DEFAULT_FABLE_MODEL: MAIN,
            CLAUDE_CODE_FORK_SUBAGENT: '0',
            ...(c.env ? { CLAUDE_CODE_SUBAGENT_MODEL: SUBAGENT_DEFAULT } : {}),
          });
          const result = await runTurn({ prompt: 'delegate', model: MAIN }, provider);

          expect(result.text).toContain('main done');
          const sub = turns.filter(
            (t) =>
              JSON.stringify(t.messages).includes('SUBAGENT-TASK-MARKER') &&
              !JSON.stringify(t.messages).includes('toolu_agent_1'),
          );
          expect(sub).toHaveLength(1);
          expect(sub[0].model).toBe(c.want);
          expect(turns[0].model).toBe('claude-fable-5-2');
        },
        90_000,
      );
    }
  });
});
