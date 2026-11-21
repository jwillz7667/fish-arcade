import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { ConfigError } from '@reef/errors';
import pg from 'pg';

import { bootstrapDatabaseRoles, claimPublicSchema, type DatabaseRole } from '../roles.js';

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL('../../', import.meta.url));
const prismaBin = fileURLToPath(new URL('../../node_modules/.bin/prisma', import.meta.url));

/** Connection URLs for a disposable test database, one per role plus a superuser. */
export type TestDatabaseUrls = Readonly<Record<DatabaseRole | 'admin', string>>;

/** A migrated, disposable database. Call `drop` when finished. */
export interface TestDatabase {
  readonly name: string;
  readonly urls: TestDatabaseUrls;
  readonly passwords: Readonly<Record<DatabaseRole, string>>;
  /** Drops the database, closing any open connections to it. */
  drop(): Promise<void>;
}

function missingAdminUrl(): never {
  throw new ConfigError({
    issues: [{ path: 'TEST_DATABASE_ADMIN_URL', message: 'set it to a Postgres 16 superuser URL' }],
  });
}

function urlFor(
  base: URL,
  database: string,
  login?: { role: DatabaseRole; secret: string },
): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (login) {
    url.username = login.role;
    url.password = login.secret;
  }
  return url.toString();
}

/**
 * Creates `reef_it_<random>`, bootstraps the three roles, and applies every migration with
 * `prisma migrate deploy` as reef_migrator, exactly as `pnpm db:migrate` does. For integration
 * test global setup only.
 *
 * Roles are cluster-wide and their passwords are reset on each call, so concurrent runs
 * against one cluster interfere with each other.
 *
 * @param adminUrl Superuser connection URL, usually from TEST_DATABASE_ADMIN_URL.
 * @returns The database, its URLs, and a `drop` function.
 * @throws ConfigError when `adminUrl` is undefined.
 */
export async function createTestDatabase(adminUrl: string | undefined): Promise<TestDatabase> {
  const base = new URL(adminUrl ?? missingAdminUrl());
  const name = `reef_it_${randomBytes(6).toString('hex')}`;
  const passwords: Record<DatabaseRole, string> = {
    reef_migrator: randomBytes(18).toString('base64url'),
    reef_app: randomBytes(18).toString('base64url'),
    reef_readonly: randomBytes(18).toString('base64url'),
  };

  const maintenance = new pg.Client({ connectionString: base.toString() });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${maintenance.escapeIdentifier(name)}`);
  await bootstrapDatabaseRoles(maintenance, { database: name, passwords, nodeEnv: 'test' });

  const target = new pg.Client({ connectionString: urlFor(base, name) });
  await target.connect();
  await claimPublicSchema(target);
  await target.end();

  const urls: TestDatabaseUrls = {
    admin: urlFor(base, name),
    reef_migrator: urlFor(base, name, { role: 'reef_migrator', secret: passwords.reef_migrator }),
    reef_app: urlFor(base, name, { role: 'reef_app', secret: passwords.reef_app }),
    reef_readonly: urlFor(base, name, { role: 'reef_readonly', secret: passwords.reef_readonly }),
  };
  await run(prismaBin, ['migrate', 'deploy'], {
    cwd: packageDir,
    env: { ...process.env, MIGRATION_DATABASE_URL: urls.reef_migrator },
  });

  return {
    name,
    urls,
    passwords,
    drop: async () => {
      await maintenance.query(`DROP DATABASE ${maintenance.escapeIdentifier(name)} WITH (FORCE)`);
      await maintenance.end();
    },
  };
}
