import { ErrorCode } from '@reef/errors';
import { centsPerBtc } from '@reef/money';
import { describe, expect, it } from 'vitest';

import { aggregateQuotes } from './aggregate.js';
import { PRICE_KEY, PriceReader, serializeDecision } from './published-price.js';
import { assertRatesAgree } from './rate-agreement.js';

const NOW = new Date('2026-11-21T12:00:00Z');
const usable = aggregateQuotes(
  [
    { source: 'kraken', centsPerBtc: centsPerBtc(5_000_000n), fetchedAt: NOW },
    { source: 'coinbase', centsPerBtc: centsPerBtc(5_001_000n), fetchedAt: NOW },
  ],
  NOW,
);

function reader(value: string | null | Error, at = NOW) {
  return new PriceReader({
    store: {
      get: (key: string) => {
        expect(key).toBe(PRICE_KEY);
        return value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
      },
    },
    now: () => at,
  });
}

describe('PriceReader.getRate', () => {
  it('returns a fresh usable price', async () => {
    expect(await reader(serializeDecision(usable, NOW)).getRate()).toBe(5_000_500n);
  });

  it.each([
    ['nothing is published', null, NOW, 'not_published'],
    ['the oracle paused', serializeDecision(aggregateQuotes([], NOW), NOW), NOW, 'too_few_sources'],
    [
      'the price is over 45 seconds old',
      serializeDecision(usable, NOW),
      new Date(NOW.getTime() + 45_001),
      'stale',
    ],
    ['the value is not a price', '{"status":"usable"}', NOW, 'malformed'],
    ['the value is not JSON', 'not json', NOW, 'malformed'],
  ])('fails closed when %s', async (_label, value, at, reason) => {
    await expect(reader(value, at).getRate()).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
      message: `BTC/USD price unavailable: ${reason}`,
    });
  });

  it('fails closed when Redis is unreachable', async () => {
    await expect(reader(new Error('ECONNREFUSED')).getRate()).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
  });

  it('publishes divergent prices with their reason and sources', () => {
    const divergent = aggregateQuotes(
      [
        { source: 'a', centsPerBtc: centsPerBtc(5_000_000n), fetchedAt: NOW },
        { source: 'b', centsPerBtc: centsPerBtc(5_200_000n), fetchedAt: NOW },
      ],
      NOW,
    );

    expect(JSON.parse(serializeDecision(divergent, NOW))).toMatchObject({
      status: 'unusable',
      reason: 'sources_diverge',
      sources: [
        { source: 'a', centsPerBtc: '5000000' },
        { source: 'b', centsPerBtc: '5200000' },
      ],
    });
  });
});

describe('assertRatesAgree', () => {
  it('accepts a BTCPay rate within 1% of the oracle, either side', () => {
    expect(() => {
      assertRatesAgree(centsPerBtc(5_050_000n), centsPerBtc(5_000_000n));
      assertRatesAgree(centsPerBtc(4_950_000n), centsPerBtc(5_000_000n));
    }).not.toThrow();
  });

  it('refuses one more than 1% away', () => {
    expect(() => {
      assertRatesAgree(centsPerBtc(5_050_001n), centsPerBtc(5_000_000n));
    }).toThrow(expect.objectContaining({ code: ErrorCode.DEPENDENCY_UNAVAILABLE }));
  });
});
