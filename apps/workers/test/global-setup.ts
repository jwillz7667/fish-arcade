import { createTestDatabase, type TestDatabaseUrls } from '@reef/db/testing';
import { ConfigError } from '@reef/errors';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    workersDatabaseUrls: TestDatabaseUrls;
    workersRedisUrl: string;
  }
}

/** Provides a freshly migrated disposable database and a Redis URL to every test file. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const redisUrl = process.env['TEST_REDIS_URL'];
  if (redisUrl === undefined) {
    throw new ConfigError({
      issues: [{ path: 'TEST_REDIS_URL', message: 'set it to a disposable Redis database URL' }],
    });
  }
  const database = await createTestDatabase(process.env['TEST_DATABASE_ADMIN_URL']);
  project.provide('workersDatabaseUrls', database.urls);
  project.provide('workersRedisUrl', redisUrl);
  return () => database.drop();
}
