import { Module, type DynamicModule, type Type } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import type { ApiEnv } from '@reef/config';
import type { Logger } from '@reef/logger';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import {
  AUTH_CONTROLLERS,
  AuthGuard,
  createAuthProviders,
  type AuthDependencies,
} from '../auth/index.js';
import { ADMIN_CONTROLLERS, createAdminProviders } from '../admin/index.js';
import { AuditWriter } from '../audit/audit-writer.js';
import { LegalController } from '../legal/index.js';
import {
  COMPLIANCE_CONTROLLERS,
  createComplianceServices,
  type GeoProvider,
  type KycProvider,
} from '../compliance/index.js';
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
  /** Keys and third-party providers for player auth. */
  readonly auth: AuthDependencies;
  /** Where devices are, for the jurisdiction gate. */
  readonly geoProvider: GeoProvider;
  /** Identity verification vendor. */
  readonly kycProvider: KycProvider;
  /** fetch for the admin OIDC client; tests point it at a fake IdP. */
  readonly oidcFetch?: typeof fetch;
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
    const audit = new AuditWriter(deps.pool);
    const compliance = createComplianceServices({
      ...deps,
      audit,
      clock: deps.auth.clock,
      hmacKey: deps.auth.keys.hmacKey,
    });
    return {
      module: AppModule,
      controllers: [
        HealthController,
        ...AUTH_CONTROLLERS,
        ...COMPLIANCE_CONTROLLERS,
        ...ADMIN_CONTROLLERS,
        LegalController,
        ...(deps.controllers ?? []),
      ],
      providers: [
        { provide: API_ENV, useValue: deps.env },
        { provide: PG_POOL, useValue: deps.pool },
        { provide: REDIS, useValue: deps.redis },
        { provide: LOGGER, useValue: deps.logger },
        { provide: RedisRateLimiter, useFactory: () => new RedisRateLimiter(deps.redis) },
        { provide: IdempotencyStore, useFactory: () => new IdempotencyStore(deps.redis) },
        { provide: AuditWriter, useValue: audit },
        ...compliance.providers,
        ...createAdminProviders({
          ...deps,
          audit,
          clock: deps.auth.clock,
          hmacKey: deps.auth.keys.hmacKey,
          encryption: deps.auth.encryption,
        }),
        ...createAuthProviders({ ...deps, audit, jurisdictions: compliance.jurisdictions }),
        // Guards run in this order: authenticate first, so per-principal limits see the user.
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
        { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
        { provide: APP_FILTER, useClass: DomainExceptionFilter },
        ResourceLifecycle,
      ],
    };
  }
}
