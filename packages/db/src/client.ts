import { PrismaPg } from '@prisma/adapter-pg';

import { PrismaClient } from './generated/prisma/client.js';

/**
 * Creates a Prisma client over node-postgres. Apps pass a reef_app connection URL; only
 * migrations use reef_migrator.
 *
 * @param connectionString Postgres URL.
 * @returns A Prisma client. The caller owns it and must `$disconnect()` on shutdown.
 */
export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}
