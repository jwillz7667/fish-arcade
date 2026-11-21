import { formatConfigError, loadEnv, workersEnvSchema } from '@reef/config';
import { ConfigError } from '@reef/errors';
import { createLogger, RequestContext } from '@reef/logger';
import { Redis } from 'ioredis';
import pg from 'pg';

import { downloadSdnList, OfacImporter, OfacImportJob } from './ofac/index.js';
import { createPriceOracle } from './price-oracle/index.js';

const env = loadEnv(workersEnvSchema);
const logger = createLogger({
  service: 'workers',
  level: env.LOG_LEVEL,
  context: new RequestContext(),
});
const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 5 });
// An idle client that loses its connection emits here; without a listener Node would exit.
pool.on('error', (error: Error) => {
  logger.error({ err: error }, 'postgres idle client error');
});
const redis = new Redis(env.REDIS_URL, { maxRetriesPerRequest: 2, enableOfflineQueue: false });
redis.on('error', (error: Error) => {
  logger.warn({ err: error }, 'redis connection error');
});

let oracle: ReturnType<typeof createPriceOracle>;
try {
  oracle = createPriceOracle({ env, redis, pool, logger });
} catch (error) {
  if (!(error instanceof ConfigError)) throw error;
  process.stderr.write(formatConfigError(error));
  process.exit(1);
}
oracle.start(env.PRICE_POLL_INTERVAL_MS);
logger.info(
  { sources: env.PRICE_SOURCES, intervalMs: env.PRICE_POLL_INTERVAL_MS },
  'price oracle started',
);

const ofacImport = new OfacImportJob({
  download: () => downloadSdnList(env.OFAC_SDN_URL),
  importer: new OfacImporter(pool),
  logger,
});
ofacImport.start(env.OFAC_IMPORT_INTERVAL_HOURS * 3_600_000);

let isShuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'workers shutting down');
  await Promise.allSettled([oracle.stop(), ofacImport.stop()]);
  await Promise.allSettled([redis.quit(), pool.end()]);
  logger.info('workers stopped');
}

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.once(signal, () => {
    void shutdown(signal);
  });
}
