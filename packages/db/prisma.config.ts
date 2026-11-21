import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { defineConfig } from 'prisma/config';

// Prisma 7 no longer reads .env itself. Real environment variables still win.
const rootEnvFile = fileURLToPath(new URL('../../.env', import.meta.url));
// The path is fixed relative to this file.
// eslint-disable-next-line security/detect-non-literal-fs-filename
if (existsSync(rootEnvFile)) process.loadEnvFile(rootEnvFile);

// Migrations run as reef_migrator (DDL). Apps connect as reef_app via DATABASE_URL instead.
const migrationUrl = process.env['MIGRATION_DATABASE_URL'];

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: { path: 'prisma/migrations' },
  ...(migrationUrl === undefined ? {} : { datasource: { url: migrationUrl } }),
});
