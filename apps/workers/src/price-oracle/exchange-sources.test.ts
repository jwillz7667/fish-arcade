import { centsPerBtc } from '@reef/money';
import { describe, expect, it, vi } from 'vitest';

import { ExchangePriceSource, FixedPriceSource, type ExchangeName } from './exchange-sources.js';

const reply = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

// Shapes as the exchanges return them (trimmed).
const TICKERS: [ExchangeName, unknown, bigint][] = [
  ['coinbase', { ask: '57775.22', bid: '57775.21', price: '57775.88' }, 5_777_588n],
  [
    'kraken',
    {
      error: [],
      result: { XXBTZUSD: { a: ['57780.6', '1', '1.000'], c: ['57780.60000', '0.00008903'] } },
    },
    5_778_060n,
  ],
  ['bitstamp', { timestamp: '1795251954', last: '57769.26', bid: '57760.05' }, 5_776_926n],
];

describe('ExchangePriceSource', () => {
  it.each(TICKERS)(
    'reads the last trade from %s in exact cents',
    async (exchange, body, expected) => {
      const fetchFn = reply(body);

      expect(await new ExchangePriceSource(exchange, fetchFn).fetchPrice()).toBe(expected);
      const url = fetchFn.mock.calls[0]?.[0];
      expect(typeof url === 'string' && url.startsWith('https://')).toBe(true);
    },
  );

  it.each([
    ['an error status', reply({ message: 'busy' }, 503)],
    ['a body that is not a ticker', reply({ price: 57775.88 })],
    ['a Kraken error', reply({ error: ['EService:Unavailable'], result: {} })],
    ['a network failure', vi.fn<typeof fetch>(() => Promise.reject(new Error('ECONNRESET')))],
  ])('fails on %s, so the oracle counts the source as down', async (_label, fetchFn) => {
    const exchange: ExchangeName = _label === 'a Kraken error' ? 'kraken' : 'coinbase';

    await expect(new ExchangePriceSource(exchange, fetchFn).fetchPrice()).rejects.toThrow();
  });
});

describe('FixedPriceSource', () => {
  it('reports its fixed price', async () => {
    expect(await new FixedPriceSource('fixed-a', centsPerBtc(5_000_000n)).fetchPrice()).toBe(
      5_000_000n,
    );
  });
});
