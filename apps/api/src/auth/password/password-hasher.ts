import { randomBytes } from 'node:crypto';

import argon2 from 'argon2';

/**
 * argon2id with the OWASP Password Storage Cheat Sheet baseline (19 MiB, 2 passes, 1 lane).
 * Raising these later is safe: `verify` reports when a stored hash should be upgraded.
 */
const OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 } as const;

/** Result of checking a password against a stored hash. */
export interface PasswordCheck {
  readonly isValid: boolean;
  /** True when the hash uses older parameters and should be replaced on this login. */
  readonly needsRehash: boolean;
}

/** Hashes and verifies player passwords (playbook Step 6). */
export class PasswordHasher {
  #dummyHash: Promise<string> | undefined;

  /**
   * @param password Plaintext password, already checked against the policy.
   * @returns PHC-format argon2id hash.
   */
  async hash(password: string): Promise<string> {
    return argon2.hash(password, OPTIONS);
  }

  /**
   * @param hash Stored hash.
   * @param password Password from the login form.
   * @returns Whether it matches, and whether the hash should be upgraded.
   */
  async verify(hash: string, password: string): Promise<PasswordCheck> {
    const isValid = await argon2.verify(hash, password);
    return { isValid, needsRehash: isValid && argon2.needsRehash(hash, OPTIONS) };
  }

  /**
   * Does the same work as a real verification against a throwaway hash. Login calls it for
   * unknown accounts so their response time matches a wrong password.
   *
   * @param password Password from the login form.
   * @returns Always false.
   */
  async verifyAgainstDummy(password: string): Promise<false> {
    this.#dummyHash ??= this.hash(randomBytes(32).toString('base64url'));
    await argon2.verify(await this.#dummyHash, password);
    return false;
  }
}
