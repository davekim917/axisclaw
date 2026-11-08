import { describe, expect, it } from 'vitest';

import {
  CLAUDE_ACCOUNT_MARK_MAX_MS,
  CLAUDE_ACCOUNT_RETRY_MS,
  claudeOauthSlots,
  claudeTokenFingerprint,
  isClaudeAccountSpent,
  markClaudeAccountSpent,
  spentClaudeSlots,
} from './claude-accounts.js';

const T0 = Date.parse('2026-01-05T00:00:00Z');

function ring(tag: string) {
  return claudeOauthSlots({
    oauthPrimary: `${tag}-one`,
    oauthFallbacks: [
      { index: 3, value: `${tag}-three` },
      { index: 2, value: `${tag}-two` },
    ],
  });
}

describe('claude account marks', () => {
  it('names the slots the container sees, primary first, and keeps a repeated token only once', () => {
    expect(
      claudeOauthSlots({
        oauthPrimary: 'tok-a',
        oauthFallbacks: [
          { index: 2, value: 'tok-b' },
          { index: 3, value: 'tok-a' },
          { index: 4, value: 'tok-c' },
        ],
      }).map((slot) => slot.name),
    ).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_2', 'CLAUDE_CODE_OAUTH_TOKEN_4']);
    expect(claudeOauthSlots({ oauthFallbacks: [{ index: 2, value: 'tok-b' }] })).toEqual([]);
  });

  it('withholds every marked slot, and none when every slot is marked', () => {
    const slots = ring('order');
    expect(spentClaudeSlots(slots, T0)).toEqual([]);
    markClaudeAccountSpent(claudeTokenFingerprint('order-two'), null, T0);
    expect(spentClaudeSlots(slots, T0 + 1)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN_2']);
    markClaudeAccountSpent(claudeTokenFingerprint('order-one'), null, T0);
    expect(spentClaudeSlots(slots, T0 + 1)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_2']);
    markClaudeAccountSpent(claudeTokenFingerprint('order-three'), null, T0);
    expect(spentClaudeSlots(slots, T0 + 1)).toEqual([]);
  });

  it.each([
    [
      'a global ring',
      {
        oauthPrimary: 'p',
        oauthFallbacks: [
          { index: 3, value: 'c' },
          { index: 2, value: 'b' },
        ],
      },
    ],
    [
      'a ring with a gap and a repeated token',
      {
        oauthPrimary: 'p',
        oauthFallbacks: [
          { index: 5, value: 'p' },
          { index: 2, value: 'b' },
          { index: 9, value: 'b' },
          { index: 4, value: 'd' },
        ],
      },
    ],
    [
      'a ring past slot 9',
      {
        oauthPrimary: 'p',
        oauthFallbacks: [
          { index: 10, value: 'k' },
          { index: 2, value: 'b' },
        ],
      },
    ],
    ['a lone primary', { oauthPrimary: 'p', oauthFallbacks: [] }],
  ])('names and orders %s exactly as the container builds it', async (_label, auth) => {
    // Outside the host's rootDir, so loaded by URL rather than imported.
    const { oauthCredentialRing } = (await import(
      new URL('../container/agent-runner/src/providers/claude-credential-ring.ts', import.meta.url).href
    )) as { oauthCredentialRing(env: NodeJS.ProcessEnv): { name: string; value: string }[] };
    const env = Object.fromEntries([
      ['CLAUDE_CODE_OAUTH_TOKEN', auth.oauthPrimary],
      ...auth.oauthFallbacks.map(({ index, value }) => [`CLAUDE_CODE_OAUTH_TOKEN_${index}`, value]),
    ]);
    expect(claudeOauthSlots(auth)).toEqual(oauthCredentialRing(env).map(({ name, value }) => ({ name, value })));
  });

  it('holds a mark until the reported reset, and an hour when there is none', () => {
    const reset = new Date(T0 + 3 * 24 * 60 * 60_000).toISOString();
    markClaudeAccountSpent(claudeTokenFingerprint('reset-known'), reset, T0);
    expect(isClaudeAccountSpent('reset-known', Date.parse(reset) - 1)).toBe(true);
    expect(isClaudeAccountSpent('reset-known', Date.parse(reset))).toBe(false);

    markClaudeAccountSpent(claudeTokenFingerprint('reset-unknown'), null, T0);
    expect(isClaudeAccountSpent('reset-unknown', T0 + CLAUDE_ACCOUNT_RETRY_MS - 1)).toBe(true);
    expect(isClaudeAccountSpent('reset-unknown', T0 + CLAUDE_ACCOUNT_RETRY_MS)).toBe(false);
  });

  it('treats a past or unparseable reset as unknown, and caps a far one at a week', () => {
    markClaudeAccountSpent(claudeTokenFingerprint('reset-past'), new Date(T0 - 1000).toISOString(), T0);
    expect(isClaudeAccountSpent('reset-past', T0 + CLAUDE_ACCOUNT_RETRY_MS)).toBe(false);
    markClaudeAccountSpent(claudeTokenFingerprint('reset-garbage'), 'next tuesday', T0);
    expect(isClaudeAccountSpent('reset-garbage', T0 + CLAUDE_ACCOUNT_RETRY_MS)).toBe(false);

    markClaudeAccountSpent(claudeTokenFingerprint('reset-far'), new Date(T0 + 30 * 24 * 60 * 60_000).toISOString(), T0);
    expect(isClaudeAccountSpent('reset-far', T0 + CLAUDE_ACCOUNT_MARK_MAX_MS - 1)).toBe(true);
    expect(isClaudeAccountSpent('reset-far', T0 + CLAUDE_ACCOUNT_MARK_MAX_MS)).toBe(false);
  });

  it('shares a mark between groups that forward the same token under different slot names', () => {
    markClaudeAccountSpent(claudeTokenFingerprint('shared-token'), null, T0);
    const other = claudeOauthSlots({
      oauthPrimary: 'other-one',
      oauthFallbacks: [
        { index: 2, value: 'shared-token' },
        { index: 5, value: 'other-five' },
      ],
    });
    markClaudeAccountSpent(claudeTokenFingerprint('other-one'), null, T0);
    expect(spentClaudeSlots(other, T0 + 1)).toEqual(['CLAUDE_CODE_OAUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN_2']);
  });
});
