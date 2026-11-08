import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { renderCardQuestion, renderResponseForAgent, renderRunReport } from './render-card.js';
import { maskValue, requestRef } from './render-mask.js';
import { classifyRenderRequest } from './render-request.js';
import type { RenderTarget } from './targets.js';

const SRV = 'srv-aaaaaaaaaaaaaaaaaaaa';
const KEY = Buffer.alloc(32, 3);
const TARGET: RenderTarget = {
  id: 'acme-render',
  label: 'Acme Render',
  entrySha: 'e'.repeat(64),
  kind: 'render',
  mode: 'execute',
  agentGroups: ['ag-1'],
  approvers: ['slack:U1'],
  execute: {
    secret: 'approved-run-acme-render token',
    onecliAgent: 'approved-run-acme-render',
    adminUserId: 'usr-aaaaaaaaaaaaaaaaaaaa',
  },
  resources: { [SRV]: { label: 'Acme backend', plaintextEnv: ['NODE_ENV'] } },
};

function question(request: Record<string, unknown>): string {
  return renderCardQuestion(TARGET, classifyRenderRequest(TARGET, request), 'a'.repeat(64), ['Alice'], KEY);
}

describe('renderCardQuestion', () => {
  it('refuses to describe a request whose operation is missing, so no card is posted without its plain sentence', () => {
    const c = classifyRenderRequest(TARGET, { method: 'DELETE', path: `/v1/services/${SRV}/env-vars/OLD` });
    expect(() => renderCardQuestion(TARGET, { ...c, op: null }, 'a'.repeat(64), ['Alice'], KEY)).toThrow(
      'the request has no operation to describe',
    );
  });

  it.each([
    [{ method: 'DELETE', path: `/v1/services/${SRV}/env-vars/OLD` }, 'Deletes env var `OLD` from **Acme backend**'],
    [
      { method: 'POST', path: `/v1/services/${SRV}/jobs`, body: { startCommand: 'node reindex.js' } },
      'Runs a one-off job on **Acme backend**',
    ],
    [{ method: 'PATCH', path: `/v1/services/${SRV}`, body: { autoDeploy: 'yes' } }, 'Turns auto-deploy on for **Acme'],
    [{ method: 'PATCH', path: `/v1/services/${SRV}`, body: { autoDeploy: 'no' } }, 'Turns auto-deploy off for **Acme'],
    [
      { method: 'POST', path: `/v1/services/${SRV}/custom-domains`, body: { name: 'app.example.com' } },
      'Adds custom domain `app.example.com` to **Acme backend**',
    ],
    [
      { method: 'POST', path: `/v1/services/${SRV}/custom-domains/app.example.com/verify` },
      'Asks Render to verify custom domain `app.example.com`',
    ],
    [{ method: 'PUT', path: `/v1/services/${SRV}/routes`, body: [] }, 'Replaces the redirect and rewrite routes'],
  ])('opens with what the request changes, and shows it verbatim (%j)', (request, sentence) => {
    const q = question(request);
    expect(q.startsWith(sentence)).toBe(true);
    expect(q).toContain(`${request.method as string} ${request.path as string}`);
  });

  it("shows a job's command in full, since the approver is approving exactly that command", () => {
    expect(
      question({ method: 'POST', path: `/v1/services/${SRV}/jobs`, body: { startCommand: 'node reindex.js' } }),
    ).toContain('"startCommand": "node reindex.js"');
  });

  it('shows a listed key in plaintext and masks any other', () => {
    expect(
      question({ method: 'PUT', path: `/v1/services/${SRV}/env-vars/NODE_ENV`, body: { value: 'production' } }),
    ).toContain('"value": "production"');
    const secret = question({
      method: 'PUT',
      path: `/v1/services/${SRV}/env-vars/JWT_SECRET`,
      body: { value: 'hunter2' },
    });
    expect(secret).toContain(maskValue('hunter2', KEY));
    expect(secret).not.toContain('hunter2"');
  });

  it('refuses a request it could not show as written', () => {
    expect(() =>
      question({ method: 'POST', path: `/v1/services/${SRV}/jobs`, body: { startCommand: 'echo ```' } }),
    ).toThrow(/cannot show as written/);
  });
});

describe('renderRunReport', () => {
  const c = classifyRenderRequest(TARGET, { method: 'DELETE', path: `/v1/services/${SRV}/env-vars/OLD` });
  const SHA = 'a'.repeat(64);
  const head = `Approved by Alice. Acme Render run \`r-1\` (request \`${requestRef(SHA, KEY)}\`), \`DELETE /v1/services/${SRV}/env-vars/OLD\``;

  it.each([
    [
      { kind: 'refused' as const, detail: 'the token belongs to usr-x' },
      `${head}: nothing was sent. the token belongs to usr-x`,
    ],
    [{ kind: 'ok' as const, status: 204, body: null }, `${head}: done (HTTP 204).`],
    [
      { kind: 'failed' as const, status: 404, body: {} },
      `${head}: Render refused it (HTTP 404); nothing changed. A retry is a new proposal.`,
    ],
    [
      { kind: 'unknown' as const, detail: 'no answer from Render: timeout' },
      `${head}: outcome unknown (no answer from Render: timeout). Check the resource in the Render dashboard before proposing it again.`,
    ],
  ])('says what happened (%j)', (result, text) => {
    expect(renderRunReport(TARGET, 'r-1', SHA, 'Alice', c, result, KEY)).toBe(text);
  });
});

describe('requestRef', () => {
  it("is keyed, so the card never shows a digest of the request's secret value that a guess could be checked against", () => {
    const sha = createHash('sha256').update('anything').digest('hex');
    const ref = requestRef(sha, KEY);
    expect(ref).toMatch(/^[0-9a-f]{12}$/);
    expect(ref).not.toBe(sha.slice(0, 12));
    expect(requestRef(sha, KEY)).toBe(ref);
    expect(requestRef(sha, Buffer.alloc(32, 9))).not.toBe(ref);
  });
});

describe('renderResponseForAgent', () => {
  it('masks a secret value Render echoes back, and adds nothing when there was no answer', () => {
    const c = classifyRenderRequest(TARGET, {
      method: 'PUT',
      path: `/v1/services/${SRV}/env-vars/JWT_SECRET`,
      body: { value: 'hunter2' },
    });
    const text = renderResponseForAgent(
      TARGET,
      c,
      { kind: 'ok', status: 200, body: { key: 'JWT_SECRET', value: 'hunter2' } },
      KEY,
    );
    expect(text).toContain(maskValue('hunter2', KEY));
    expect(text).not.toContain('"hunter2"');
    expect(renderResponseForAgent(TARGET, c, { kind: 'unknown', detail: 'x' }, KEY)).toBe('');
  });
});
