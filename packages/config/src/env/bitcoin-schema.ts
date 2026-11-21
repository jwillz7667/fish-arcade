import { z } from 'zod';

/**
 * The Bitcoin network (spec §22, playbook Step 10): regtest in development, signet in staging,
 * mainnet in production. Every address parser takes this value and rejects other networks'
 * addresses.
 */
export const BITCOIN_SHAPE = {
  BITCOIN_NETWORK: z.enum(['regtest', 'signet', 'mainnet']),
};

/** Values that must never reach production. Staging runs NODE_ENV=production on signet. */
export const BITCOIN_DEV_ONLY_RULES = {
  BITCOIN_NETWORK: (value: unknown) => value === 'regtest',
};
