import { centsPerBtc, type CentsPerBtc } from '@reef/money';

/** Spec §22.1 and playbook Step 11: at least two sources, each under 60 seconds old. */
export const MIN_FRESH_SOURCES = 2;
/** A quote older than this no longer counts. */
export const QUOTE_MAX_AGE_MS = 60_000;
/** Sources more than 1% apart make the price unusable, in basis points of the median. */
export const MAX_SPREAD_BPS = 100n;

/** The latest price one exchange reported. */
export interface PriceQuote {
  readonly source: string;
  readonly centsPerBtc: CentsPerBtc;
  readonly fetchedAt: Date;
}

/** Why the oracle refuses to price. */
export type UnusableReason = 'too_few_sources' | 'sources_diverge';

/** The oracle's verdict for one moment. */
export type PriceDecision =
  | {
      readonly status: 'usable';
      readonly centsPerBtc: CentsPerBtc;
      readonly sources: readonly PriceQuote[];
    }
  | {
      readonly status: 'unusable';
      readonly reason: UnusableReason;
      readonly sources: readonly PriceQuote[];
    };

// Callers pass at least MIN_FRESH_SOURCES prices, so every index read here exists.
function median(sorted: readonly bigint[]): bigint {
  const middle = Math.floor(sorted.length / 2);
  const upper = sorted.at(middle) ?? 0n;
  if (sorted.length % 2 === 1) return upper;
  // Even count: the mean of the two middle quotes, rounded down to the cent.
  return ((sorted.at(middle - 1) ?? 0n) + upper) / 2n;
}

/**
 * Turns the latest quote per source into a price (spec §22.1). Only quotes under 60 seconds old
 * count. With fewer than two, or when the cheapest and dearest differ by more than 1% of the
 * median, the price is unusable and every action that needs it fails closed.
 *
 * @param quotes The latest quote per source.
 * @param now Current time.
 * @returns The median price and the quotes behind it, or why there is none.
 */
export function aggregateQuotes(quotes: readonly PriceQuote[], now: Date): PriceDecision {
  const fresh = quotes.filter(
    (quote) => now.getTime() - quote.fetchedAt.getTime() < QUOTE_MAX_AGE_MS,
  );
  if (fresh.length < MIN_FRESH_SOURCES) {
    return { status: 'unusable', reason: 'too_few_sources', sources: fresh };
  }
  const prices: bigint[] = fresh
    .map((quote) => quote.centsPerBtc)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = median(prices);
  const spread = (prices.at(-1) ?? 0n) - (prices[0] ?? 0n);
  if (spread * 10_000n > mid * MAX_SPREAD_BPS) {
    return { status: 'unusable', reason: 'sources_diverge', sources: fresh };
  }
  return { status: 'usable', centsPerBtc: centsPerBtc(mid), sources: fresh };
}
