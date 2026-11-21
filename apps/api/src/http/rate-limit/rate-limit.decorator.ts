import { SetMetadata } from '@nestjs/common';

/** Who a per-route limit counts against. */
export type RateLimitSubject = 'ip' | 'principal';

/** A per-route limit, applied on top of the global per-IP limit. */
export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
  /** Defaults to `ip`. `principal` falls back to IP for unauthenticated calls. */
  readonly by?: RateLimitSubject;
}

/** Metadata key for {@link RateLimit}. */
export const RATE_LIMIT_RULE = 'reef:rate-limit';
/** Metadata key for {@link SkipRateLimit}. */
export const SKIP_RATE_LIMIT = 'reef:skip-rate-limit';

/**
 * Adds a per-route limit, e.g. `@RateLimit({ limit: 5, windowSeconds: 60 })` on login. On a
 * controller it applies to every route without its own rule.
 *
 * @param rule Limit, window, and subject.
 * @returns A method or class decorator.
 */
export const RateLimit = (rule: RateLimitRule): MethodDecorator & ClassDecorator =>
  SetMetadata(RATE_LIMIT_RULE, rule);

/**
 * Exempts a route from rate limiting entirely. Health probes only.
 *
 * @returns A method decorator.
 */
export const SkipRateLimit = (): MethodDecorator => SetMetadata(SKIP_RATE_LIMIT, true);
