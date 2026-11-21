import { apiEnvSchema, formatConfigError, loadEnv } from '@reef/config';
import { ConfigError } from '@reef/errors';
import { createLogger, RequestContext } from '@reef/logger';
import { Redis } from 'ioredis';
import pg from 'pg';

import { createApp } from './app/create-app.js';
import { createAuthDependencies } from './auth/index.js';
import {
  createChainRiskProvider,
  createGeoProvider,
  createKycProvider,
} from './compliance/index.js';

const env = loadEnv(apiEnvSchema);
const requestContext = new RequestContext();
const logger = createLogger({ service: 'api', level: env.LOG_LEVEL, context: requestContext });
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 20 });
// An idle client that loses its connection (an RDS failover, say) emits here, and with no
// listener Node would exit. pg drops that client; queries already running fail on their own.
pool.on('error', (error: Error) => {
  logger.error({ err: error }, 'postgres idle client error');
});
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
// Connection errors surface as failed commands (and fail closed); log them once here.
redis.on('error', (error: Error) => {
  logger.warn({ err: error }, 'redis connection error');
});

const auth = await createAuthDependencies(env).catch((error: unknown) => {
  if (!(error instanceof ConfigError)) throw error;
  // Names the bad setting only; key material never reaches the output.
  process.stderr.write(formatConfigError(error));
  process.exit(1);
});
let chainRiskProvider: ReturnType<typeof createChainRiskProvider>;
try {
  chainRiskProvider = createChainRiskProvider(env, redis);
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(formatConfigError(error));
  process.exit(1);
}
const app = await createApp({
  env,
  pool,
  redis,
  logger,
  requestContext,
  auth,
  geoProvider: createGeoProvider(env),
  kycProvider: createKycProvider(env, redis),
  chainRiskProvider,
});

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
