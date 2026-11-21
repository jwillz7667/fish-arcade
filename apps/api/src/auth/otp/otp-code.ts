import { randomInt } from 'node:crypto';

import { AUTH_POLICY } from '../auth-policy.js';
import { hmacHex } from '../crypto/secrets.js';

const CODE_SPACE = 10 ** AUTH_POLICY.otp.digits;

/** @returns A uniformly random 6-digit code from `node:crypto`, zero-padded. */
export function generateOtpCode(): string {
  return String(randomInt(0, CODE_SPACE)).padStart(AUTH_POLICY.otp.digits, '0');
}

/**
 * Keyed hash of a code, bound to its challenge so one code hashes differently per challenge.
 *
 * @param hmacKey AUTH_HMAC_KEY.
 * @param challengeId Challenge the code was issued for.
 * @param code The code as the player typed it.
 * @returns Hex digest for `otp_challenges.code_hash`.
 */
export function hashOtpCode(hmacKey: Buffer, challengeId: string, code: string): string {
  return hmacHex(hmacKey, 'otp', challengeId, code);
}
