import { randomInt } from 'node:crypto';

import { AUTH_POLICY } from '../auth-policy.js';
import { hmacHex } from '../crypto/secrets.js';

// Crockford base32 without I, L, O, U: unambiguous to read and type. 10 characters give
// 50 bits of entropy per code.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const GROUP = 5;

function randomGroup(): string {
  let group = '';
  for (let index = 0; index < GROUP; index += 1)
    group += ALPHABET.charAt(randomInt(ALPHABET.length));
  return group;
}

/** @returns 10 fresh codes formatted `XXXXX-XXXXX`, shown to the player once. */
export function generateRecoveryCodes(): string[] {
  return Array.from(
    { length: AUTH_POLICY.recoveryCodeCount },
    () => `${randomGroup()}-${randomGroup()}`,
  );
}

/**
 * @param code Code as typed: any case, with or without the dash or spaces.
 * @returns Canonical form: uppercase, separators removed, look-alike letters mapped.
 */
export function normalizeRecoveryCode(code: string): string {
  return code.toUpperCase().replace(/[\s-]/g, '').replace(/[IL]/g, '1').replace(/O/g, '0');
}

/**
 * @param hmacKey AUTH_HMAC_KEY.
 * @param userId Owner, bound into the hash.
 * @param code Code in any accepted form.
 * @returns Hex digest for `recovery_codes.code_hash`.
 */
export function hashRecoveryCode(hmacKey: Buffer, userId: string, code: string): string {
  return hmacHex(hmacKey, 'recovery-code', userId, normalizeRecoveryCode(code));
}
