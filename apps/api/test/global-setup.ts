import { createTestDatabase, type TestDatabaseUrls } from '@reef/db/testing';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: TestDatabaseUrls;
  }
}

/** Provides a freshly migrated disposable database to every test file. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = await createTestDatabase(process.env['TEST_DATABASE_ADMIN_URL']);
  project.provide('databaseUrls', database.urls);
  return () => database.drop();
}
