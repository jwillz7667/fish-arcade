import { parseCentsPerBtc, type CentsPerBtc } from '@reef/money';
import { z } from 'zod';

import type { PriceSource } from './price-source.js';

const TIMEOUT_MS = 5_000;

/** Exchanges with a built-in adapter. */
export type ExchangeName = 'coinbase' | 'kraken' | 'bitstamp';

// parseCentsPerBtc does the strict decimal check; this only bounds the input.
const decimal = z.string().min(1).max(32);

interface Ticker {
  readonly url: string;
  /** Extracts the last-trade price, as the decimal string the exchange sends. */
  readonly priceOf: (body: unknown) => string;
}

// Public BTC/USD tickers that need no API key.
function tickerFor(exchange: ExchangeName): Ticker {
  switch (exchange) {
    case 'coinbase':
      return {
        url: 'https://api.exchange.coinbase.com/products/BTC-USD/ticker',
        priceOf: (body) => z.object({ price: decimal }).parse(body).price,
      };
    case 'kraken':
      return {
        url: 'https://api.kraken.com/0/public/Ticker?pair=XBTUSD',
        priceOf: (body) =>
          z
            .object({
              error: z.array(z.string()).length(0),
              result: z.object({ XXBTZUSD: z.object({ c: z.tuple([decimal, z.string()]) }) }),
            })
            .parse(body).result.XXBTZUSD.c[0],
      };
    case 'bitstamp':
      return {
        url: 'https://www.bitstamp.net/api/v2/ticker/btcusd/',
        priceOf: (body) => z.object({ last: decimal }).parse(body).last,
      };
  }
}

/**
 * A public exchange ticker (playbook Step 11). Prices are parsed straight from the exchange's
 * decimal string into integer cents per BTC; no float ever holds one.
 */
export class ExchangePriceSource implements PriceSource {
  readonly name: ExchangeName;

  constructor(
    exchange: ExchangeName,
    private readonly fetchFn: typeof fetch = fetch,
  ) {
    this.name = exchange;
  }

  /**
   * @returns The exchange's last-trade BTC/USD price.
   * @throws Error when the exchange is unreachable, answers with an error status, or the body
   *   is not a ticker.
   */
  async fetchPrice(): Promise<CentsPerBtc> {
    const ticker = tickerFor(this.name);
    const response = await this.fetchFn(ticker.url, {
      headers: { accept: 'application/json', 'user-agent': 'reef-price-oracle' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`${this.name} returned ${String(response.status)}`);
    return parseCentsPerBtc(ticker.priceOf(await response.json()));
  }
}

/**
 * Reports one fixed price. Development only: regtest's BTCPay store prices at a fixed rate, and
 * config refuses this source in production.
 */
export class FixedPriceSource implements PriceSource {
  constructor(
    readonly name: string,
    private readonly price: CentsPerBtc,
  ) {}

  /** @returns The fixed price. */
  fetchPrice(): Promise<CentsPerBtc> {
    return Promise.resolve(this.price);
  }
}
