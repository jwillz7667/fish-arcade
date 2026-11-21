import { describe, expect, it } from 'vitest';

import { formatBtc, formatCoins, formatRate, formatUsd } from './format.js';
import { cents, centsPerBtc, sats, units } from './types.js';

describe('formatCoins', () => {
  it.each([
    [1_234_567_890n, 'cents', '1,234.56'],
    [1_234_567_890n, 'whole', '1,234'],
    [1_234_567_890n, 'full', '1,234.567890'],
    [0n, 'cents', '0.00'],
    [9_999n, 'cents', '0.00'],
    [10_000n, 'cents', '0.01'],
    [123n, 'full', '0.000123'],
    [1_000_000_000_000n, 'whole', '1,000,000'],
  ] as const)('formats %s units at %s precision as %s', (amount, precision, expected) => {
    expect(formatCoins(units(amount), precision)).toBe(expected);
  });

  it('defaults to two decimals', () => {
    expect(formatCoins(units(2_500_000n))).toBe('2.50');
  });

  it('rounds negative amounts down, away from zero', () => {
    expect([
      formatCoins(units(-1n)),
      formatCoins(units(-10_000n)),
      formatCoins(units(-1_500_000n), 'whole'),
    ]).toEqual(['-0.01', '-0.01', '-2']);
  });
});

describe('formatUsd', () => {
  it.each([
    [0n, '$0.00'],
    [5n, '$0.05'],
    [123_456n, '$1,234.56'],
  ])('formats %s cents as %s', (amount, expected) => {
    expect(formatUsd(cents(amount))).toBe(expected);
  });
});

describe('formatRate', () => {
  it('formats cents per BTC', () => {
    expect(formatRate(centsPerBtc(6_543_210n))).toBe('$65,432.10/BTC');
  });
});

describe('formatBtc', () => {
  it.each([
    [0n, '0.00000000 BTC'],
    [12_345n, '0.00012345 BTC'],
    [2_100_000_000_000_000n, '21,000,000.00000000 BTC'],
  ])('formats %s sats as %s', (amount, expected) => {
    expect(formatBtc(sats(amount))).toBe(expected);
  });
});
