import { z } from 'zod';

import { isPlaceholderSecret } from './dev-only-rules.js';

/** Chain-risk vendors with an adapter. `dev_stub` is for regtest and signet only. */
export const CHAIN_RISK_PROVIDERS = ['dev_stub', 'trm_labs'] as const;

/**
 * Chain screening (playbook Step 12, spec §15, §22, ADR 0007). Startup refuses `dev_stub` on
 * mainnet and `trm_labs` anywhere else, since that spans two variables. The 24-hour cache and
 * the policy table are spec rules, fixed in @reef/screening.
 */
export const SCREENING_SHAPE = {
  CHAIN_RISK_PROVIDER: z.enum(CHAIN_RISK_PROVIDERS),
  TRM_API_KEY: z.string().min(16).optional(),
  TRM_API_URL: z.url({ protocol: /^https$/ }).default('https://api.trmlabs.com'),
  SCREENING_TIMEOUT_MS: z.coerce.number().int().min(1_000).max(30_000).default(5_000),
  // The daily import confirms the list; three missed days fail screening closed.
  OFAC_MAX_AGE_HOURS: z.coerce.number().int().min(24).max(168).default(72),
};

/** Values that must never reach production. */
export const SCREENING_DEV_ONLY_RULES = {
  TRM_API_KEY: (value: unknown) => value !== undefined && isPlaceholderSecret(value),
};

/** The OFAC import job in apps/workers. */
export const OFAC_IMPORT_SHAPE = {
  OFAC_SDN_URL: z
    .url({ protocol: /^https$/ })
    .default('https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML'),
  OFAC_IMPORT_INTERVAL_HOURS: z.coerce.number().int().min(1).max(24).default(24),
};
