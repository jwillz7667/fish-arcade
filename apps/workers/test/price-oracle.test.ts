import { createLogger, RequestContext } from '@reef/logger';
import { centsPerBtc } from '@reef/money';
import { PRICE_KEY, PriceReader } from '@reef/pricing';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest';

import {
  FixedPriceSource,
  PgSnapshotStore,
  PriceOracle,
  RedisPricePublisher,
  type PriceSource,
} from '../src/price-oracle/index.js';

const redis = new Redis(inject('workersRedisUrl'));
const pool = new pg.Pool({ connectionString: inject('workersDatabaseUrls').reef_app, max: 4 });
const logger = createLogger({ service: 'test', level: 'silent', context: new RequestContext() });

afterAll(async () => {
  await redis.quit();
  await pool.end();
});

beforeEach(async () => {
  await redis.del(PRICE_KEY);
});

function oracle(sources: readonly PriceSource[], at: () => Date): PriceOracle {
  return new PriceOracle({
    sources,
    publisher: new RedisPricePublisher(redis),
    snapshots: new PgSnapshotStore(pool),
    now: at,
    logger,
  });
}

const fixed = (name: string, cents: bigint) => new FixedPriceSource(name, centsPerBtc(cents));
const reader = (at: () => Date) => new PriceReader({ store: redis, now: at });

describe('price oracle against Redis and Postgres', () => {
  it('publishes a price that getRate reads back', async () => {
    const now = () => new Date();
    await oracle([fixed('a', 5_000_000n), fixed('b', 5_002_000n)], now).tick();

    expect(await reader(now).getRate()).toBe(5_001_000n);
    expect(await redis.ttl(PRICE_KEY)).toBeGreaterThan(0);
  });

  it('makes getRate fail closed while the oracle is paused', async () => {
    const now = () => new Date();
    await oracle([fixed('a', 5_000_000n), fixed('b', 5_200_000n)], now).tick();

    await expect(reader(now).getRate()).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });
  });

  it('stores one snapshot per minute even when two oracles run', async () => {
    const minute = new Date('2026-11-21T13:05:00Z');
    const at = () => new Date(minute.getTime() + 7_000);
    const sources = [fixed('a', 5_000_000n), fixed('b', 5_000_000n)];

    await Promise.all([oracle(sources, at).tick(), oracle(sources, at).tick()]);

    const { rows } = await pool.query<{ cents_per_btc: string; sources: unknown[] }>(
      'SELECT cents_per_btc, sources FROM price_snapshots WHERE taken_at = $1',
      [minute],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      cents_per_btc: '5000000',
      sources: [{ source: 'a' }, { source: 'b' }],
    });
  });
});
