import { describe, expect, it } from 'vitest';

import { isReservedAgent, reservedOwner, reservedTokenName } from './reserved-secrets.js';

describe('the reserved-token naming rule', () => {
  it.each([
    ['approved-run-acme token', 'approved-run-acme'],
    ['approved-run-acme-2 token', 'approved-run-acme-2'],
    ['approved-run-acme  token', null],
    ['Approved-run-acme token', null],
    ['approved-run-acme token ', null],
    ['approved-run-acme', null],
    ['approved-run- token', null],
    ['my approved-run-acme token', null],
    ['Linear-API-Key', null],
  ])('%s is reserved to %s', (name, owner) => {
    expect(reservedOwner(name)).toBe(owner);
  });

  it('reserves the whole agent family, and names each agent its own token', () => {
    expect(isReservedAgent('approved-run-acme')).toBe(true);
    expect(isReservedAgent('approved-run-acme-preview')).toBe(true);
    expect(isReservedAgent('ag-approved-run-acme')).toBe(false);
    expect(reservedOwner(reservedTokenName('approved-run-acme'))).toBe('approved-run-acme');
  });
});
