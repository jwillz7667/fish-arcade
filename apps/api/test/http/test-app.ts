import { setTimeout as delay } from 'node:timers/promises';

import { randomUUID } from 'node:crypto';

import { Body, Controller, Get, Inject, Post, Req } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { apiEnvSchema, parseEnv, type ApiEnv, type EnvSource } from '@reef/config';
import { ConflictError } from '@reef/errors';
import { createLogger, RequestContext, type Logger } from '@reef/logger';
import type { FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { inject } from 'vitest';
import { z } from 'zod';

import { AdminController, RequirePermission } from '../../src/admin/http/admin-decorators.js';
import { createApp } from '../../src/app/create-app.js';
import { LOGGER } from '../../src/app/tokens.js';
import { Public } from '../../src/auth/guards/public.decorator.js';
import { RequireStepUp } from '../../src/auth/step-up/step-up.guard.js';
import {
  DevStubGeoProvider,
  DevStubKycProvider,
  RequireJurisdiction,
  RequireKyc,
  RequireRedemptionEligibility,
} from '../../src/compliance/index.js';
import { AccessTokenService } from '../../src/auth/tokens/access-token-service.js';
import { MoneyRoute } from '../../src/http/idempotency/money-route.decorator.js';
import { RateLimit } from '../../src/http/rate-limit/rate-limit.decorator.js';
import { createTestAuth, type TestAuth } from '../support/test-auth.js';

const echoSchema = z.object({
  amount: z.string().regex(/^\d+$/),
  note: z.string().max(20).optional(),
});

/** Counts handler executions so replay tests can prove the handler ran once. */
export const calls = { echo: 0 };

/** Routes that exercise the HTTP plumbing. Registered only in tests. */
@Controller('test')
export class TestController {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  @Post('echo')
  @MoneyRoute()
  async echo(
    @Body({ schema: echoSchema }) body: z.infer<typeof echoSchema>,
  ): Promise<{ amount: string; call: number }> {
    calls.echo += 1;
    const call = calls.echo;
    await delay(150);
    return { amount: body.amount, call };
  }

  @Post('validate')
  @Public()
  validate(@Body({ schema: echoSchema }) body: z.infer<typeof echoSchema>): {
    ok: true;
    amount: string;
  } {
    return { ok: true, amount: body.amount };
  }

  @Get('boom')
  @Public()
  boom(): never {
    throw new Error(
      'connection to db-internal.prod:5432 refused at Pool.connect (/srv/app/pool.js:42)',
    );
  }

  @Get('limited')
  @Public()
  @RateLimit({ limit: 2, windowSeconds: 60 })
  limited(): { ok: true } {
    return { ok: true };
  }

  @Get('slow')
  @Public()
  async slow(): Promise<{ ok: true }> {
    await delay(400);
    return { ok: true };
  }

  @Get('log')
  @Public()
  log(): { ok: true } {
    this.logger.info('inside handler');
    return { ok: true };
  }

  /** Authenticated, no step-up: for CSRF tests. */
  @Post('write')
  write(): { ok: true } {
    return { ok: true };
  }

  /** Stand-ins for KYC-gated routes of later steps. */
  @Post('kyc-light')
  @RequireKyc('light')
  kycLight(): { ok: true } {
    return { ok: true };
  }

  @Post('redemption')
  @RequireRedemptionEligibility()
  redemption(): { ok: true } {
    return { ok: true };
  }

  /** Stand-ins for the purchase, SC play, and redemption routes of later steps. */
  @Post('purchase')
  @RequireJurisdiction('purchase')
  purchase(): { ok: true } {
    return { ok: true };
  }

  @Post('play-sc')
  @RequireJurisdiction('play_sc')
  playSc(): { ok: true } {
    return { ok: true };
  }

  @Post('redeem')
  @RequireJurisdiction('redeem')
  redeem(): { ok: true } {
    return { ok: true };
  }

  /** Stands in for payout-address and redemption routes until Steps 14 and 15. */
  @Post('sensitive')
  @RequireStepUp()
  sensitive(): { ok: true } {
    return { ok: true };
  }
}

/** Admin routes that exercise the back office plumbing. Registered only in tests. */
@AdminController('test')
export class TestAdminController {
  /** Declares no permission: the admin guard must refuse it. */
  @Post('undeclared')
  undeclared(): { ok: true } {
    return { ok: true };
  }

  /** A write that fails after the guard, so the interceptor records the failure. */
  @Post('fail')
  @RequirePermission('players.write')
  fail(): never {
    throw new ConflictError({ message: 'test failure' });
  }

  /** A write that describes its change for the audit interceptor. */
  @Post('write')
  @RequirePermission('players.write')
  write(@Req() request: FastifyRequest): { ok: true } {
    request.adminAudit = {
      action: 'admin.test.write',
      targetType: 'player',
      targetId: 'p-1',
      before: { displayName: 'Old', email: 'old@example.com', status: 'active' },
      after: { displayName: 'New', email: 'new@example.com', status: 'active' },
    };
    return { ok: true };
  }
}

/** A built app plus the log lines it wrote and its auth doubles. */
export interface TestApp {
  readonly app: NestFastifyApplication;
  readonly logs: Record<string, unknown>[];
  readonly redis: Redis;
  readonly auth: TestAuth;
  /** The dev KYC vendor, for scripting outcomes and signed webhooks. */
  readonly kyc: DevStubKycProvider;
  /** An `Authorization` header for a fresh access token, for routes that only need a principal. */
  bearerFor(userId: string): Promise<string>;
}

/** Env for tests; override any variable per test. */
export function testEnv(overrides: EnvSource = {}): EnvSource {
  return {
    NODE_ENV: 'test',
    LOG_LEVEL: 'info',
    API_PORT: '4000',
    DATABASE_URL: inject('databaseUrls').reef_app,
    REDIS_URL: inject('redisUrl'),
    FIELD_ENCRYPTION_PROVIDER: 'local',
    FIELD_ENCRYPTION_LOCAL_KEY_FILE: 'unused-in-http-tests',
    BLIND_INDEX_KEY_FILE: 'unused-in-http-tests',
    CORS_ORIGINS: 'http://localhost:3000',
    RATE_LIMIT_PER_MINUTE: '10000',
    AUTH_JWT_KEY_ID: 'test-1',
    WEBAUTHN_RP_ID: 'localhost',
    WEBAUTHN_ORIGINS: 'http://localhost:3000',
    TURNSTILE_SECRET_KEY: '1x0000000000000000000000000000000AA',
    EMAIL_PROVIDER: 'mailpit',
    SMS_PROVIDER: 'mailpit',
    GEO_PROVIDER: 'dev_stub',
    KYC_PROVIDER: 'dev_stub',
    KYC_WEBHOOK_SECRET: 'test-kyc-webhook-secret-0123456789abcdef',
    ADMIN_LOGIN_MODE: 'dev_local',
    ADMIN_ALLOWED_EMAIL_DOMAINS: 'reef.test',
    ADMIN_WEB_ORIGIN: 'http://localhost:3001',
    // Test clients come from random 10.x addresses (see nextIp).
    ADMIN_IP_ALLOWLIST: '10.0.0.0/8,127.0.0.1/32',
    // Short, so the provider-timeout test finishes quickly.
    GEO_PROVIDER_TIMEOUT_MS: '300',
    ...overrides,
  };
}

/**
 * Builds the real app over a real pool and Redis, with the test controller added.
 *
 * @param env Raw env, validated with the production schema.
 * @param redisUrl Override to point Redis somewhere unreachable.
 * @param overrides Applied after validation, e.g. NODE_ENV=production, which the schema
 *   cannot accept yet because no production messaging provider exists.
 */
export async function buildTestApp(
  env: EnvSource = testEnv(),
  redisUrl?: string,
  overrides: Partial<ApiEnv> = {},
): Promise<TestApp> {
  const parsed: ApiEnv = { ...parseEnv(apiEnvSchema, env), ...overrides };
  const auth = createTestAuth();
  const logs: Record<string, unknown>[] = [];
  const requestContext = new RequestContext();
  const logger = createLogger({
    service: 'api',
    level: 'info',
    context: requestContext,
    destination: {
      write: (line: string) => logs.push(JSON.parse(line) as Record<string, unknown>),
    },
  });
  const redis = new Redis(redisUrl ?? parsed.REDIS_URL, {
    maxRetriesPerRequest: 0,
    enableOfflineQueue: redisUrl === undefined,
    retryStrategy: () => null,
    lazyConnect: redisUrl !== undefined,
  });
  // Unreachable-Redis tests expect connection errors; readiness and the limiter report them.
  redis.on('error', () => undefined);
  const pool = new pg.Pool({ connectionString: parsed.DATABASE_URL, max: 5 });
  const kyc = new DevStubKycProvider(redis, parsed.KYC_WEBHOOK_SECRET);
  const app = await createApp({
    env: parsed,
    pool,
    redis,
    logger,
    requestContext,
    auth: auth.deps,
    geoProvider: new DevStubGeoProvider(),
    kycProvider: kyc,
    controllers: [TestController, TestAdminController],
  });
  const accessTokens = app.get(AccessTokenService);
  return {
    app,
    logs,
    redis,
    auth,
    kyc,
    bearerFor: async (userId) => {
      const { token } = await accessTokens.sign({
        userId,
        sessionId: randomUUID(),
        authTime: auth.clock.now(),
        amr: ['pwd'],
      });
      return `Bearer ${token}`;
    },
  };
}
