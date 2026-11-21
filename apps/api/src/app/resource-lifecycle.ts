import { Inject, Injectable, type OnApplicationShutdown } from '@nestjs/common';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import { PG_POOL, REDIS } from './tokens.js';

/** Closes the pool and Redis once Fastify has drained in-flight requests. */
@Injectable()
export class ResourceLifecycle implements OnApplicationShutdown {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Called by Nest after the HTTP server has closed. */
  async onApplicationShutdown(): Promise<void> {
    await Promise.allSettled([this.pool.end(), this.redis.quit()]);
  }
}
