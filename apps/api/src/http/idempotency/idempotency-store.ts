import { timingSafeEqual } from 'node:crypto';

import { ConflictError, DependencyUnavailableError, ErrorCode } from '@reef/errors';
import type { Redis } from 'ioredis';
import { z } from 'zod';

/** Playbook Step 5: responses are kept for 24 hours. */
export const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60;

const recordSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('pending'), requestHash: z.string() }),
  z.object({ state: z.literal('done'), requestHash: z.string(), body: z.unknown() }),
]);

/** What to do with an incoming money request. */
export type IdempotencyDecision =
  { readonly kind: 'execute' } | { readonly kind: 'replay'; readonly body: unknown };

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
 * key atomically (SET NX); concurrent duplicates are rejected while it runs; later retries
 * replay its response. Redis failures fail closed.
 */
export class IdempotencyStore {
  constructor(private readonly redis: Redis) {}

  /**
   * @param scope `{userId}:{key}`.
   * @param requestHash Hash of method, path, and canonical body.
   * @returns Whether to run the handler or replay a stored response.
   * @throws ConflictError (IDEMPOTENCY_CONFLICT) when the key was used for a different request.
   * @throws ConflictError (CONFLICT) while the first request with this key is still running.
   * @throws DependencyUnavailableError when Redis fails.
   */
  async begin(scope: string, requestHash: string): Promise<IdempotencyDecision> {
    const key = this.#key(scope);
    const pending = JSON.stringify({ state: 'pending', requestHash });
    const claimed = await guard(() =>
      this.redis.set(key, pending, 'EX', IDEMPOTENCY_TTL_SECONDS, 'NX'),
    );
    if (claimed === 'OK') return { kind: 'execute' };

    const stored = await guard(() => this.redis.get(key));
    // The key expired between SET and GET: the earlier request is gone, so this one may run.
    if (stored === null) return this.begin(scope, requestHash);
    const record = recordSchema.parse(JSON.parse(stored));
    if (!sameHash(record.requestHash, requestHash)) {
      throw new ConflictError({ code: ErrorCode.IDEMPOTENCY_CONFLICT });
    }
    if (record.state === 'pending') {
      throw new ConflictError({
        safeMessage: 'A request with this idempotency key is still in progress.',
      });
    }
    return { kind: 'replay', body: record.body };
  }

  /** Stores the response body for replay. @param scope As for begin. */
  async complete(scope: string, requestHash: string, body: unknown): Promise<void> {
    const record = JSON.stringify({ state: 'done', requestHash, body });
    await guard(() => this.redis.set(this.#key(scope), record, 'EX', IDEMPOTENCY_TTL_SECONDS));
  }

  /** Releases a claimed key after a failure, so the client can retry. @param scope As for begin. */
  async abandon(scope: string): Promise<void> {
    await guard(() => this.redis.del(this.#key(scope)));
  }

  #key(scope: string): string {
    return `idem:v1:${scope}`;
  }
}
