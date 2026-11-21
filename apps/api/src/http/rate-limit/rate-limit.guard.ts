import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { ApiEnv } from '@reef/config';
import { RateLimitedError } from '@reef/errors';
import type { FastifyRequest } from 'fastify';

import { API_ENV } from '../../app/tokens.js';
import { principalOf } from '../principal.js';
import { RATE_LIMIT_RULE, SKIP_RATE_LIMIT, type RateLimitRule } from './rate-limit.decorator.js';
import { RedisRateLimiter } from './redis-rate-limiter.js';

const MINUTE_MS = 60_000;

/**
 * Global guard: a per-IP limit on every route, plus any `@RateLimit` rule on the route.
 * Fails closed: if Redis is down, requests are refused with 503 rather than served unlimited.
 */
@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(RedisRateLimiter) private readonly limiter: RedisRateLimiter,
    @Inject(API_ENV) private readonly env: ApiEnv,
  ) {}

  /**
   * @param context Current request.
   * @returns True when the request is within every applicable limit.
   * @throws RateLimitedError with a retry delay when a limit is exceeded.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(SKIP_RATE_LIMIT, targets)) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();

    await this.#enforce(`rl:v1:global:ip:${request.ip}`, this.env.RATE_LIMIT_PER_MINUTE, MINUTE_MS);

    const rule = this.reflector.getAllAndOverride<RateLimitRule | undefined>(
      RATE_LIMIT_RULE,
      targets,
    );
    if (rule !== undefined) {
      const principal = rule.by === 'principal' ? principalOf(request) : undefined;
      const subject = principal === undefined ? `ip:${request.ip}` : `user:${principal.userId}`;
      const route = `${context.getClass().name}.${context.getHandler().name}`;
      await this.#enforce(`rl:v1:route:${route}:${subject}`, rule.limit, rule.windowSeconds * 1000);
    }
    return true;
  }

  async #enforce(key: string, limit: number, windowMs: number): Promise<void> {
    const result = await this.limiter.hit(key, limit, windowMs);
    if (!result.allowed) {
      throw new RateLimitedError({
        retryAfterSeconds: Math.max(1, Math.ceil(result.resetMs / 1000)),
      });
    }
  }
}
