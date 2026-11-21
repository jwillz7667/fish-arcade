import { ErrorCode } from '@reef/errors';
import { afterAll, describe, expect, inject, it } from 'vitest';

import { createPrismaClient } from '../src/client.js';
import { bootstrapDatabaseRoles, claimPublicSchema } from '../src/roles.js';
import {
  ADMIN_ROLE_NAMES,
  DEFAULT_SYSTEM_FLAGS,
  DEV_ADMIN_EMAIL,
  SPEC_BLOCKED_STATES,
  seedReferenceData,
  US_STATE_CODES,
} from '../src/seed.js';
import { withClient } from './connect.js';

const prisma = createPrismaClient(inject('databaseUrls').reef_app);
const forbidden = expect.objectContaining({ code: ErrorCode.FORBIDDEN });

afterAll(async () => {
  await prisma.$disconnect();
});

describe('seedReferenceData', () => {
  it('seeds every admin role and fail-closed system flags, idempotently', async () => {
    await seedReferenceData(prisma, 'development');
    await seedReferenceData(prisma, 'development');

    const [roles, flags] = await Promise.all([
      prisma.role.findMany(),
      prisma.systemFlag.findMany(),
    ]);

    expect(roles.map((role) => role.name).sort()).toEqual([...ADMIN_ROLE_NAMES].sort());
    expect(Object.fromEntries(flags.map((flag) => [flag.key, flag.value]))).toEqual(
      DEFAULT_SYSTEM_FLAGS,
    );
  });

  it('seeds a dev jurisdiction row per state: spec §4.3 states blocked, the rest S, none P', async () => {
    await seedReferenceData(prisma, 'development');

    const rows = await prisma.jurisdiction.findMany();
    const modeOf = Object.fromEntries(rows.map((row) => [row.stateCode, row.mode]));

    expect(rows).toHaveLength(US_STATE_CODES.length);
    expect(SPEC_BLOCKED_STATES.every((state) => modeOf[state] === 'X')).toBe(true);
    expect(rows.filter((row) => row.mode === 'P')).toEqual([]);
    expect(
      rows.every((row) => !row.scRedemptionEnabled && row.legalMemoRef.startsWith('DEV-ONLY')),
    ).toBe(true);
  });

  it('seeds one dev super admin, idempotently', async () => {
    await seedReferenceData(prisma, 'development');
    await seedReferenceData(prisma, 'development');

    const admins = await prisma.adminUser.findMany({
      include: { roles: { include: { role: true } } },
    });

    expect(admins.map((admin) => [admin.email, admin.roles.map((link) => link.role.name)])).toEqual(
      [[DEV_ADMIN_EMAIL, ['super_admin']]],
    );
  });

  it('refuses to run in production', async () => {
    await expect(seedReferenceData(prisma, 'production')).rejects.toThrow(forbidden);
  });
});

describe('bootstrapDatabaseRoles', () => {
  it('is idempotent: re-running keeps every role working', async () => {
    await withClient('admin', async (client) => {
      await bootstrapDatabaseRoles(client, {
        database: inject('databaseName'),
        nodeEnv: 'test',
        passwords: inject('rolePasswords'),
      });
      await claimPublicSchema(client);
    });

    const users = await Promise.all(
      (['reef_migrator', 'reef_app', 'reef_readonly'] as const).map((role) =>
        withClient(
          role,
          async (client) =>
            (await client.query<{ u: string }>('SELECT current_user AS u')).rows[0]?.u,
        ),
      ),
    );

    expect(users).toEqual(['reef_migrator', 'reef_app', 'reef_readonly']);
  });

  it('creates roles that cannot escalate', async () => {
    const flags = await withClient('admin', async (client) => {
      const { rows } = await client.query<{ rolname: string; elevated: boolean }>(
        `SELECT rolname, rolsuper OR rolcreatedb OR rolcreaterole OR rolbypassrls AS elevated
           FROM pg_roles WHERE rolname LIKE 'reef\\_%' ORDER BY rolname`,
      );
      return rows;
    });

    expect(flags).toEqual([
      { rolname: 'reef_app', elevated: false },
      { rolname: 'reef_migrator', elevated: false },
      { rolname: 'reef_readonly', elevated: false },
    ]);
  });

  it('seeds a dev jurisdiction row per state: spec §4.3 states blocked, the rest S, none P', async () => {
    await seedReferenceData(prisma, 'development');

    const rows = await prisma.jurisdiction.findMany();
    const modeOf = Object.fromEntries(rows.map((row) => [row.stateCode, row.mode]));

    expect(rows).toHaveLength(US_STATE_CODES.length);
    expect(SPEC_BLOCKED_STATES.every((state) => modeOf[state] === 'X')).toBe(true);
    expect(rows.filter((row) => row.mode === 'P')).toEqual([]);
    expect(
      rows.every((row) => !row.scRedemptionEnabled && row.legalMemoRef.startsWith('DEV-ONLY')),
    ).toBe(true);
  });

  it('refuses to run in production', async () => {
    const attempt = withClient('admin', (client) =>
      bootstrapDatabaseRoles(client, {
        database: 'unused',
        nodeEnv: 'production',
        passwords: { reef_migrator: 'x', reef_app: 'x', reef_readonly: 'x' },
      }),
    );

    await expect(attempt).rejects.toThrow(forbidden);
  });
});
