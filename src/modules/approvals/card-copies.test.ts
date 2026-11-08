/** Which recorded copies of a card count: only well-formed entries, from a list the host wrote. */
import { describe, expect, it } from 'vitest';

import { cardCopies, clickedCopy } from './card-copies.js';

const COPY = { channel_type: 'slack', platform_id: 'slack:D1', instance: null, platform_message_id: '111.1' };

describe('cardCopies', () => {
  it('names no copies when the stored list is not JSON', () => {
    expect(cardCopies({ card_copies: '{' })).toEqual([]);
  });

  it('drops entries missing a field, so a partial entry can never match a click', () => {
    const partial = { channel_type: 'slack', platform_id: 'slack:D1', instance: null };
    expect(cardCopies({ card_copies: JSON.stringify([partial, COPY, 'x', null]) })).toEqual([COPY]);
  });
});

describe('clickedCopy', () => {
  const approval = { card_copies: JSON.stringify([COPY]) };

  it('matches on channel, conversation and message together', () => {
    expect(clickedCopy(approval, { channelType: 'slack', platformId: 'slack:D1', messageId: '111.1' })).toEqual(COPY);
  });

  it('matches nothing for a click that carries no conversation or no message id', () => {
    expect(clickedCopy(approval, { channelType: 'slack', platformId: '', messageId: '111.1' })).toBeUndefined();
    expect(clickedCopy(approval, { channelType: 'slack', platformId: 'slack:D1', messageId: null })).toBeUndefined();
  });
});
