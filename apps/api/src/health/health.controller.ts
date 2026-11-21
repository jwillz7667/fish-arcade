import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { PG_POOL, REDIS } from '../app/tokens.js';
import { Public } from '../auth/index.js';
import { SkipRateLimit } from '../http/rate-limit/rate-limit.decorator.js';

/** Health of one dependency. */
export type CheckStatus = 'up' | 'down';

const CHECK_TIMEOUT_MS = 1_000;

async function probe(check: () => Promise<unknown>): Promise<CheckStatus> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error('timeout'));
    }, CHECK_TIMEOUT_MS);
  });
  try {
    await Promise.race([check(), timeout]);
    return 'up';
  } catch {
    // A failed probe is the answer, not an error to propagate.
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}

/** Liveness and readiness probes for the load balancer and orchestrator. */
@Controller()
@Public()
export class HealthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Liveness: the process is serving HTTP. Checks no dependencies. */
  @Get('health')
  @SkipRateLimit()
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness: Postgres and Redis both answer within 1 second. Returns 503 otherwise, so the
   * instance is taken out of rotation.
   */
  @Get('ready')
  @SkipRateLimit()
  async ready(
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ status: 'ready' | 'not_ready'; checks: Record<'postgres' | 'redis', CheckStatus> }> {
    const [postgres, redis] = await Promise.all([
      probe(() => this.pool.query('SELECT 1')),
      probe(() => this.redis.ping()),
    ]);
    const isReady = postgres === 'up' && redis === 'up';
    if (!isReady) void reply.status(503);
    return { status: isReady ? 'ready' : 'not_ready', checks: { postgres, redis } };
  }
}
