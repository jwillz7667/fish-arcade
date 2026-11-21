import { ErrorCode } from '@reef/errors';
import { describe, expect, it } from 'vitest';

import {
  createChainRiskProvider,
  createChainScreener,
  type ScreeningSettings,
} from './create-chain-screener.js';
import type { Queryable } from './queryable.js';

const store = { get: () => Promise.resolve(null), set: () => Promise.resolve('OK') };
const BASE: ScreeningSettings = {
  BITCOIN_NETWORK: 'regtest',
  CHAIN_RISK_PROVIDER: 'dev_stub',
  TRM_API_URL: 'https://api.trmlabs.com',
  SCREENING_TIMEOUT_MS: 5000,
  OFAC_MAX_AGE_HOURS: 72,
};

describe('createChainRiskProvider', () => {
  it('uses the dev stub on regtest and signet', () => {
    expect(createChainRiskProvider(BASE, store).name).toBe('dev_stub');
    expect(createChainRiskProvider({ ...BASE, BITCOIN_NETWORK: 'signet' }, store).name).toBe(
      'dev_stub',
    );
  });

  it('uses TRM Labs on mainnet', () => {
    const settings = {
      ...BASE,
      BITCOIN_NETWORK: 'mainnet',
      CHAIN_RISK_PROVIDER: 'trm_labs',
      TRM_API_KEY: 'k'.repeat(32),
    } as const;

    expect(createChainRiskProvider(settings, store).name).toBe('trm_labs');
  });

  it.each<[string, Partial<ScreeningSettings>]>([
    ['the dev stub on mainnet', { BITCOIN_NETWORK: 'mainnet' }],
    ['TRM Labs off mainnet', { CHAIN_RISK_PROVIDER: 'trm_labs', TRM_API_KEY: 'k'.repeat(32) }],
    ['TRM Labs without a key', { BITCOIN_NETWORK: 'mainnet', CHAIN_RISK_PROVIDER: 'trm_labs' }],
  ])('refuses %s at startup', (_label, overrides) => {
    expect(() => createChainRiskProvider({ ...BASE, ...overrides }, store)).toThrow(
      expect.objectContaining({ code: ErrorCode.CONFIG_INVALID }),
    );
  });
});

describe('createChainScreener', () => {
  it('screens through the OFAC list and the configured vendor', async () => {
    const db = {
      // The OFAC query sees a fresh list with no match; the history insert returns nothing.
      query: () =>
        Promise.resolve({
          rows: [{ list_version: 'v', checked_at: new Date(), address: null }],
          rowCount: 1,
        }),
    } as unknown as Queryable;
    const screener = createChainScreener({
      settings: BASE,
      provider: createChainRiskProvider(BASE, store),
      db,
      cache: store,
      indexAddress: (address) => `idx-${address}`,
      now: () => new Date(),
    });

    expect(await screener.screenAddress('bcrt1qexample')).toEqual({
      status: 'screened',
      verdict: { riskLevel: 'low', categories: [], sanctioned: false, provider: 'dev_stub' },
    });
  });
});
