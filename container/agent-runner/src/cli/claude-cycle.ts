/**
 * `claude -p` across the shell's own credential ring. Plain `claude -p` from a task script or a non-Claude container
 * holds the whole ring in env but the CLI only reads one token, so this retries a refused call on the next slot.
 *
 * Only a failure the API reported before any inference is retried: a run that did work is never replayed, because its
 * side effects have already happened. Output is held until the attempt settles, so a retried attempt prints nothing.
 * A Claude OAuth session's Bash has no primary token (the CLI strips it from its children), so it never gets here and
 * keeps failing as "Not logged in": making that form work would be a new capability, not a retry.
 */
import { spawn, type ChildProcess } from 'node:child_process';
import os from 'node:os';

import { isPreInferenceCredentialResult } from '../providers/claude-review-classification.js';
import { activeCredentialRing, type CredentialSlot } from '../providers/claude-credential-ring.js';
import { MAX_CLAUDE_REVIEW_PROMPT_BYTES, ORIGINAL_CLAUDE_CLI } from './claude-review-contract.js';

const OUTPUT_FORMATS: readonly string[] = ['text', 'json', 'stream-json'];
/** The CLI's own wait on a stdin nothing writes to. */
const STDIN_WAIT_MS = 3000;
/** Far above anything a run prints before its first request fails; past this the run has clearly started working. */
const MAX_HELD_OUTPUT_BYTES = 1024 * 1024;

interface CycleIo {
  executable?: string;
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface ClaudeCyclePlan {
  args: string[];
  /** The caller asked for text, which is rendered here from the json record. */
  textOutput: boolean;
  env: NodeJS.ProcessEnv;
  slots: CredentialSlot[];
}

/** How to run this call across the ring, or null when it is not one to cycle. */
export function claudeCyclePlan(argv: readonly string[], env: NodeJS.ProcessEnv): ClaudeCyclePlan | null {
  if (!argv.includes('-p') && !argv.includes('--print')) return null;
  // The SDK spawns the CLI over this stream protocol, and the provider already rotates that session.
  if (argv.some((arg) => arg === '--input-format' || arg.startsWith('--input-format='))) return null;
  const slots = activeCredentialRing(env);
  if (slots.length < 2) return null;
  let format = 'text';
  const otherArgs: string[] = [];
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === '--output-format') format = argv[++index] ?? '';
    else if (argv[index].startsWith('--output-format=')) format = argv[index].slice('--output-format='.length);
    else otherArgs.push(argv[index]);
  }
  if (!OUTPUT_FORMATS.includes(format)) return null;
  const textOutput = format === 'text';
  // Text is run as json, the only form that says whether inference ran.
  return { args: ['--output-format', textOutput ? 'json' : format, ...otherArgs], textOutput, env, slots };
}

/** Stdin is replayed whole on a retry, so it is read before the first attempt. */
async function readReplayableStdin(stdin: NodeJS.ReadableStream): Promise<Buffer> {
  if ((stdin as { isTTY?: boolean }).isTTY) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = stdin[Symbol.asyncIterator]();
  for (;;) {
    const read = reader.next();
    const next =
      chunks.length > 0
        ? await read
        : await Promise.race([
            read,
            new Promise<null>((resolve) => setTimeout(resolve, STDIN_WAIT_MS, null).unref?.()),
          ]);
    if (next === null || next.done) return Buffer.concat(chunks, size);
    const buffer = Buffer.from(next.value as Uint8Array);
    size += buffer.byteLength;
    if (size > MAX_CLAUDE_REVIEW_PROMPT_BYTES) throw new Error(`stdin exceeds ${MAX_CLAUDE_REVIEW_PROMPT_BYTES} bytes`);
    chunks.push(buffer);
  }
}

/** The `result` record of a json or stream-json run: an object, an array under `--verbose`, or the last line. */
function resultRecord(output: string): Record<string, unknown> | null {
  const isResult = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && (value as { type?: unknown }).type === 'result';
  const trimmed = output.trimEnd();
  for (const candidate of [trimmed, trimmed.slice(trimmed.lastIndexOf('\n') + 1)]) {
    try {
      const parsed: unknown = JSON.parse(candidate);
      const found: unknown = Array.isArray(parsed) ? parsed.filter(isResult).at(-1) : parsed;
      if (isResult(found)) return found;
    } catch {
      continue;
    }
  }
  return null;
}

/** Text mode is what the CLI prints for the same record: the result, or its `errors`, and a newline. */
function renderText(record: Record<string, unknown> | null, output: string): string {
  if (!record) return output;
  const errors = Array.isArray(record.errors) ? record.errors.join('\n') : '';
  return `${typeof record.result === 'string' ? record.result : errors}\n`;
}

interface Attempt {
  exitCode: number;
  /** Null once the output outgrew the hold and went straight to the caller: that attempt can no longer be retried. */
  output: string | null;
}

/** `overflow` is where output goes past the hold; without one, it is all held. */
async function runAttempt(
  executable: string,
  plan: ClaudeCyclePlan,
  slot: CredentialSlot,
  stdin: Buffer,
  overflow: NodeJS.WritableStream | undefined,
  onChild: (child: ChildProcess | undefined) => void,
): Promise<Attempt> {
  const child = spawn(executable, plan.args, {
    env: { ...plan.env, [slot.envName]: slot.value },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  onChild(child);
  let held: Buffer[] | null = [];
  let heldBytes = 0;
  child.stdout?.on('data', (chunk: Buffer) => {
    if (!held) {
      overflow?.write(chunk);
      return;
    }
    held.push(chunk);
    heldBytes += chunk.byteLength;
    if (overflow && heldBytes > MAX_HELD_OUTPUT_BYTES) {
      overflow.write(Buffer.concat(held, heldBytes));
      held = null;
    }
  });
  const exitCode = await new Promise<number>((resolve) => {
    child.once('error', () => resolve(127));
    child.once('close', (code, signal) =>
      resolve(code ?? 128 + (os.constants.signals[signal as keyof typeof os.constants.signals] ?? 1)),
    );
    child.stdin?.on('error', () => undefined); // An early CLI exit may close stdin.
    child.stdin?.end(stdin);
  });
  onChild(undefined);
  return { exitCode, output: held ? Buffer.concat(held, heldBytes).toString('utf8') : null };
}

export async function runClaudeCycle(plan: ClaudeCyclePlan, io: CycleIo = {}): Promise<number> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const stdin = await readReplayableStdin(io.stdin ?? process.stdin);

  let running: ChildProcess | undefined;
  let stopping = false;
  const stop = (signal: NodeJS.Signals) => () => {
    stopping = true;
    running?.kill(signal);
  };
  const onTerm = stop('SIGTERM');
  const onInt = stop('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);

  try {
    for (let index = 0; ; index++) {
      const slot = plan.slots[index];
      const { exitCode, output } = await runAttempt(
        io.executable ?? ORIGINAL_CLAUDE_CLI,
        plan,
        slot,
        stdin,
        plan.textOutput ? undefined : stdout,
        (child) => {
          running = child;
        },
      );
      if (output === null) return exitCode;
      const record = resultRecord(output);
      const next = plan.slots[index + 1];
      if (next && !stopping && record && isPreInferenceCredentialResult(record)) {
        stderr.write(`[claude] credential ${slot.name} was refused before inference; retrying ${next.name}\n`);
        continue;
      }
      stdout.write(plan.textOutput ? renderText(record, output) : output);
      return exitCode;
    }
  } finally {
    process.off('SIGTERM', onTerm);
    process.off('SIGINT', onInt);
  }
}
