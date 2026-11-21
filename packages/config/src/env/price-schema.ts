import { z } from 'zod';

/** Exchanges the oracle can poll, plus `fixed`, a development-only stand-in for regtest. */
export const PRICE_SOURCE_NAMES = ['coinbase', 'kraken', 'bitstamp', 'fixed'] as const;

const sourceListSchema = z
  .string()
  .transform((value) =>
    value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  )
  .pipe(
    z
      .array(z.enum(PRICE_SOURCE_NAMES))
      .min(1)
      .refine((names) => new Set(names).size === names.length, 'must not repeat a source'),
  );

/**
 * BTC/USD price oracle in apps/workers (playbook Step 11, spec §22.1). The two-source minimum,
 * 60-second freshness, and 1% divergence limit are spec rules, fixed in @reef/pricing. Startup
 * requires PRICE_FIXED_CENTS_PER_BTC when the `fixed` source is listed, since that spans two
 * variables.
 */
export const PRICE_SHAPE = {
  PRICE_SOURCES: sourceListSchema.default(['coinbase', 'kraken', 'bitstamp']),
  // Regtest's BTCPay store prices at a fixed rate; the `fixed` source reports the same one.
  PRICE_FIXED_CENTS_PER_BTC: z
    .string()
    .regex(/^[1-9]\d{0,14}$/, 'must be a positive whole number of cents')
    .optional(),
  PRICE_POLL_INTERVAL_MS: z.coerce.number().int().min(5_000).max(60_000).default(15_000),
};

/** Values that must never reach production: the fixed stand-in, or fewer than two exchanges. */
export const PRICE_DEV_ONLY_RULES = {
  PRICE_SOURCES: (value: unknown) =>
    Array.isArray(value) && (value.includes('fixed') || value.length < 2),
};
