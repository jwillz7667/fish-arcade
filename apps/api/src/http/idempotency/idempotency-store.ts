import { randomBytes, timingSafeEqual } from 'node:crypto';

import { ConflictError, DependencyUnavailableError, ErrorCode } from '@reef/errors';
import type { Redis } from 'ioredis';
import { z } from 'zod';

/** Playbook Step 5: responses are kept for 24 hours. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

/**
 * A claim on a key expires after this long unless the running request renews it. A request
 * that dies mid-flight (crash, OOM, forced shutdown) blocks retries for at most this long,
 * not for the full 24 hours.
 */
export const PENDING_LEASE_SECONDS = 30;

const recordSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending'), requestHash: z.string(), claim: z.string() }),
  z.object({ state: z.literal('done'), requestHash: z.string(), body: z.unknown() }),
]);

// Compare-and-act on the exact pending record, so a request whose lease lapsed can never renew
// or release a claim that a later request now holds.
const RENEW_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('EXPIRE', KEYS[1], ARGV[2]) end return 0`;
const RELEASE_SCRIPT = `if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1]) end return 0`;

/** A key this request holds while its handler runs. */
export interface IdempotencyClaim {
  readonly key: string;
  readonly requestHash: string;
  /** The stored pending record, unique to this claim. */
  readonly record: string;
}

/** What to do with an incoming money request. */
export type IdempotencyDecision =
  | { readonly kind: 'execute'; readonly claim: IdempotencyClaim }
  | { readonly kind: 'replay'; readonly body: unknown };

/** The operations the idempotency interceptor needs. */
export interface IdempotencyClaims {
  begin(scope: string, requestHash: string): Promise<IdempotencyDecision>;
  renew(claim: IdempotencyClaim): Promise<void>;
  complete(claim: IdempotencyClaim, body: unknown): Promise<void>;
  release(claim: IdempotencyClaim): Promise<void>;
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

async function guard<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw new DependencyUnavailableError({ dependency: 'redis', cause: error });
  }
}

/**
 * Stored responses for `@MoneyRoute` requests, per caller and key. The first request claims the
 * key atomically (SET NX) with a short lease that it renews while running; concurrent
 * duplicates are rejected meanwhile; later retries replay its response for 24 hours. Redis
 * failures fail closed.
 */
export class IdempotencyStore implements IdempotencyClaims {
  constructor(private readonly redis: Redis) {}

  /**
   * @param scope `{actor}:{key}`.
   * @param requestHash Hash of method, path, and canonical body.
   * @returns A claim to run the handler under, or a stored response to replay.
   * @throws ConflictError (IDEMPOTENCY_CONFLICT) when the key was used for a different request.
   * @throws ConflictError (CONFLICT) while the first request with this key is still running.
   * @throws DependencyUnavailableError when Redis fails.
   */
  async begin(scope: string, requestHash: string): Promise<IdempotencyDecision> {
    const key = `idem:v2:${scope}`;
    const record = JSON.stringify({
      state: 'pending',
      requestHash,
      claim: randomBytes(16).toString('hex'),
    });
    const claimed = await guard(() =>
      this.redis.set(key, record, 'EX', PENDING_LEASE_SECONDS, 'NX'),
    );
    if (claimed === 'OK') return { kind: 'execute', claim: { key, requestHash, record } };

    const stored = await guard(() => this.redis.get(key));
    // The key expired between SET and GET: the earlier request is gone, so this one may run.
    if (stored === null) return this.begin(scope, requestHash);
    const existing = recordSchema.parse(JSON.parse(stored));
    if (!sameHash(existing.requestHash, requestHash)) {
      throw new ConflictError({ code: ErrorCode.IDEMPOTENCY_CONFLICT });
    }
    if (existing.state === 'pending') {
      throw new ConflictError({
        safeMessage: 'A request with this idempotency key is still in progress.',
      });
    }
    return { kind: 'replay', body: existing.body };
  }

  /**
   * Extends the lease of a claim that is still held.
   *
   * @param claim From {@link begin}.
   * @throws DependencyUnavailableError when Redis fails.
   */
  async renew(claim: IdempotencyClaim): Promise<void> {
    await guard(() =>
      this.redis.eval(RENEW_SCRIPT, 1, claim.key, claim.record, String(PENDING_LEASE_SECONDS)),
    );
  }

  /**
   * Stores the response body for replay for 24 hours.
   *
   * @param claim From {@link begin}.
   * @param body The handler's response.
   * @throws DependencyUnavailableError when Redis fails.
   */
  async complete(claim: IdempotencyClaim, body: unknown): Promise<void> {
    const record = JSON.stringify({ state: 'done', requestHash: claim.requestHash, body });
    await guard(() => this.redis.set(claim.key, record, 'EX', IDEMPOTENCY_TTL_SECONDS));
  }

  /**
   * Gives up a claim that is still held, so the client can retry at once. Used only when the
   * handler failed in a way that moved no money.
   *
   * @param claim From {@link begin}.
   * @throws DependencyUnavailableError when Redis fails.
   */
  async release(claim: IdempotencyClaim): Promise<void> {
    await guard(() => this.redis.eval(RELEASE_SCRIPT, 1, claim.key, claim.record));
  }
}
