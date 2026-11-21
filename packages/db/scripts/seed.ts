import { defineEnvSchema, loadEnv, postgresUrlSchema } from '@reef/config';

import { createPrismaClient } from '../src/client.js';
import { seedReferenceData } from '../src/seed.js';
import { loadRootEnv } from './load-root-env.js';

loadRootEnv();
const env = loadEnv(defineEnvSchema({ DATABASE_URL: postgresUrlSchema }));

const prisma = createPrismaClient(env.DATABASE_URL);
try {
  await seedReferenceData(prisma, env.NODE_ENV);
  console.log('Seeded admin roles, system flags, dev jurisdictions, and the dev admin.');
} finally {
  await prisma.$disconnect();
}
