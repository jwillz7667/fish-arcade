import type { TestProject } from 'vitest/node';

import type { DatabaseRole } from '../src/roles.js';
import { createTestDatabase, type TestDatabaseUrls } from '../src/testing/index.js';

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: TestDatabaseUrls;
    databaseName: string;
    rolePasswords: Readonly<Record<DatabaseRole, string>>;
  }
}

/** Provides a freshly migrated disposable database to every test file. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const database = await createTestDatabase(process.env['TEST_DATABASE_ADMIN_URL']);
  project.provide('databaseUrls', database.urls);
  project.provide('databaseName', database.name);
  project.provide('rolePasswords', database.passwords);
  return () => database.drop();
}
