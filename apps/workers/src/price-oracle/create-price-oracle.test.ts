import { parseEnv, workersEnvSchema } from '@reef/config';
import { createLogger, RequestContext } from '@reef/logger';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';

import { createPriceOracle } from './create-price-oracle.js';

const BASE = {
  NODE_ENV: 'development',
  DATABASE_URL: 'postgresql://reef@127.0.0.1:5432/reef',
  REDIS_URL: 'redis://127.0.0.1:6379',
  FIELD_ENCRYPTION_PROVIDER: 'local',
  FIELD_ENCRYPTION_LOCAL_KEY_FILE: 'master.key',
  BLIND_INDEX_KEY_FILE: 'index.key',
  BITCOIN_NETWORK: 'regtest',
};

const logger = createLogger({ service: 'test', level: 'silent', context: new RequestContext() });
// Just enough of each client for one round.
const redis = { set: () => Promise.resolve('OK') } as unknown as Redis;
const pool = { query: () => Promise.resolve({ rows: [] }) } as unknown as Pool;

function oracleFor(extra: Record<string, string>) {
  return createPriceOracle({
    env: parseEnv(workersEnvSchema, { ...BASE, ...extra }),
    redis,
    pool,
    logger,
  });
}

describe('createPriceOracle', () => {
  it('prices from two fixed stand-ins in development, so the two-source rule still runs', async () => {
    const oracle = oracleFor({ PRICE_SOURCES: 'fixed', PRICE_FIXED_CENTS_PER_BTC: '5000000' });

    const decision = await oracle.tick();

    expect(decision).toMatchObject({ status: 'usable', centsPerBtc: 5_000_000n });
    expect(decision.sources.map((quote) => quote.source)).toEqual(['fixed-a', 'fixed-b']);
  });

  it('refuses the fixed source without its price', () => {
    expect(() => oracleFor({ PRICE_SOURCES: 'fixed' })).toThrow(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });
});
