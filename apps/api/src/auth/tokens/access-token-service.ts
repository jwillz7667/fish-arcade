import { randomUUID } from 'node:crypto';

import { AuthError } from '@reef/errors';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';

import { AUTH_POLICY } from '../auth-policy.js';
import { addMs, type Clock } from '../../shared/clock.js';
import type { AuthKeys } from '../crypto/auth-keys.js';

const ISSUER = 'reef-api';
const AUDIENCE = 'reef-player';
const TOKEN_TYPE = 'at+jwt';
const ALGORITHM = 'EdDSA';

/** Who an access token speaks for. */
export interface AccessClaims {
  readonly userId: string;
  readonly sessionId: string;
  /** Time of the primary login behind this session. Step-up checks read it. */
  readonly authTime: Date;
  /** Authentication methods used at login (RFC 8176 values). */
  readonly amr: readonly string[];
}

/** A signed access token and when it stops working. */
export interface SignedAccessToken {
  readonly token: string;
  readonly expiresAt: Date;
}

const payloadSchema = z.object({
  sub: z.uuid(),
  sid: z.uuid(),
  auth_time: z.number().int().nonnegative(),
  amr: z.array(z.string().min(1)).min(1),
});

const toSeconds = (date: Date): number => Math.floor(date.getTime() / 1000);

/**
 * Signs and verifies 10-minute Ed25519 access JWTs (playbook Step 6). Verification pins the
 * algorithm, issuer, audience, and token type, so a token minted for anything else is refused.
 */
export class AccessTokenService {
  constructor(
    private readonly keys: AuthKeys,
    private readonly clock: Clock,
  ) {}

  /**
   * @param claims Subject, session, login time, and methods.
   * @returns The compact JWT and its expiry.
   */
  async sign(claims: AccessClaims): Promise<SignedAccessToken> {
    const now = this.clock.now();
    // JWT times are whole seconds; report the exact `exp` the token carries.
    const expiresAt = new Date(toSeconds(addMs(now, AUTH_POLICY.accessTokenTtlMs)) * 1000);
    const token = await new SignJWT({
      sid: claims.sessionId,
      auth_time: toSeconds(claims.authTime),
      amr: [...claims.amr],
    })
      .setProtectedHeader({ alg: ALGORITHM, kid: this.keys.keyId, typ: TOKEN_TYPE })
      .setSubject(claims.userId)
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setIssuedAt(toSeconds(now))
      .setExpirationTime(toSeconds(expiresAt))
      .setJti(randomUUID())
      .sign(this.keys.signingKey);
    return { token, expiresAt };
  }

  /**
   * @param token Compact JWT from the Authorization header or the access cookie.
   * @returns The verified claims.
   * @throws AuthError when the token is malformed, expired, or not signed by this service.
   */
  async verify(token: string): Promise<AccessClaims> {
    let payload: unknown;
    try {
      ({ payload } = await jwtVerify(token, this.keys.verifyKey, {
        algorithms: [ALGORITHM],
        issuer: ISSUER,
        audience: AUDIENCE,
        typ: TOKEN_TYPE,
        currentDate: this.clock.now(),
        requiredClaims: ['sub', 'exp', 'iat', 'jti'],
      }));
    } catch (error) {
      throw new AuthError({ message: 'Access token rejected', cause: error });
    }
    const parsed = payloadSchema.safeParse(payload);
    if (!parsed.success) throw new AuthError({ message: 'Access token claims malformed' });
    return {
      userId: parsed.data.sub,
      sessionId: parsed.data.sid,
      authTime: new Date(parsed.data.auth_time * 1000),
      amr: parsed.data.amr,
    };
  }
}
