import { describe, expect, it } from 'vitest';

import { buildThreadContextBlock } from './thread-context.js';
import type { Session } from './types.js';

const CODE = 'A'.repeat(43);
const session = { id: 'sess-1', engaged_at: null, last_outbound_at: null } as Session;

const blockFor = (text: string) =>
  buildThreadContextBlock({
    session,
    threadId: 'slack:D0DM:1.0',
    adapter: {
      fetchThreadHistory: async () => [{ sender: 'assistant', text, timestamp: '2026-10-31T12:00:00.000Z' }],
    },
  });

describe('buildThreadContextBlock', () => {
  it.each(['pair', 'replies'])(
    'drops the one-time value from a replayed /%s link, in plain text and in Slack link markup',
    async (path) => {
      for (const text of [
        `Open this: https://app.calls.example/${path}#${CODE}`,
        `Open this: <https://app.calls.example/${path}#${CODE}>`,
      ]) {
        const block = await blockFor(text);
        expect(block).not.toContain(CODE);
        expect(block).toContain(`https://app.calls.example/${path}#[code removed]`);
      }
    },
  );

  it('leaves every other link and all surrounding text alone', async () => {
    const text = 'see https://example.com/pair#section and https://example.com/docs#intro today';
    expect(await blockFor(text)).toContain(`assistant: ${text}`);
  });
});
