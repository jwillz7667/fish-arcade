import { ConfigError } from '@reef/errors';
import { createTestDatabase, type TestDatabaseUrls } from '@reef/db/testing';
import pg from 'pg';
import type { TestProject } from 'vitest/node';

// Jurisdiction rows the API tests rely on (see TEST_STATES in test/support/auth-flows.ts). WY has
// no row on purpose: a state without one is blocked.
const TEST_JURISDICTIONS = [
  ['NV', 'P', 18, true, true],
  ['TX', 'S', 18, false, true],
  ['CA', 'X', 18, false, false],
  ['AL', 'P', 21, false, true],
] as const;

async function seedJurisdictions(adminUrl: string): Promise<void> {
  const client = new pg.Client({ connectionString: adminUrl });
  await client.connect();
  try {
    for (const [state, mode, minAge, isRedemptionEnabled, isFishEnabled] of TEST_JURISDICTIONS) {
      await client.query(
        `INSERT INTO jurisdictions (state_code, effective_from, mode, min_age,
           sc_redemption_enabled, fish_games_enabled, legal_memo_ref)
         VALUES ($1, '2026-01-01T00:00:00Z', $2::"JurisdictionMode", $3, $4, $5, 'TEST')`,
        [state, mode, minAge, isRedemptionEnabled, isFishEnabled],
      );
    }
  } finally {
    await client.end();
  }
}

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: TestDatabaseUrls;
    redisUrl: string;
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
  await seedJurisdictions(database.urls.admin);
  project.provide('databaseUrls', database.urls);
  project.provide('redisUrl', redisUrl);
  return () => database.drop();
}
