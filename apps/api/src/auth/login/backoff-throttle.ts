import { RateLimitedError } from '@reef/errors';
import type { Redis } from 'ioredis';

import { ACCOUNT_BACKOFF, backoffDelayMs, IP_BACKOFF, type BackoffPolicy } from '../auth-policy.js';

/** Something failures are counted against: an account identifier, an IP, or a user. */
export interface ThrottleSubject {
  /** Redis key suffix. Built from blind indexes or IDs, never raw emails or numbers. */
  readonly key: string;
  readonly policy: BackoffPolicy;
}

/**
 * @param contactBidx Blind index of the identifier typed at login, whether or not an account
 *   uses it, so unknown and real accounts are throttled the same way.
 * @returns The per-account subject.
 */
export const accountSubject = (contactBidx: string): ThrottleSubject => ({
  key: `acct:${contactBidx}`,
  policy: ACCOUNT_BACKOFF,
});

/**
 * @param ip Client IP.
 * @returns The per-IP subject.
 */
export const ipSubject = (ip: string): ThrottleSubject => ({ key: `ip:${ip}`, policy: IP_BACKOFF });

/**
 * @param userId User entering a step-up or MFA code.
 * @returns The per-user second-factor subject.
 */
export const secondFactorSubject = (userId: string): ThrottleSubject => ({
  key: `2fa:${userId}`,
  policy: ACCOUNT_BACKOFF,
});

const countKey = (subject: ThrottleSubject): string => `auth:v1:fail:${subject.key}`;
const lockKey = (subject: ThrottleSubject): string => `auth:v1:lock:${subject.key}`;

/**
 * Exponential backoff after repeated failures (playbook Step 6): each failure past the free
 * allowance doubles the wait before the next attempt, up to a cap. State lives in Redis so it
 * holds across API instances. Fails closed: Redis errors propagate as 503.
 */
export class BackoffThrottle {
  constructor(private readonly redis: Redis) {}

  /**
   * @param subjects Everything this attempt is counted against.
   * @throws RateLimitedError with the longest remaining wait when any subject is locked.
   */
  async assertAllowed(subjects: readonly ThrottleSubject[]): Promise<void> {
    const remaining = await Promise.all(
      subjects.map((subject) => this.redis.pttl(lockKey(subject))),
    );
    const waitMs = Math.max(0, ...remaining);
    if (waitMs > 0) {
      throw new RateLimitedError({ retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) });
    }
  }

  /**
   * Counts a failure against every subject and locks those past their allowance.
   *
   * @param subjects Everything the failed attempt is counted against.
   */
  async recordFailure(subjects: readonly ThrottleSubject[]): Promise<void> {
    await Promise.all(
      subjects.map(async (subject) => {
        const results = await this.redis
          .multi()
          .incr(countKey(subject))
          .pexpire(countKey(subject), subject.policy.windowMs)
          .exec();
        const [error, count] = results?.[0] ?? [new Error('Redis MULTI aborted'), null];
        // Fail closed: an uncounted failure must not turn into an unthrottled attempt.
        if (error !== null || typeof count !== 'number') throw error ?? new Error('Bad INCR reply');
        const delayMs = backoffDelayMs(count, subject.policy);
        if (delayMs > 0) await this.redis.set(lockKey(subject), '1', 'PX', delayMs);
      }),
    );
  }

  /**
   * Clears a subject's failures, after a successful login or code.
   *
   * @param subject Subject to clear.
   */
  async reset(subject: ThrottleSubject): Promise<void> {
    await this.redis.del(countKey(subject), lockKey(subject));
  }
}
