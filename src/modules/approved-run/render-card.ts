import { QUESTION_MAX, UNSHOWABLE, listOf } from './card.js';
import { maskRenderResponse, requestRef, showEnvValue } from './render-mask.js';
import type { RenderRunResult } from './render-execute.js';
import type { RenderClassification, RenderRequest } from './render-request.js';
import type { RenderTarget } from './targets.js';

const RESPONSE_FOR_AGENT_MAX = 4000;

function where(target: RenderTarget, resource: string): string {
  return `**${target.resources[resource].label}** (\`${resource}\`)`;
}

function plainSentence(target: RenderTarget, c: RenderClassification, key: Buffer): string {
  const r = c.resource as string;
  const body = c.request?.body as Record<string, unknown> | null;
  switch (c.op) {
    case 'env-set': {
      const value = String((body as { value?: unknown } | null)?.value ?? '');
      const hidden = showEnvValue(target.resources[r], c.key as string, value, key) !== value;
      return `Sets env var \`${c.key}\` on ${where(target, r)}. The old value is not kept; undoing this means setting it again.${hidden ? ' The card masks all or part of the new value: approving means trusting what you cannot see.' : ''}`;
    }
    case 'env-delete':
      return `Deletes env var \`${c.key}\` from ${where(target, r)}. Its value is gone once this runs.`;
    case 'job':
      return `Runs a one-off job on ${where(target, r)}, with that service's full environment, secrets included. Its output lands in job logs the agents' own key can read, so a command that prints the environment hands them every secret.`;
    case 'auto-deploy':
      return `Turns auto-deploy ${body?.autoDeploy === 'yes' ? 'on' : 'off'} for ${where(target, r)}.`;
    case 'domain-add':
      return `Adds custom domain \`${String(body?.name)}\` to ${where(target, r)}.`;
    case 'domain-verify':
      return `Asks Render to verify custom domain \`${c.key}\` on ${where(target, r)}.`;
    case 'routes':
      return `Replaces the redirect and rewrite routes of ${where(target, r)} with the body below.`;
    default:
      throw new Error('the request has no operation to describe');
  }
}

/** The request as the card shows it: env values masked unless the resource lists the key as plaintext. */
function shownRequest(target: RenderTarget, c: RenderClassification, maskKey: Buffer): RenderRequest {
  const request = c.request as RenderRequest;
  if (c.op !== 'env-set') return request;
  const value = (request.body as { value: string }).value;
  const resource = target.resources[c.resource as string];
  return { ...request, body: { value: showEnvValue(resource, c.key as string, value, maskKey) } };
}

export function renderCardQuestion(
  target: RenderTarget,
  c: RenderClassification,
  sha: string,
  approverNames: string[],
  maskKey: Buffer,
): string {
  const shown = shownRequest(target, c, maskKey);
  const bodyText = shown.body === null ? '' : `\n${JSON.stringify(shown.body, null, 2)}`;
  const block = `${shown.method} ${shown.path}${bodyText}`;
  if (UNSHOWABLE.test(block)) {
    throw new Error('the request holds text a card cannot show as written (``` or an invisible character); remove it');
  }
  const meta = `request \`${requestRef(sha, maskKey)}\` · on approval: the host sends this one request once, as the target's Admin key; a lost answer is reported as unknown and never resent`;
  const foot = `_Only ${listOf(approverNames, false, ' or ')} can answer. Silence runs nothing._`;
  const question = [plainSentence(target, c, maskKey), meta, '```\n' + block + '\n```', foot].join('\n\n');
  if (question.length > QUESTION_MAX) throw new Error('the request is too long to show in full on one card');
  return question;
}

export function renderRunReport(
  target: RenderTarget,
  runId: string,
  sha: string,
  approvedBy: string | null,
  c: RenderClassification,
  result: RenderRunResult,
  maskKey: Buffer,
): string {
  const request = c.request as RenderRequest;
  const head = `Approved by ${approvedBy ?? 'a named approver'}. ${target.label} run \`${runId}\` (request \`${requestRef(sha, maskKey)}\`), \`${request.method} ${request.path}\``;
  switch (result.kind) {
    case 'refused':
      return `${head}: nothing was sent. ${result.detail}`;
    case 'ok':
      return `${head}: done (HTTP ${result.status}).`;
    case 'failed':
      return `${head}: Render refused it (HTTP ${result.status}); nothing changed. A retry is a new proposal.`;
    case 'unknown':
      return `${head}: outcome unknown (${result.detail}). Check the resource in the Render dashboard before proposing it again.`;
  }
}

/** What Render answered, for the agent only, with env values masked the same way the card masks them. */
export function renderResponseForAgent(
  target: RenderTarget,
  c: RenderClassification,
  result: RenderRunResult,
  maskKey: Buffer,
): string {
  if (result.kind !== 'ok' && result.kind !== 'failed') return '';
  const text = JSON.stringify(maskRenderResponse(target, c, result.body, maskKey));
  return text ? `\n\nRender answered: ${text.slice(0, RESPONSE_FOR_AGENT_MAX)}` : '';
}
