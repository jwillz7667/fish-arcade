import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { ApiEnv } from '@reef/config';
import type { Logger } from '@reef/logger';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { HealthController } from '../health/health.controller.js';
import { DomainExceptionFilter } from '../http/domain-exception.filter.js';
import { IdempotencyInterceptor } from '../http/idempotency/idempotency.interceptor.js';
import { IdempotencyStore } from '../http/idempotency/idempotency-store.js';
import { RateLimitGuard } from '../http/rate-limit/rate-limit.guard.js';
import { RedisRateLimiter } from '../http/rate-limit/redis-rate-limiter.js';
import { ResourceLifecycle } from './resource-lifecycle.js';
import { API_ENV, LOGGER, PG_POOL, REDIS } from './tokens.js';

/** Process-level resources the API is built from. The caller creates and owns them. */
export interface AppDependencies {
  readonly env: ApiEnv;
  readonly pool: Pool;
  readonly redis: Redis;
  readonly logger: Logger;
  /** Extra controllers, for feature modules added in later steps and for tests. */
  readonly controllers?: readonly Type[];
}

/** Root module. Built with {@link AppModule.register} so every dependency is explicit. */
@Module({})
export class AppModule {
  /**
   * @param deps Resources to inject.
   * @returns The configured root module.
   */
  static register(deps: AppDependencies): DynamicModule {
    return {
      module: AppModule,
      controllers: [HealthController, ...(deps.controllers ?? [])],
      providers: [
        { provide: API_ENV, useValue: deps.env },
        { provide: PG_POOL, useValue: deps.pool },
        { provide: REDIS, useValue: deps.redis },
        { provide: LOGGER, useValue: deps.logger },
        { provide: RedisRateLimiter, useFactory: () => new RedisRateLimiter(deps.redis) },
        { provide: IdempotencyStore, useFactory: () => new IdempotencyStore(deps.redis) },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
        ResourceLifecycle,
      ],
    };
  }
}
