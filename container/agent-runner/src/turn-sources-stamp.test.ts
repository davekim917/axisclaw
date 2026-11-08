/**
 * The sources half of the reply stamp: which replies take the recorded sources, and that nothing but the ledger can
 * put a `sources` key on a reply.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { _resetConfig, _setConfigForTest } from './config.js';
import { appendLedgerEntry, type LedgerEntry, setSourceRecording } from './source-ledger.js';
import { allowWritesTo, resetHermeticityAllowances } from './test-hermeticity.js';
import {
  _forgetOwnershipForTest,
  clearContextTokens,
  resetTurnStatus,
  setOwnConversation,
  setTurnSettings,
  stampStatusSubtext,
} from './turn-status.js';

const TS = '2026-11-03T14:02:00.000Z';
const lookerQuery: LedgerEntry = {
  v: 1,
  ts: TS,
  recorder: 'mcp',
  server: 'looker',
  origin: 'https://acme.looker.example',
  tool: 'query',
  args: { model: 'acme_retail', explore: 'web_sessions' },
  ok: true,
};

const chat = (over: Record<string, unknown> = {}) => ({
  kind: 'chat',
  agentReply: true,
  channel_type: 'slack',
  platform_id: 'C-MAIN',
  content: JSON.stringify({ text: 'hi' }),
  ...over,
});
const sourcesOf = (out: string): unknown => (JSON.parse(out) as { sources?: unknown }).sources;

let root: string;
let priorLedger: string | undefined;
beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'turn-sources-stamp-'));
  priorLedger = process.env.NANOCLAW_SOURCE_LEDGER;
});
afterAll(() => {
  if (priorLedger === undefined) delete process.env.NANOCLAW_SOURCE_LEDGER;
  else process.env.NANOCLAW_SOURCE_LEDGER = priorLedger;
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  allowWritesTo(dir);
  process.env.NANOCLAW_SOURCE_LEDGER = path.join(dir, 'ledger.jsonl');
  setSourceRecording(true);
  _resetConfig();
  _setConfigForTest({ sourcesFooter: true });
  resetTurnStatus();
  setTurnSettings('claude-opus-5', 'high');
  setOwnConversation('slack', 'C-MAIN');
});
afterEach(() => resetHermeticityAllowances());

describe('sources stamp', () => {
  it('puts the recorded sources on a reply to the own conversation, beside the status subtext', () => {
    appendLedgerEntry(lookerQuery);
    const out = JSON.parse(stampStatusSubtext(chat())) as Record<string, unknown>;
    expect(out.subtext).toBe('opus-5 · high');
    expect(out.sources).toEqual({
      version: 1,
      systems: [
        {
          system: 'looker',
          origin: 'https://acme.looker.example',
          calls: 1,
          lastAt: TS,
          objects: [{ kind: 'explore', model: 'acme_retail', explore: 'web_sessions' }],
        },
      ],
    });
  });

  it('credits a call to one reply only', () => {
    appendLedgerEntry(lookerQuery);
    expect(sourcesOf(stampStatusSubtext(chat()))).toBeDefined();
    expect(sourcesOf(stampStatusSubtext(chat()))).toBeUndefined();
  });

  it('leaves the calls for the own reply when a send goes elsewhere first', () => {
    appendLedgerEntry(lookerQuery);
    expect(sourcesOf(stampStatusSubtext(chat({ platform_id: 'C-OTHER' })))).toBeUndefined();
    expect(sourcesOf(stampStatusSubtext(chat()))).toBeDefined();
  });

  it('drops calls no reply took at the turn boundary', () => {
    appendLedgerEntry(lookerQuery);
    clearContextTokens();
    expect(sourcesOf(stampStatusSubtext(chat()))).toBeUndefined();
  });

  it('is on when the group config does not mention it', () => {
    _resetConfig();
    _setConfigForTest({});
    appendLedgerEntry(lookerQuery);
    expect(sourcesOf(stampStatusSubtext(chat()))).toBeDefined();
  });

  it('is off when the group set sourcesFooter: false', () => {
    _resetConfig();
    _setConfigForTest({ sourcesFooter: false });
    appendLedgerEntry(lookerQuery);
    expect(sourcesOf(stampStatusSubtext(chat()))).toBeUndefined();
  });

  it('still stamps sources when the status subtext is off', () => {
    _resetConfig();
    _setConfigForTest({ sourcesFooter: true, statusSubtext: false });
    appendLedgerEntry(lookerQuery);
    const out = JSON.parse(stampStatusSubtext(chat())) as Record<string, unknown>;
    expect(out.subtext).toBeUndefined();
    expect(out.sources).toBeDefined();
  });

  it('strips a sources key that did not come from the ledger, on every chat reply', () => {
    const forged = JSON.stringify({ text: 'hi', sources: { version: 1, systems: [{ system: 'looker', calls: 9 }] } });
    expect(sourcesOf(stampStatusSubtext(chat({ content: forged })))).toBeUndefined();
    expect(sourcesOf(stampStatusSubtext(chat({ content: forged, platform_id: 'C-OTHER' })))).toBeUndefined();
  });

  it('adds nothing when no data call was recorded', () => {
    _resetConfig();
    _setConfigForTest({ sourcesFooter: true, statusSubtext: false });
    const msg = chat();
    expect(stampStatusSubtext(msg)).toBe(msg.content);
  });

  it('stamps from the send_message subprocess, which reads the same ledger', async () => {
    const { initTestSessionDb } = await import('./modules/mailbox/testing.js');
    initTestSessionDb();
    resetTurnStatus();
    setOwnConversation('slack', 'C-MAIN');
    _forgetOwnershipForTest();
    appendLedgerEntry(lookerQuery);
    expect(sourcesOf(stampStatusSubtext(chat()))).toBeDefined();
  });
});
