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

/** Every state code the jurisdiction table covers: the 50 states plus DC. */
export const US_STATE_CODES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'DC',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
] as const;

/** Spec §4.3 "likely Mode X" states. A starting point for counsel, not a legal position. */
export const SPEC_BLOCKED_STATES: readonly string[] = [
  'CA',
  'NY',
  'NJ',
  'ME',
  'IN',
  'TN',
  'LA',
  'OK',
  'WA',
  'MI',
  'ID',
  'MT',
  'CT',
];

/** Fixed so the seed stays idempotent: rows are keyed by (state_code, effective_from). */
const DEV_EFFECTIVE_FROM = new Date('2026-01-01T00:00:00Z');
const DEV_MEMO = 'DEV-ONLY seed from spec §4.3. Not legal advice; counsel sets production rows.';

/**
 * Dev-only jurisdiction rows: spec §4.3 states blocked (X), every other state Gold Coins only
 * (S). No state gets sweepstakes (P); production rows come from Compliance after counsel signs
 * off, and a state with no row is blocked.
 */
export const DEV_JURISDICTIONS = US_STATE_CODES.map((stateCode) => {
  const isBlocked = SPEC_BLOCKED_STATES.includes(stateCode);
  return {
    stateCode,
    effectiveFrom: DEV_EFFECTIVE_FROM,
    mode: isBlocked ? ('X' as const) : ('S' as const),
    minAge: 18,
    scRedemptionEnabled: false,
    fishGamesEnabled: !isBlocked,
    legalMemoRef: DEV_MEMO,
  };
});

/** The dev-only back office login (playbook Step 9). It still has to enrol TOTP. */
export const DEV_ADMIN_EMAIL = 'admin@reef.local';

/**
 * Seeds reference data for local development: admin roles, system flags, dev jurisdiction
 * rows, and a super admin for the local login. Idempotent: existing rows are left as they are.
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
    prisma.jurisdiction.createMany({ data: DEV_JURISDICTIONS, skipDuplicates: true }),
  ]);
  const admin = await prisma.adminUser.upsert({
    where: { email: DEV_ADMIN_EMAIL },
    create: { email: DEV_ADMIN_EMAIL },
    update: {},
  });
  const superAdmin = await prisma.role.findUniqueOrThrow({ where: { name: 'super_admin' } });
  await prisma.adminUserRole.createMany({
    data: [{ adminUserId: admin.id, roleId: superAdmin.id }],
    skipDuplicates: true,
  });
}
