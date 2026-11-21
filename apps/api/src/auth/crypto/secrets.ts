import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** Bytes of entropy in refresh tokens, tickets, and other opaque bearer secrets. */
export const OPAQUE_TOKEN_BYTES = 32;

/**
 * @param bytes Entropy in bytes. Defaults to 256 bits.
 * @returns A random base64url string from `node:crypto`.
 */
export function randomToken(bytes: number = OPAQUE_TOKEN_BYTES): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * SHA-256 for high-entropy secrets (refresh tokens, tickets), where a key adds nothing.
 *
 * @param value Secret to hash.
 * @returns Lowercase hex digest.
 */
export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * Keyed hash for low-entropy secrets (6-digit OTPs, recovery codes) and derived tokens (CSRF).
 * The purpose label keeps hashes for different uses apart under one key.
 *
 * @param key 32-byte AUTH_HMAC_KEY.
 * @param purpose Domain-separation label, such as `otp`.
 * @param parts Values bound into the hash, joined unambiguously.
 * @returns Lowercase hex digest.
 */
export function hmacHex(key: Buffer, purpose: string, ...parts: readonly string[]): string {
  const hmac = createHmac('sha256', key).update(purpose, 'utf8');
  for (const part of parts) hmac.update('\u0000', 'utf8').update(part, 'utf8');
  return hmac.digest('hex');
}

/**
 * Constant-time string comparison. Both sides are hashed first so inputs of different lengths
 * take the same time and never throw.
 *
 * @param actual Value from the request.
 * @param expected Value computed on the server.
 * @returns True when they are equal.
 */
export function safeEqual(actual: string, expected: string): boolean {
  const left = createHash('sha256').update(actual, 'utf8').digest();
  const right = createHash('sha256').update(expected, 'utf8').digest();
  return timingSafeEqual(left, right);
}
