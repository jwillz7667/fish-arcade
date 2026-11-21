import { z } from 'zod';

import { hmacHex, safeEqual } from '../../auth/crypto/secrets.js';
import { GATED_CONTEXTS, type GatedContext } from '../jurisdictions/jurisdiction-policy.js';

/** What a geo token vouches for: an allowed location check. */
export interface GeoTokenClaims {
  /** The geo_checks row behind the token. */
  readonly checkId: string;
  readonly context: GatedContext;
  readonly stateCode: string;
  /** The checked user, or null for signup (no account yet). */
  readonly userId: string | null;
  readonly ip: string;
  readonly expiresAt: Date;
}

const claimsSchema = z.object({
  cid: z.string().regex(/^\d+$/),
  ctx: z.enum(GATED_CONTEXTS),
  st: z.string().regex(/^[A-Z]{2}$/),
  uid: z.uuid().nullable(),
  ip: z.string().min(1).max(64),
  exp: z.number().int(),
});

const VERSION = 'g1';
const TOKEN = /^g1\.([A-Za-z0-9_-]+)\.([0-9a-f]{64})$/;

/**
 * @param hmacKey AUTH_HMAC_KEY (domain-separated as `geo-token`).
 * @param claims What the token vouches for.
 * @returns `g1.<base64url claims>.<hex HMAC>`.
 */
export function signGeoToken(hmacKey: Buffer, claims: GeoTokenClaims): string {
  const body = Buffer.from(
    JSON.stringify({
      cid: claims.checkId,
      ctx: claims.context,
      st: claims.stateCode,
      uid: claims.userId,
      ip: claims.ip,
      exp: Math.floor(claims.expiresAt.getTime() / 1000),
    }),
    'utf8',
  ).toString('base64url');
  return `${VERSION}.${body}.${hmacHex(hmacKey, 'geo-token', body)}`;
}

/**
 * Verifies the signature and shape. Expiry, context, user, and IP binding are the caller's.
 *
 * @param hmacKey AUTH_HMAC_KEY.
 * @param token Token from the `X-Geo-Token` header.
 * @returns The claims, or undefined when the token is malformed or forged.
 */
export function verifyGeoToken(hmacKey: Buffer, token: string): GeoTokenClaims | undefined {
  const match = TOKEN.exec(token);
  const [, body, mac] = match ?? [];
  if (body === undefined || mac === undefined) return undefined;
  if (!safeEqual(mac, hmacHex(hmacKey, 'geo-token', body))) return undefined;
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    // A correctly signed but unparseable body cannot come from us; treat it as forged.
    return undefined;
  }
  const parsed = claimsSchema.safeParse(decoded);
  if (!parsed.success) return undefined;
  return {
    checkId: parsed.data.cid,
    context: parsed.data.ctx,
    stateCode: parsed.data.st,
    userId: parsed.data.uid,
    ip: parsed.data.ip,
    expiresAt: new Date(parsed.data.exp * 1000),
  };
}
