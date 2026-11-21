import { randomBytes } from 'node:crypto';

import { BlindIndexer, FieldCipher, LocalKeyFileProvider } from '@reef/crypto-fields';
import { afterAll, describe, expect, it } from 'vitest';
import { inject } from 'vitest';

import { createPrismaClient } from '../src/client.js';
import { withClient } from './connect.js';

const prisma = createPrismaClient(inject('databaseUrls').reef_app);
const cipher = new FieldCipher({ provider: new LocalKeyFileProvider(randomBytes(32)) });
const blindIndexer = new BlindIndexer(randomBytes(32));

afterAll(async () => {
  await prisma.$disconnect();
});

const EMAIL = 'alice.player@example.com';
const DOB = '1990-04-01';
const ADDRESS = '742 Evergreen Terrace';
const PAYOUT = 'bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080';

async function createPlayer() {
  const user = await prisma.user.create({
    data: {
      emailEnc: await cipher.encrypt(EMAIL, { table: 'users', column: 'email_enc' }),
      emailBidx: blindIndexer.index(EMAIL, 'email'),
      profile: {
        create: {
          displayName: 'alice',
          stateCode: 'TX',
          dobEnc: await cipher.encrypt(DOB, { table: 'profiles', column: 'dob_enc' }),
          addressLine1Enc: await cipher.encrypt(ADDRESS, {
            table: 'profiles',
            column: 'address_line1_enc',
          }),
        },
      },
      payoutAddresses: {
        create: {
          addressEnc: await cipher.encrypt(PAYOUT, {
            table: 'payout_addresses',
            column: 'address_enc',
          }),
          addressBidx: blindIndexer.index(PAYOUT, 'btc_address'),
          addressType: 'p2wpkh',
          network: 'regtest',
        },
      },
    },
  });
  return user.id;
}

describe('encrypted fields', () => {
  it('stores ciphertext that raw SQL cannot read', async () => {
    const userId = await createPlayer();

    const raw = await withClient('reef_readonly', async (client) => {
      const { rows } = await client.query(
        `SELECT u.email_enc, p.dob_enc, p.address_line1_enc, a.address_enc
           FROM users u JOIN profiles p ON p.user_id = u.id JOIN payout_addresses a ON a.user_id = u.id
          WHERE u.id = $1`,
        [userId],
      );
      return JSON.stringify(rows);
    });

    for (const secret of [EMAIL, 'alice', DOB, '1990', ADDRESS, 'Evergreen', PAYOUT]) {
      expect(raw).not.toContain(secret);
    }
    expect(raw).toContain('v1.');
  });

  it('finds a player by email through the blind index and decrypts every field', async () => {
    await prisma.user
      .deleteMany({ where: { emailBidx: blindIndexer.index(EMAIL, 'email') } })
      .catch(() => undefined);
    await createPlayer().catch(() => undefined);

    const user = await prisma.user.findUniqueOrThrow({
      where: { emailBidx: blindIndexer.index('  ALICE.player@Example.com', 'email') },
      include: { profile: true, payoutAddresses: true },
    });

    expect({
      email: await cipher.decrypt(user.emailEnc ?? '', { table: 'users', column: 'email_enc' }),
      dob: await cipher.decrypt(user.profile?.dobEnc ?? '', {
        table: 'profiles',
        column: 'dob_enc',
      }),
      address: await cipher.decrypt(user.profile?.addressLine1Enc ?? '', {
        table: 'profiles',
        column: 'address_line1_enc',
      }),
      payout: await cipher.decrypt(user.payoutAddresses[0]?.addressEnc ?? '', {
        table: 'payout_addresses',
        column: 'address_enc',
      }),
    }).toEqual({ email: EMAIL, dob: DOB, address: ADDRESS, payout: PAYOUT });
  });

  it('rejects a second account with the same email', async () => {
    await expect(createPlayer()).rejects.toThrow(/Unique constraint/);
  });
});
