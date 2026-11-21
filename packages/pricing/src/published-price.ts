import { DependencyUnavailableError } from '@reef/errors';
import { centsPerBtc, type CentsPerBtc } from '@reef/money';
import { z } from 'zod';

import type { PriceDecision, UnusableReason } from './aggregate.js';

/** Redis key the oracle publishes to and every reader reads. */
export const PRICE_KEY = 'price:v1:btc_usd';

/**
 * A published price older than this means the oracle stopped publishing (it polls every 15
 * seconds), so readers treat it as unusable.
 */
export const PUBLISHED_MAX_AGE_MS = 45_000;

/** Redis expiry for the published price, a backstop for {@link PUBLISHED_MAX_AGE_MS}. */
export const PUBLISHED_TTL_SECONDS = 120;

const quoteSchema = z.object({
  source: z.string(),
  centsPerBtc: z.string().regex(/^[1-9]\d*$/),
  fetchedAt: z.iso.datetime(),
});

const publishedSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('usable'),
    centsPerBtc: z.string().regex(/^[1-9]\d*$/),
    sources: z.array(quoteSchema),
    computedAt: z.iso.datetime(),
  }),
  z.object({
    status: z.literal('unusable'),
    reason: z.enum(['too_few_sources', 'sources_diverge']),
    sources: z.array(quoteSchema),
    computedAt: z.iso.datetime(),
  }),
]);

/** The published form of a decision: JSON-safe, with amounts as decimal strings. */
export type PublishedPrice = z.infer<typeof publishedSchema>;

/**
 * @param decision The oracle's verdict.
 * @param computedAt When it was made.
 * @returns The JSON to publish under {@link PRICE_KEY}.
 */
export function serializeDecision(decision: PriceDecision, computedAt: Date): string {
  const sources = decision.sources.map((quote) => ({
    source: quote.source,
    centsPerBtc: quote.centsPerBtc.toString(),
    fetchedAt: quote.fetchedAt.toISOString(),
  }));
  const published: PublishedPrice =
    decision.status === 'usable'
      ? {
          status: 'usable',
          centsPerBtc: decision.centsPerBtc.toString(),
          sources,
          computedAt: computedAt.toISOString(),
        }
      : {
          status: 'unusable',
          reason: decision.reason,
          sources,
          computedAt: computedAt.toISOString(),
        };
  return JSON.stringify(published);
}

/** Reads one Redis value. Satisfied by an ioredis client. */
export interface PriceStore {
  get(key: string): Promise<string | null>;
}

/** Why {@link PriceReader.getRate} refused. */
export type RateUnavailableReason = UnusableReason | 'not_published' | 'stale' | 'malformed';

/**
 * Reads the oracle's published BTC/USD price (playbook Step 11). Purchases and payouts call
 * {@link getRate} and fail closed when it throws.
 */
export class PriceReader {
  constructor(private readonly deps: { readonly store: PriceStore; readonly now: () => Date }) {}

  /**
   * @returns The current rate in integer cents per BTC.
   * @throws DependencyUnavailableError (dependency `price_oracle`) when no usable price is
   *   published, or the published one is more than 45 seconds old.
   */
  async getRate(): Promise<CentsPerBtc> {
    let raw: string | null;
    try {
      raw = await this.deps.store.get(PRICE_KEY);
    } catch (error) {
      throw new DependencyUnavailableError({
        dependency: 'price_oracle',
        message: 'Price store unreachable',
        cause: error,
      });
    }
    if (raw === null) throw unavailable('not_published');
    let parsed: PublishedPrice;
    try {
      parsed = publishedSchema.parse(JSON.parse(raw));
    } catch (error) {
      throw unavailable('malformed', error);
    }
    if (this.deps.now().getTime() - Date.parse(parsed.computedAt) > PUBLISHED_MAX_AGE_MS) {
      throw unavailable('stale');
    }
    if (parsed.status === 'unusable') throw unavailable(parsed.reason);
    return centsPerBtc(BigInt(parsed.centsPerBtc));
  }
}

function unavailable(reason: RateUnavailableReason, cause?: unknown): DependencyUnavailableError {
  return new DependencyUnavailableError({
    dependency: 'price_oracle',
    message: `BTC/USD price unavailable: ${reason}`,
    ...(cause === undefined ? {} : { cause }),
  });
}
