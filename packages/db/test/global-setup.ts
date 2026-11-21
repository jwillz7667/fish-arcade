import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import pg from 'pg';
import type { TestProject } from 'vitest/node';

import { bootstrapDatabaseRoles, claimPublicSchema, type DatabaseRole } from '../src/roles.js';

const run = promisify(execFile);
const packageDir = fileURLToPath(new URL('..', import.meta.url));

declare module 'vitest' {
  export interface ProvidedContext {
    databaseUrls: Readonly<Record<DatabaseRole | 'admin', string>>;
    databaseName: string;
    rolePasswords: Readonly<Record<DatabaseRole, string>>;
  }
}

function withCredentials(base: URL, database: string, user?: string, password?: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  if (user !== undefined) url.username = user;
  if (password !== undefined) url.password = password;
  return url.toString();
}

/**
 * Creates a disposable database, bootstraps the three roles, and applies every migration with
 * `prisma migrate deploy` as reef_migrator, exactly as `pnpm db:migrate` does.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl = process.env['TEST_DATABASE_ADMIN_URL'];
  if (adminUrl === undefined) {
    throw new Error(
      'TEST_DATABASE_ADMIN_URL is not set. Point it at a Postgres 16 superuser connection, e.g. postgresql://postgres@127.0.0.1:5432/postgres',
    );
  }
  const base = new URL(adminUrl);
  const database = `reef_it_${randomBytes(6).toString('hex')}`;
  const passwords: Record<DatabaseRole, string> = {
    reef_migrator: randomBytes(18).toString('base64url'),
    reef_app: randomBytes(18).toString('base64url'),
    reef_readonly: randomBytes(18).toString('base64url'),
  };

  const maintenance = new pg.Client({ connectionString: adminUrl });
  await maintenance.connect();
  await maintenance.query(`CREATE DATABASE ${maintenance.escapeIdentifier(database)}`);
  await bootstrapDatabaseRoles(maintenance, { database, passwords, nodeEnv: 'test' });

  const target = new pg.Client({ connectionString: withCredentials(base, database) });
  await target.connect();
  await claimPublicSchema(target);
  await target.end();

  const urls = {
    admin: withCredentials(base, database),
    reef_migrator: withCredentials(base, database, 'reef_migrator', passwords.reef_migrator),
    reef_app: withCredentials(base, database, 'reef_app', passwords.reef_app),
    reef_readonly: withCredentials(base, database, 'reef_readonly', passwords.reef_readonly),
  };
  await run(
    fileURLToPath(new URL('../node_modules/.bin/prisma', import.meta.url)),
    ['migrate', 'deploy'],
    {
      cwd: packageDir,
      env: { ...process.env, MIGRATION_DATABASE_URL: urls.reef_migrator },
    },
  );
  project.provide('databaseUrls', urls);
  project.provide('databaseName', database);
  project.provide('rolePasswords', passwords);

  return async () => {
    await maintenance.query(`DROP DATABASE ${maintenance.escapeIdentifier(database)} WITH (FORCE)`);
    await maintenance.end();
  };
}
