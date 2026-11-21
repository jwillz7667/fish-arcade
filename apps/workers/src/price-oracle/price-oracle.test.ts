import { createLogger, RequestContext } from '@reef/logger';
import { centsPerBtc, type CentsPerBtc } from '@reef/money';
import type { PriceDecision, PriceQuote } from '@reef/pricing';
import { describe, expect, it } from 'vitest';

import { PriceOracle } from './price-oracle.js';
import type { PriceSource } from './price-source.js';

/** A source the test controls: a price, or down. */
class FakeSource implements PriceSource {
  price: bigint | undefined;

  constructor(
    readonly name: string,
    price: bigint,
  ) {
    this.price = price;
  }

  fetchPrice(): Promise<CentsPerBtc> {
    return this.price === undefined
      ? Promise.reject(new Error(`${this.name} is down`))
      : Promise.resolve(centsPerBtc(this.price));
  }
}

function setup(prices: readonly bigint[] = [5_000_000n, 5_001_000n, 5_002_000n]) {
  const sources = prices.map((price, index) => new FakeSource(`exchange-${String(index)}`, price));
  let now = new Date('2026-11-21T12:00:10Z');
  const published: PriceDecision[] = [];
  const snapshots: { centsPerBtc: CentsPerBtc; sources: readonly PriceQuote[]; minute: Date }[] =
    [];
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'info',
    context: new RequestContext(),
    destination: {
      write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
    },
  });
  const oracle = new PriceOracle({
    sources,
    publisher: {
      publish: (decision) => {
        published.push(decision);
        return Promise.resolve();
      },
    },
    snapshots: {
      insert: (snapshot) => {
        snapshots.push(snapshot);
        return Promise.resolve();
      },
    },
    now: () => now,
    logger,
  });
  const advance = (ms: number) => {
    now = new Date(now.getTime() + ms);
  };
  const metrics = () =>
    lines.map((line) => line['metric']).filter((metric) => metric !== undefined);
  return { oracle, sources, published, snapshots, advance, metrics, lines };
}

describe('PriceOracle (playbook Step 11)', () => {
  it('publishes the median of every source', async () => {
    const { oracle, published } = setup();

    const decision = await oracle.tick();

    expect(decision).toMatchObject({ status: 'usable', centsPerBtc: 5_001_000n });
    expect(published).toEqual([decision]);
  });

  it('keeps pricing with one source down, from the other two', async () => {
    const { oracle, sources } = setup();
    const [, down] = sources;
    if (down !== undefined) down.price = undefined;

    const decision = await oracle.tick();

    expect(decision).toMatchObject({ status: 'usable', centsPerBtc: 5_001_000n });
    expect(decision.sources.map((quote) => quote.source)).toEqual(['exchange-0', 'exchange-2']);
  });

  it('pauses, and raises the paused metric, when every source is down', async () => {
    const { oracle, sources, metrics } = setup();
    for (const source of sources) source.price = undefined;

    const decision = await oracle.tick();

    expect(decision).toMatchObject({ status: 'unusable', reason: 'too_few_sources' });
    expect(metrics()).toEqual(['price_oracle.paused']);
  });

  it('pauses when sources disagree by more than 1%', async () => {
    const { oracle, sources, metrics } = setup();
    const [, , outlier] = sources;
    if (outlier !== undefined) outlier.price = 5_100_000n;

    expect(await oracle.tick()).toMatchObject({ status: 'unusable', reason: 'sources_diverge' });
    expect(metrics()).toEqual(['price_oracle.paused']);
  });

  it('pauses once quotes go stale: a source down for a minute stops counting', async () => {
    const { oracle, sources, advance } = setup([5_000_000n, 5_001_000n]);
    await oracle.tick();
    const [, down] = sources;
    if (down !== undefined) down.price = undefined;

    advance(30_000);
    const stillFresh = await oracle.tick();
    advance(31_000);
    const stale = await oracle.tick();

    // Its last quote, from 30 s ago, still counts; at 61 s it no longer does.
    expect(stillFresh.status).toBe('usable');
    expect(stale).toMatchObject({ status: 'unusable', reason: 'too_few_sources' });
  });

  it('logs the pause once and the resume once', async () => {
    const { oracle, sources, metrics } = setup();
    for (const source of sources) source.price = undefined;
    await oracle.tick();
    await oracle.tick();

    for (const source of sources) source.price = 5_000_000n;
    await oracle.tick();
    await oracle.tick();

    expect(metrics()).toEqual(['price_oracle.paused', 'price_oracle.resumed']);
  });

  it('stores one snapshot per minute, only for usable prices', async () => {
    const { oracle, snapshots, advance, sources } = setup();
    await oracle.tick();
    advance(15_000);
    await oracle.tick();
    advance(40_000);
    await oracle.tick();
    for (const source of sources) source.price = undefined;
    advance(60_000);
    await oracle.tick();

    expect(snapshots.map((snapshot) => snapshot.minute.toISOString())).toEqual([
      '2026-11-21T12:00:00.000Z',
      '2026-11-21T12:01:00.000Z',
    ]);
  });
});
