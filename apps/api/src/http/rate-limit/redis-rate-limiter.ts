import { DependencyUnavailableError } from '@reef/errors';
import type { Redis } from 'ioredis';

/** Outcome of one counted request. */
export interface RateLimitResult {
  readonly allowed: boolean;
  /** Milliseconds until the current window resets. */
  readonly resetMs: number;
}

// Atomic fixed window: increment, start the window on the first hit, report the TTL.
const HIT_SCRIPT = `
local count = redis.call('INCR', KEYS[1])
if count == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {count, redis.call('PTTL', KEYS[1])}
`;

/** Fixed-window counters in Redis, shared by every API instance. */
export class RedisRateLimiter {
  constructor(private readonly redis: Redis) {}

  /**
   * Counts one request against `key`.
   *
   * @param key Counter key, already namespaced by the caller.
   * @param limit Requests allowed per window.
   * @param windowMs Window length.
   * @returns Whether the request is allowed and when the window resets.
   * @throws DependencyUnavailableError when Redis fails; callers fail closed.
   */
  async hit(key: string, limit: number, windowMs: number): Promise<RateLimitResult> {
    let reply: unknown;
    try {
      reply = await this.redis.eval(HIT_SCRIPT, 1, key, String(windowMs));
    } catch (error) {
      throw new DependencyUnavailableError({ dependency: 'redis', cause: error });
    }
    if (!Array.isArray(reply) || typeof reply[0] !== 'number' || typeof reply[1] !== 'number') {
      throw new DependencyUnavailableError({
        dependency: 'redis',
        message: 'Unexpected rate limit reply',
      });
    }
    return { allowed: reply[0] <= limit, resetMs: Math.max(reply[1], 0) };
  }
}
