import argon2 from 'argon2';
import { describe, expect, it } from 'vitest';

import { DisabledBreachedPasswordChecker } from './breached-password-checker.js';
import { PasswordHasher } from './password-hasher.js';
import { assertPasswordNotBreached, newPasswordSchema } from './password-policy.js';

describe('PasswordHasher', () => {
  const hasher = new PasswordHasher();

  it('hashes with argon2id and verifies only the right password', async () => {
    const hash = await hasher.hash('tidal-anemone-lantern-42');

    expect(hash.startsWith('$argon2id$v=19$m=19456,t=2,p=1$')).toBe(true);
    expect(await hasher.verify(hash, 'tidal-anemone-lantern-42')).toEqual({
      isValid: true,
      needsRehash: false,
    });
    expect(await hasher.verify(hash, 'tidal-anemone-lantern-43')).toEqual({
      isValid: false,
      needsRehash: false,
    });
  });

  it('asks to upgrade hashes made with weaker parameters', async () => {
    const weak = await argon2.hash('tidal-anemone-lantern-42', {
      type: argon2.argon2id,
      memoryCost: 8_192,
      timeCost: 1,
      parallelism: 1,
    });

    expect(await hasher.verify(weak, 'tidal-anemone-lantern-42')).toEqual({
      isValid: true,
      needsRehash: true,
    });
  });

  it('runs a real verification for unknown accounts and always fails', async () => {
    expect(await hasher.verifyAgainstDummy('anything at all')).toBe(false);
  });
});

describe('password policy', () => {
  it('requires 12 to 128 characters and nothing else', () => {
    expect(
      ['a'.repeat(11), 'a'.repeat(12), 'a'.repeat(128), 'a'.repeat(129)].map(
        (value) => newPasswordSchema.safeParse(value).success,
      ),
    ).toEqual([false, true, true, false]);
  });

  it('rejects breached passwords on the password field', async () => {
    const checker = { isBreached: () => Promise.resolve(true) };

    await expect(assertPasswordNotBreached('password1234', checker)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      issues: [{ path: 'password' }],
    });
    await expect(
      assertPasswordNotBreached('password1234', new DisabledBreachedPasswordChecker()),
    ).resolves.toBeUndefined();
  });
});
