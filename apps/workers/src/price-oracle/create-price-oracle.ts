import type { WorkersEnv } from '@reef/config';
import { ConfigError } from '@reef/errors';
import type { Logger } from '@reef/logger';
import { centsPerBtc } from '@reef/money';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { ExchangePriceSource, FixedPriceSource } from './exchange-sources.js';
import { PriceOracle } from './price-oracle.js';
import type { PriceSource } from './price-source.js';
import { PgSnapshotStore, RedisPricePublisher } from './price-stores.js';

function sourcesFor(env: WorkersEnv): PriceSource[] {
  if (!env.PRICE_SOURCES.includes('fixed')) {
    return env.PRICE_SOURCES.flatMap((name) =>
      name === 'fixed' ? [] : [new ExchangePriceSource(name)],
    );
  }
  if (env.PRICE_FIXED_CENTS_PER_BTC === undefined) {
    throw new ConfigError({
      issues: [
        {
          path: 'PRICE_FIXED_CENTS_PER_BTC',
          message: 'required when PRICE_SOURCES includes fixed',
        },
      ],
    });
  }
  const price = centsPerBtc(BigInt(env.PRICE_FIXED_CENTS_PER_BTC));
  // Two stand-ins, so the two-source rule still runs in development.
  return [new FixedPriceSource('fixed-a', price), new FixedPriceSource('fixed-b', price)];
}

/**
 * Wires the oracle from config.
 *
 * @param input Env, Redis, Postgres pool, and logger.
 * @returns An oracle ready to start.
 * @throws ConfigError when the fixed source is listed without its price.
 */
export function createPriceOracle(input: {
  env: WorkersEnv;
  redis: Redis;
  pool: Pool;
  logger: Logger;
}): PriceOracle {
  return new PriceOracle({
    sources: sourcesFor(input.env),
    publisher: new RedisPricePublisher(input.redis),
    snapshots: new PgSnapshotStore(input.pool),
    now: () => new Date(),
    logger: input.logger,
  });
}
