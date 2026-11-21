import type { CentsPerBtc } from '@reef/money';
import {
  PRICE_KEY,
  PUBLISHED_TTL_SECONDS,
  serializeDecision,
  type PriceDecision,
  type PriceQuote,
} from '@reef/pricing';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import type { PricePublisher, SnapshotStore } from './price-oracle.js';

/** Publishes decisions to Redis, where every API instance reads them. */
export class RedisPricePublisher implements PricePublisher {
  constructor(private readonly redis: Redis) {}

  /**
   * @param decision The decision.
   * @param at When it was made.
   * @throws Error when Redis rejects the write.
   */
  async publish(decision: PriceDecision, at: Date): Promise<void> {
    // The expiry backs up the readers' own age check if the oracle stops.
    await this.redis.set(PRICE_KEY, serializeDecision(decision, at), 'EX', PUBLISHED_TTL_SECONDS);
  }
}

/** One snapshot per minute in `price_snapshots`. */
export class PgSnapshotStore implements SnapshotStore {
  constructor(private readonly pool: Pool) {}

  /**
   * @param snapshot Price, the quotes behind it, and the minute it belongs to.
   * @throws Error when Postgres rejects the insert.
   */
  async insert(snapshot: {
    centsPerBtc: CentsPerBtc;
    sources: readonly PriceQuote[];
    minute: Date;
  }): Promise<void> {
    const sources = snapshot.sources.map((quote) => ({
      source: quote.source,
      centsPerBtc: quote.centsPerBtc.toString(),
      fetchedAt: quote.fetchedAt.toISOString(),
    }));
    // taken_at is unique, so a restarted or second oracle cannot store a minute twice.
    await this.pool.query(
      `INSERT INTO price_snapshots (cents_per_btc, sources, taken_at)
       VALUES ($1, $2::jsonb, $3) ON CONFLICT (taken_at) DO NOTHING`,
      [snapshot.centsPerBtc.toString(), JSON.stringify(sources), snapshot.minute],
    );
  }
}
