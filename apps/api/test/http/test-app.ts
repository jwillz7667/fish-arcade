import { setTimeout as delay } from 'node:timers/promises';

import {
  Body,
  Controller,
  Get,
  Inject,
  Injectable,
  Post,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { apiEnvSchema, parseEnv, type EnvSource } from '@reef/config';
import { createLogger, RequestContext, type Logger } from '@reef/logger';
import type { FastifyRequest } from 'fastify';
import { Redis } from 'ioredis';
import pg from 'pg';
import { inject } from 'vitest';
import { z } from 'zod';

import { createApp } from '../../src/app/create-app.js';
import { LOGGER } from '../../src/app/tokens.js';
import { MoneyRoute } from '../../src/http/idempotency/money-route.decorator.js';
import { RateLimit } from '../../src/http/rate-limit/rate-limit.decorator.js';

/** Test double for the Step 6 auth guard: trusts an `x-test-user` header. Tests only. */
@Injectable()
class TestPrincipalGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const user = request.headers['x-test-user'];
    if (typeof user === 'string') request.principal = { userId: user };
    return true;
  }
}

const echoSchema = z.object({
  amount: z.string().regex(/^\d+$/),
  note: z.string().max(20).optional(),
});

/** Counts handler executions so replay tests can prove the handler ran once. */
export const calls = { echo: 0 };

/** Routes that exercise the HTTP plumbing. Registered only in tests. */
@Controller('test')
@UseGuards(TestPrincipalGuard)
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
  validate(@Body({ schema: echoSchema }) body: z.infer<typeof echoSchema>): {
    ok: true;
    amount: string;
  } {
    return { ok: true, amount: body.amount };
  }

  @Get('boom')
  boom(): never {
    throw new Error(
      'connection to db-internal.prod:5432 refused at Pool.connect (/srv/app/pool.js:42)',
    );
  }

  @Get('limited')
  @RateLimit({ limit: 2, windowSeconds: 60 })
  limited(): { ok: true } {
    return { ok: true };
  }

  @Get('slow')
  async slow(): Promise<{ ok: true }> {
    await delay(400);
    return { ok: true };
  }

  @Get('log')
  log(): { ok: true } {
    this.logger.info('inside handler');
    return { ok: true };
  }
}

/** A built app plus the log lines it wrote. */
export interface TestApp {
  readonly app: NestFastifyApplication;
  readonly logs: Record<string, unknown>[];
  readonly redis: Redis;
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
    ...overrides,
  };
}

/**
 * Builds the real app over a real pool and Redis, with the test controller added.
 *
 * @param env Raw env, validated with the production schema.
 * @param redisUrl Override to point Redis somewhere unreachable.
 */
export async function buildTestApp(
  env: EnvSource = testEnv(),
  redisUrl?: string,
): Promise<TestApp> {
  const parsed = parseEnv(apiEnvSchema, env);
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
    controllers: [TestController],
  });
  return { app, logs, redis };
}
