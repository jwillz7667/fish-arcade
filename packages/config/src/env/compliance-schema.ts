import { z } from 'zod';

import { isPlaceholderSecret } from './dev-only-rules.js';

/**
 * Geolocation settings (playbook Step 7, spec §15). Only the dev stub exists so far, and it is
 * rejected in production, so production fails closed until a vendor adapter is added.
 */
export const GEO_SHAPE = {
  GEO_PROVIDER: z.enum(['dev_stub']),
  // Locations reported with less confidence than this are treated as unknown, and blocked.
  GEO_MIN_CONFIDENCE: z.coerce.number().min(0).max(1).default(0.9),
  GEO_PROVIDER_TIMEOUT_MS: z.coerce.number().int().min(100).max(10_000).default(3_000),
  // Spec §15: SC play rechecks location every 10 minutes, so a check is good for that long.
  GEO_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(600).default(600),
};

/** Values that must never reach production. */
export const GEO_DEV_ONLY_RULES = {
  GEO_PROVIDER: (value: unknown) => value === 'dev_stub',
};

/**
 * KYC settings (playbook Step 8, spec §5.1, §15). Only the dev stub exists so far, and it is
 * rejected in production, so production fails closed until a vendor adapter is added.
 */
export const KYC_SHAPE = {
  KYC_PROVIDER: z.enum(['dev_stub']),
  // Shared secret for webhook signatures. Real vendors issue their own per endpoint.
  KYC_WEBHOOK_SECRET: z.string().min(32),
};

/** Values that must never reach production. */
export const KYC_DEV_ONLY_RULES = {
  KYC_PROVIDER: (value: unknown) => value === 'dev_stub',
  KYC_WEBHOOK_SECRET: isPlaceholderSecret,
};
