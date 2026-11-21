import { hmacHex, safeEqual } from '../crypto/secrets.js';

/**
 * CSRF token for a session: an HMAC of the session ID. It is stable for the session's life,
 * needs no storage, and cannot be forged or planted from a sibling subdomain without the key.
 *
 * @param hmacKey AUTH_HMAC_KEY.
 * @param sessionId Session the token belongs to.
 * @returns The token the client echoes in `X-CSRF-Token`.
 */
export function csrfTokenFor(hmacKey: Buffer, sessionId: string): string {
  return hmacHex(hmacKey, 'csrf', sessionId);
}

/**
 * @param hmacKey AUTH_HMAC_KEY.
 * @param sessionId Session from the verified cookie.
 * @param header `X-CSRF-Token` value, if any.
 * @returns True when the header carries this session's token. Constant time.
 */
export function isValidCsrfToken(
  hmacKey: Buffer,
  sessionId: string,
  header: string | undefined,
): boolean {
  if (header === undefined || header.length === 0) return false;
  return safeEqual(header, csrfTokenFor(hmacKey, sessionId));
}
