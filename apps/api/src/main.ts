import { apiEnvSchema, loadEnv } from '@reef/config';
import { createLogger, RequestContext } from '@reef/logger';
import { Redis } from 'ioredis';
import pg from 'pg';

import { createApp } from './app/create-app.js';

const env = loadEnv(apiEnvSchema);
const requestContext = new RequestContext();
const logger = createLogger({ service: 'api', level: env.LOG_LEVEL, context: requestContext });
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 20 });
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
// Connection errors surface as failed commands (and fail closed); log them once here.
redis.on('error', (error: Error) => {
  logger.warn({ err: error }, 'redis connection error');
});

const app = await createApp({ env, pool, redis, logger, requestContext });

let isShuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'shutting down: draining requests');
  // If draining hangs, exit anyway so the orchestrator can replace the task.
  const force = setTimeout(() => {
    logger.error({ timeoutMs: env.SHUTDOWN_TIMEOUT_MS }, 'shutdown timed out');
    process.exit(1);
  }, env.SHUTDOWN_TIMEOUT_MS);
  force.unref();
  await app.close();
  logger.info('shutdown complete');
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}

await app.listen({ port: env.API_PORT, host: env.API_HOST });
logger.info({ port: env.API_PORT }, 'api listening');
