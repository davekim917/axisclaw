/**
 * An approved Render request, run once by the host as the target's reserved Admin identity. Before the write, the
 * vault must inject the token for that agent alone and `GET /v1/users` must name the configured Admin user. The write
 * is sent exactly once: a lost answer is recorded as unknown and never resent, because a second env-var change or job
 * is a second change.
 */
import path from 'node:path';

import { APPROVED_RUN_DIR, type RenderExecuteConfig, type RenderTarget } from './targets.js';
import { append, claimRun, finish, tokenHeldOnlyBy, type RunMeta } from './execute.js';
import type { RenderApi } from './render-api.js';
import { maskRenderResponse } from './render-mask.js';
import type { RenderClassification, RenderRequest } from './render-request.js';

const RUNS_DIR = path.join(APPROVED_RUN_DIR, 'runs');

export type RenderRunResult =
  | { kind: 'refused'; detail: string }
  | { kind: 'ok'; status: number; body: unknown }
  | { kind: 'failed'; status: number; body: unknown }
  | { kind: 'unknown'; detail: string };

export interface RenderExecuteDeps {
  api: RenderApi;
  holders: (secret: string) => Promise<string[]>;
  /** Queues the run's report; called before the run is recorded as finished, so a finished run is never unreported. */
  settled: (result: RenderRunResult) => void;
  /** The target's mask key: what the run stores on disk carries Render's answer masked the way the card masks it. */
  maskKey: Buffer;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message.slice(0, 200) : 'request failed';
}

async function checkAdmin(deps: RenderExecuteDeps, execute: RenderExecuteConfig): Promise<string | null> {
  let res;
  try {
    res = await deps.api('GET', '/v1/users');
    // eslint-disable-next-line no-catch-all/no-catch-all -- an identity check that cannot run refuses the write
  } catch (err) {
    return `the identity check failed: ${errorText(err)}`;
  }
  if (res.status !== 200) return `the identity check failed: HTTP ${res.status}`;
  const id = (res.body as { id?: unknown } | null)?.id;
  return id === execute.adminUserId ? null : `the token belongs to ${String(id)}, not ${execute.adminUserId}`;
}

export function executeRenderRun(
  target: RenderTarget,
  c: RenderClassification,
  meta: RunMeta,
  deps: RenderExecuteDeps,
  root = RUNS_DIR,
): Promise<RenderRunResult> {
  return runClaimed(target, c, deps, claimRun(root, meta, { kind: 'render', steps: 1 }));
}

async function runClaimed(
  target: RenderTarget,
  c: RenderClassification,
  deps: RenderExecuteDeps,
  dir: string,
): Promise<RenderRunResult> {
  const execute = target.execute;
  const request = c.request as RenderRequest;
  const settle = (result: RenderRunResult): RenderRunResult => {
    deps.settled(result);
    finish(
      dir,
      'body' in result ? { ...result, body: maskRenderResponse(target, c, result.body, deps.maskKey) } : result,
    );
    return result;
  };
  const held = await tokenHeldOnlyBy(deps.holders, execute.secret, execute.onecliAgent);
  if (held) return settle({ kind: 'refused', detail: held });
  const identity = await checkAdmin(deps, execute);
  if (identity) return settle({ kind: 'refused', detail: identity });

  append(dir, { step: 1, status: 'sending' });
  let res;
  try {
    res = await deps.api(request.method, request.path, request.body);
    // eslint-disable-next-line no-catch-all/no-catch-all -- once sent, a lost answer is an unknown outcome, never a resend
  } catch (err) {
    const detail = `no answer from Render: ${errorText(err)}`;
    append(dir, { step: 1, status: 'unknown', detail });
    return settle({ kind: 'unknown', detail });
  }
  if (res.status >= 200 && res.status < 300) {
    append(dir, { step: 1, status: 'ok', http: res.status });
    return settle({ kind: 'ok', status: res.status, body: res.body });
  }
  // A 5xx is Render's own error, and the change may have landed before it; only a 4xx is a clean refusal.
  if (res.status >= 500) {
    const detail = `Render answered HTTP ${res.status}, so the change may or may not have applied`;
    append(dir, { step: 1, status: 'unknown', detail });
    return settle({ kind: 'unknown', detail });
  }
  append(dir, { step: 1, status: 'failed', http: res.status });
  return settle({ kind: 'failed', status: res.status, body: res.body });
}
