import { randomUUID } from 'node:crypto';

import { Redis } from 'ioredis';
import { afterAll, describe, expect, inject, it } from 'vitest';

import {
  IDEMPOTENCY_TTL_SECONDS,
  IdempotencyStore,
  PENDING_LEASE_SECONDS,
  type IdempotencyClaim,
} from '../../src/http/idempotency/idempotency-store.js';

const redis = new Redis(inject('redisUrl'));
const store = new IdempotencyStore(redis);
afterAll(async () => {
  await redis.quit();
});

async function claimFor(scope: string): Promise<IdempotencyClaim> {
  const decision = await store.begin(scope, 'ab'.repeat(32));
  if (decision.kind !== 'execute') throw new Error('expected a fresh claim');
  return decision.claim;
}

describe('IdempotencyStore', () => {
  it('claims a key with a short lease, not the 24-hour replay window', async () => {
    const claim = await claimFor(`player:${randomUUID()}:k`);

    const ttl = await redis.ttl(claim.key);

    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(PENDING_LEASE_SECONDS);
  });

  it('lets a retry run once a crashed request lets its lease lapse', async () => {
    const scope = `player:${randomUUID()}:k`;
    const crashed = await claimFor(scope);

    await redis.del(crashed.key); // what the lease expiry does
    const retry = await store.begin(scope, 'ab'.repeat(32));

    expect(retry.kind).toBe('execute');
  });

  it('renews and releases only its own claim', async () => {
    const scope = `player:${randomUUID()}:k`;
    const stale = await claimFor(scope);
    await redis.del(stale.key);
    const current = await claimFor(scope);

    await store.release(stale);
    await store.renew(stale);

    expect(await redis.get(current.key)).toBe(current.record);
    expect(await redis.ttl(current.key)).toBeLessThanOrEqual(PENDING_LEASE_SECONDS);
  });

  it('keeps a completed response for 24 hours and replays it', async () => {
    const scope = `player:${randomUUID()}:k`;
    const claim = await claimFor(scope);

    await store.complete(claim, { ok: true });
    const replay = await store.begin(scope, 'ab'.repeat(32));

    expect(replay).toEqual({ kind: 'replay', body: { ok: true } });
    expect(await redis.ttl(claim.key)).toBeGreaterThan(IDEMPOTENCY_TTL_SECONDS - 60);
  });
});
