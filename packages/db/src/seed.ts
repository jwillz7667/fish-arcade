import { ForbiddenError } from '@reef/errors';

import type { PrismaClient } from './generated/prisma/client.js';

/** Back office roles from spec §13.1. */
export const ADMIN_ROLE_NAMES = [
  'super_admin',
  'ops_manager',
  'support_agent',
  'compliance_officer',
  'finance',
  'game_ops',
  'affiliate_manager',
  'analyst',
] as const;

/**
 * System flags and their starting values. Money movement starts paused so that a fresh
 * environment fails closed until an operator turns it on (CLAUDE.md: fail closed).
 */
export const DEFAULT_SYSTEM_FLAGS: Readonly<Record<string, boolean>> = {
  payouts_paused: true,
  purchases_paused: true,
};

/**
 * Seeds reference data for local development: admin roles and system flags. Idempotent:
 * existing rows are left as they are.
 *
 * @param prisma A client connected as reef_app.
 * @param nodeEnv Current NODE_ENV.
 * @throws ForbiddenError when `nodeEnv` is production.
 */
export async function seedReferenceData(prisma: PrismaClient, nodeEnv: string): Promise<void> {
  if (nodeEnv === 'production') {
    throw new ForbiddenError({ message: 'The dev seed refuses to run in production' });
  }
  await prisma.$transaction([
    prisma.role.createMany({
      data: ADMIN_ROLE_NAMES.map((name) => ({ name })),
      skipDuplicates: true,
    }),
    prisma.systemFlag.createMany({
      data: Object.entries(DEFAULT_SYSTEM_FLAGS).map(([key, value]) => ({
        key,
        value,
        updatedBy: 'seed',
      })),
      skipDuplicates: true,
    }),
  ]);
}
