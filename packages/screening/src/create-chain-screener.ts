import { ConfigError } from '@reef/errors';

import type { ChainRiskProvider } from './chain-risk-provider.js';
import { ChainScreener } from './chain-screener.js';
import { OfacList } from './ofac/ofac-list.js';
import { DevStubChainRiskProvider, type DevStubStore } from './providers/dev-stub.js';
import { TrmLabsProvider } from './providers/trm-labs.js';
import type { Queryable } from './queryable.js';
import { ScreeningCache, type CacheStore } from './screening-cache.js';
import { ScreeningRecorder } from './screening-recorder.js';

/** The screening settings from the API or workers env (`SCREENING_SHAPE`). */
export interface ScreeningSettings {
  readonly BITCOIN_NETWORK: 'regtest' | 'signet' | 'mainnet';
  readonly CHAIN_RISK_PROVIDER: 'dev_stub' | 'trm_labs';
  readonly TRM_API_KEY?: string | undefined;
  readonly TRM_API_URL: string;
  readonly SCREENING_TIMEOUT_MS: number;
  readonly OFAC_MAX_AGE_HOURS: number;
}

function misconfigured(path: string, message: string): ConfigError {
  return new ConfigError({ issues: [{ path, message }] });
}

/**
 * @param settings Parsed env.
 * @param store Redis, where the dev stub keeps scripted verdicts.
 * @returns The configured vendor.
 * @throws ConfigError when the dev stub is set on mainnet, or TRM Labs is set off mainnet or
 *   without its key. Real money only moves on mainnet, so that is where the stub is refused.
 */
export function createChainRiskProvider(
  settings: ScreeningSettings,
  store: DevStubStore,
): ChainRiskProvider {
  const isMainnet = settings.BITCOIN_NETWORK === 'mainnet';
  switch (settings.CHAIN_RISK_PROVIDER) {
    case 'dev_stub':
      if (isMainnet)
        throw misconfigured('CHAIN_RISK_PROVIDER', 'dev_stub is not allowed on mainnet');
      return new DevStubChainRiskProvider(store);
    case 'trm_labs':
      if (!isMainnet)
        throw misconfigured('CHAIN_RISK_PROVIDER', 'trm_labs screens mainnet addresses only');
      if (settings.TRM_API_KEY === undefined) {
        throw misconfigured('TRM_API_KEY', 'is required when CHAIN_RISK_PROVIDER is trm_labs');
      }
      return new TrmLabsProvider({
        apiKey: settings.TRM_API_KEY,
        baseUrl: settings.TRM_API_URL,
        timeoutMs: settings.SCREENING_TIMEOUT_MS,
      });
  }
}

/**
 * Wires a {@link ChainScreener} from config.
 *
 * @param input Settings, the vendor, Postgres, Redis, the address blind index, and the clock.
 * @returns The screener.
 */
export function createChainScreener(input: {
  settings: ScreeningSettings;
  provider: ChainRiskProvider;
  db: Queryable;
  cache: CacheStore;
  indexAddress: (address: string) => string;
  now: () => Date;
}): ChainScreener {
  return new ChainScreener({
    provider: input.provider,
    ofac: new OfacList({
      db: input.db,
      now: input.now,
      maxAgeMs: input.settings.OFAC_MAX_AGE_HOURS * 3_600_000,
    }),
    cache: new ScreeningCache(input.cache),
    recorder: new ScreeningRecorder(input.db),
    indexAddress: input.indexAddress,
  });
}
