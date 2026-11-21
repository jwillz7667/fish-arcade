import { ErrorCode, ValidationError } from '@reef/errors';
import { describe, expect, it } from 'vitest';

import { cents, centsPerBtc, sats, units } from './types.js';

describe('constructors', () => {
  it('lets units be negative because ledger entries are signed', () => {
    expect(units(-5n)).toBe(-5n);
  });

  it.each([
    ['cents', () => cents(-1n)],
    ['sats', () => sats(-1n)],
    ['centsPerBtc zero', () => centsPerBtc(0n)],
    ['centsPerBtc negative', () => centsPerBtc(-1n)],
  ])('rejects an invalid %s with INVALID_AMOUNT', (_label, build) => {
    expect(build).toThrow(expect.objectContaining({ code: ErrorCode.INVALID_AMOUNT }));
  });

  it('throws ValidationError instances', () => {
    expect(() => sats(-1n)).toThrow(ValidationError);
  });

  it('accepts zero cents and sats and a positive rate', () => {
    expect([cents(0n), sats(0n), centsPerBtc(1n)]).toEqual([0n, 0n, 1n]);
  });
});
