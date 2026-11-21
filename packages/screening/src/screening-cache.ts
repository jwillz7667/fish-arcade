import { z } from 'zod';

import type { ProviderVerdict } from './chain-risk-provider.js';

/** The part of an ioredis client the cache uses. */
export interface CacheStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

/** Playbook Step 12: low-risk results are reused for 24 hours. */
export const CLEAN_RESULT_TTL_SECONDS = 24 * 60 * 60;

// Only a clean verdict is ever written, and a read accepts nothing else, so a sanctioned or
// risky result can never come back as clean, even if something else wrote the key.
const cleanSchema = z.object({
  riskLevel: z.literal('low'),
  sanctioned: z.literal(false),
  categories: z.array(z.string()).max(50),
});

const keyFor = (provider: string, addressIndex: string): string =>
  `screening:v1:${provider}:${addressIndex}`;

/**
 * Caches clean address verdicts per vendor, keyed by the address's blind index so no address
 * reaches Redis. The OFAC check runs before the cache on every call, so a newly listed address
 * is caught even while its clean verdict is cached.
 */
export class ScreeningCache {
  constructor(private readonly store: CacheStore) {}

  /**
   * @param provider Vendor name.
   * @param addressIndex Blind index of the address.
   * @returns A cached clean verdict, or undefined (also when Redis fails: the vendor is asked).
   */
  async getClean(provider: string, addressIndex: string): Promise<ProviderVerdict | undefined> {
    try {
      const raw = await this.store.get(keyFor(provider, addressIndex));
      if (raw === null) return undefined;
      const parsed = cleanSchema.safeParse(JSON.parse(raw));
      return parsed.success ? parsed.data : undefined;
    } catch {
      // A miss is always safe: the vendor screens the address again.
      return undefined;
    }
  }

  /**
   * Stores the verdict only when it is clean: low risk and not sanctioned.
   *
   * @param provider Vendor name.
   * @param addressIndex Blind index of the address.
   * @param verdict The vendor's verdict.
   */
  async putIfClean(
    provider: string,
    addressIndex: string,
    verdict: ProviderVerdict,
  ): Promise<void> {
    if (verdict.riskLevel !== 'low' || verdict.sanctioned) return;
    try {
      await this.store.set(
        keyFor(provider, addressIndex),
        JSON.stringify({ riskLevel: 'low', sanctioned: false, categories: verdict.categories }),
        'EX',
        CLEAN_RESULT_TTL_SECONDS,
      );
    } catch {
      // Caching is an optimisation; the next screening asks the vendor.
    }
  }
}
