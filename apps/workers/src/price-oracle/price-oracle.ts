import type { Logger } from '@reef/logger';
import type { CentsPerBtc } from '@reef/money';
import { aggregateQuotes, type PriceDecision, type PriceQuote } from '@reef/pricing';

import type { PriceSource } from './price-source.js';

/** Publishes each decision where readers (`PriceReader`) find it. */
export interface PricePublisher {
  publish(decision: PriceDecision, at: Date): Promise<void>;
}

/** Stores at most one usable price per minute (`price_snapshots`). */
export interface SnapshotStore {
  /** Ignores a second snapshot for a minute that already has one. */
  insert(snapshot: {
    centsPerBtc: CentsPerBtc;
    sources: readonly PriceQuote[];
    minute: Date;
  }): Promise<void>;
}

/** Collaborators for {@link PriceOracle}. */
export interface PriceOracleDeps {
  readonly sources: readonly PriceSource[];
  readonly publisher: PricePublisher;
  readonly snapshots: SnapshotStore;
  readonly now: () => Date;
  readonly logger: Logger;
}

const MINUTE_MS = 60_000;

/**
 * The BTC/USD oracle (playbook Step 11, spec §22.1). Each round polls every source, keeps the
 * latest quote per source, decides with {@link aggregateQuotes}, publishes the decision, and
 * stores a snapshot once a minute. When the price becomes unusable it logs the
 * `price_oracle.paused` metric at error level, which alerting watches; purchases and payouts
 * then fail closed in `PriceReader.getRate`.
 */
export class PriceOracle {
  readonly #latest = new Map<string, PriceQuote>();
  #isUsable: boolean | undefined;
  #lastSnapshotMinute: number | undefined;
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<unknown> = Promise.resolve();
  #isStopped = false;

  constructor(private readonly deps: PriceOracleDeps) {}

  /**
   * Runs one round.
   *
   * @returns The decision it published.
   * @throws Error when publishing or storing the snapshot fails; {@link start} logs and
   *   continues.
   */
  async tick(): Promise<PriceDecision> {
    const { sources, logger } = this.deps;
    // The source list is short and fixed by config (at most four), so polling all at once is
    // bounded.
    const results = await Promise.all(
      sources.map(async (source) => {
        try {
          return { source, price: await source.fetchPrice() };
        } catch (error) {
          return { source, error };
        }
      }),
    );
    const fetchedAt = this.deps.now();
    for (const result of results) {
      if ('price' in result) {
        this.#latest.set(result.source.name, {
          source: result.source.name,
          centsPerBtc: result.price,
          fetchedAt,
        });
      } else {
        logger.warn({ source: result.source.name, err: result.error }, 'price source failed');
      }
    }
    const now = this.deps.now();
    const decision = aggregateQuotes([...this.#latest.values()], now);
    await this.deps.publisher.publish(decision, now);
    await this.#snapshot(decision, now);
    this.#reportTransition(decision);
    return decision;
  }

  /**
   * Polls every `intervalMs`, one round at a time.
   *
   * @param intervalMs Delay between the end of one round and the start of the next.
   */
  start(intervalMs: number): void {
    const loop = (): void => {
      if (this.#isStopped) return;
      this.#inFlight = this.tick()
        .catch((error: unknown) => {
          // Readers see the last published value age out and fail closed on their own.
          this.deps.logger.error(
            { err: error, metric: 'price_oracle.round_failed' },
            'price oracle round failed',
          );
        })
        .finally(() => {
          if (!this.#isStopped) this.#timer = setTimeout(loop, intervalMs);
        });
    };
    loop();
  }

  /** Stops polling and waits for the current round to finish. */
  async stop(): Promise<void> {
    this.#isStopped = true;
    clearTimeout(this.#timer);
    await this.#inFlight;
  }

  async #snapshot(decision: PriceDecision, now: Date): Promise<void> {
    const minute = Math.floor(now.getTime() / MINUTE_MS);
    if (decision.status !== 'usable' || minute === this.#lastSnapshotMinute) return;
    await this.deps.snapshots.insert({
      centsPerBtc: decision.centsPerBtc,
      sources: decision.sources,
      minute: new Date(minute * MINUTE_MS),
    });
    this.#lastSnapshotMinute = minute;
  }

  #reportTransition(decision: PriceDecision): void {
    const isUsable = decision.status === 'usable';
    if (decision.status === 'unusable' && this.#isUsable !== false) {
      this.deps.logger.error(
        {
          metric: 'price_oracle.paused',
          reason: decision.reason,
          freshSources: decision.sources.map((quote) => quote.source),
        },
        'price oracle paused: purchases and payouts fail closed',
      );
    }
    if (isUsable && this.#isUsable === false) {
      this.deps.logger.info({ metric: 'price_oracle.resumed' }, 'price oracle resumed');
    }
    this.#isUsable = isUsable;
  }
}
