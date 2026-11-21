import { ErrorCode } from '@reef/errors';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { formatCoins, formatUsd } from './format.js';
import { parseCoins, parseUsd } from './parse.js';
import { cents, units } from './types.js';

describe('parseCoins', () => {
  it.each([
    ['0', 0n],
    ['12', 12_000_000n],
    ['12.5', 12_500_000n],
    ['0.000001', 1n],
    ['999999999999999.999999', 999_999_999_999_999_999_999n],
  ])('parses %s exactly', (text, expected) => {
    expect(parseCoins(text)).toBe(expected);
  });

  it.each([
    '',
    '-1',
    '+1',
    '1e3',
    '1,000',
    '01',
    '1.',
    '.5',
    '1.0000001',
    ' 1',
    'NaN',
    '1000000000000000',
  ])('rejects %j', (text) => {
    expect(() => parseCoins(text)).toThrow(
      expect.objectContaining({ code: ErrorCode.INVALID_AMOUNT }),
    );
  });

  it('round-trips full-precision formatting', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 20n }), (value) => {
        const amount = units(value);
        return parseCoins(formatCoins(amount, 'full').replaceAll(',', '')) === amount;
      }),
    );
  });
});

describe('parseUsd', () => {
  it.each([
    ['0', 0n],
    ['19.99', 1_999n],
    ['19.9', 1_990n],
    ['5', 500n],
  ])('parses %s exactly', (text, expected) => {
    expect(parseUsd(text)).toBe(expected);
  });

  it.each(['$5', '-5', '5.999', '5,000', 'abc'])('rejects %j', (text) => {
    expect(() => parseUsd(text)).toThrow(
      expect.objectContaining({ code: ErrorCode.INVALID_AMOUNT }),
    );
  });

  it('round-trips formatting', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 16n }), (value) => {
        const amount = cents(value);
        return parseUsd(formatUsd(amount).slice(1).replaceAll(',', '')) === amount;
      }),
    );
  });
});
