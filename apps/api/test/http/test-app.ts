import { setTimeout as delay } from 'node:timers/promises';

import { randomUUID } from 'node:crypto';

import { Body, Controller, Get, Inject, Post } from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { apiEnvSchema, parseEnv, type ApiEnv, type EnvSource } from '@reef/config';
import { createLogger, RequestContext, type Logger } from '@reef/logger';
import { Redis } from 'ioredis';
import pg from 'pg';
import { inject } from 'vitest';
import { z } from 'zod';

import { createApp } from '../../src/app/create-app.js';
import { LOGGER } from '../../src/app/tokens.js';
import { Public } from '../../src/auth/guards/public.decorator.js';
import { RequireStepUp } from '../../src/auth/step-up/step-up.guard.js';
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

  /** Stands in for payout-address and redemption routes until Steps 14 and 15. */
  @Post('sensitive')
  @RequireStepUp()
  sensitive(): { ok: true } {
    return { ok: true };
  }
}

/** A built app plus the log lines it wrote and its auth doubles. */
export interface TestApp {
  readonly app: NestFastifyApplication;
  readonly logs: Record<string, unknown>[];
  readonly redis: Redis;
  readonly auth: TestAuth;
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
  const app = await createApp({
    env: parsed,
    pool,
    redis,
    logger,
    requestContext,
    auth: auth.deps,
    controllers: [TestController],
  });
  const accessTokens = app.get(AccessTokenService);
  return {
    app,
    logs,
    redis,
    auth,
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
