import { defineEnvSchema, loadEnv, postgresUrlSchema } from '@reef/config';
import pg from 'pg';
import { z } from 'zod';

import { bootstrapDatabaseRoles, claimPublicSchema } from '../src/roles.js';
import { loadRootEnv } from './load-root-env.js';

const password = z.string().min(12);

loadRootEnv();
const env = loadEnv(
  defineEnvSchema({
    DATABASE_ADMIN_URL: postgresUrlSchema,
    REEF_MIGRATOR_PASSWORD: password,
    REEF_APP_PASSWORD: password,
    REEF_READONLY_PASSWORD: password,
  }),
);

const adminUrl = new URL(env.DATABASE_ADMIN_URL);
const database = decodeURIComponent(adminUrl.pathname.slice(1));

const client = new pg.Client({ connectionString: env.DATABASE_ADMIN_URL });
await client.connect();
try {
  await bootstrapDatabaseRoles(client, {
    database,
    nodeEnv: env.NODE_ENV,
    passwords: {
      reef_migrator: env.REEF_MIGRATOR_PASSWORD,
      reef_app: env.REEF_APP_PASSWORD,
      reef_readonly: env.REEF_READONLY_PASSWORD,
    },
  });
  await claimPublicSchema(client);
  console.log(`Roles ready on database ${database}.`);
} finally {
  await client.end();
}
