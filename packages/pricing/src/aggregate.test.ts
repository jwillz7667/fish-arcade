import { centsPerBtc } from '@reef/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { aggregateQuotes, type PriceQuote } from './aggregate.js';

const NOW = new Date('2026-11-21T12:00:00Z');
const quote = (source: string, cents: bigint, ageMs = 0): PriceQuote => ({
  source,
  centsPerBtc: centsPerBtc(cents),
  fetchedAt: new Date(NOW.getTime() - ageMs),
});

describe('aggregateQuotes (spec §22.1)', () => {
  it('uses the median of three fresh quotes', () => {
    const decision = aggregateQuotes(
      [quote('kraken', 5_778_060n), quote('coinbase', 5_777_588n), quote('bitstamp', 5_776_926n)],
      NOW,
    );

    expect(decision).toMatchObject({ status: 'usable', centsPerBtc: 5_777_588n });
  });

  it('uses the mean of the middle two, rounded down, for an even count', () => {
    expect(aggregateQuotes([quote('a', 5_000_000n), quote('b', 5_000_001n)], NOW)).toMatchObject({
      status: 'usable',
      centsPerBtc: 5_000_000n,
    });
  });

  it('keeps pricing with one source down, as long as two remain', () => {
    expect(
      aggregateQuotes([quote('kraken', 5_000_000n), quote('bitstamp', 5_001_000n)], NOW).status,
    ).toBe('usable');
  });

  it('is unusable with every source down', () => {
    expect(aggregateQuotes([], NOW)).toEqual({
      status: 'unusable',
      reason: 'too_few_sources',
      sources: [],
    });
  });

  it('ignores quotes 60 seconds old or more, so one stale source leaves too few', () => {
    const decision = aggregateQuotes(
      [quote('kraken', 5_000_000n), quote('coinbase', 5_000_000n, 60_000)],
      NOW,
    );

    expect(decision).toMatchObject({ status: 'unusable', reason: 'too_few_sources' });
    expect(decision.sources.map((source) => source.source)).toEqual(['kraken']);
  });

  it('counts a quote just under 60 seconds old', () => {
    expect(
      aggregateQuotes([quote('a', 5_000_000n), quote('b', 5_000_000n, 59_999)], NOW).status,
    ).toBe('usable');
  });

  it('is usable when the spread is exactly 1% of the median, and unusable past it', () => {
    const withThird = (third: bigint) =>
      aggregateQuotes([quote('a', 5_000_000n), quote('b', 5_000_000n), quote('c', third)], NOW);

    // Median 5,000,000: a 50,000 spread is exactly 1%.
    expect(withThird(5_050_000n).status).toBe('usable');
    expect(withThird(5_050_001n)).toMatchObject({ status: 'unusable', reason: 'sources_diverge' });
  });

  it('never prices outside the range of the fresh quotes', () => {
    fc.assert(
      fc.property(
        fc.array(fc.bigInt({ min: 4_990_000n, max: 5_010_000n }), { minLength: 2, maxLength: 5 }),
        (values) => {
          const decision = aggregateQuotes(
            values.map((value, index) => quote(`s${String(index)}`, value)),
            NOW,
          );
          if (decision.status !== 'usable') return true;
          return (
            decision.centsPerBtc >= values.reduce((a, b) => (a < b ? a : b)) &&
            decision.centsPerBtc <= values.reduce((a, b) => (a > b ? a : b))
          );
        },
      ),
    );
  });
});
