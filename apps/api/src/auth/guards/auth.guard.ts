import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthError, ErrorCode, ForbiddenError } from '@reef/errors';
import type { FastifyRequest } from 'fastify';

import { AUTH_KEYS } from '../../app/tokens.js';
import type { AuthKeys } from '../crypto/auth-keys.js';
import { COOKIE_NAMES, readCookies } from '../http/cookies.js';
import { isValidCsrfToken } from '../sessions/csrf.js';
import { SessionService } from '../sessions/session-service.js';
import { AccessTokenService } from '../tokens/access-token-service.js';
import { IS_PUBLIC } from './public.decorator.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const BEARER = /^Bearer ([A-Za-z0-9._-]+)$/i;

type Credential = { readonly token: string; readonly source: 'bearer' | 'cookie' };

function credentialOf(request: FastifyRequest): Credential | undefined {
  const authorization = request.headers.authorization;
  if (authorization !== undefined) {
    const match = BEARER.exec(authorization);
    // A malformed Authorization header is rejected, never silently ignored for the cookie.
    if (match?.[1] === undefined)
      throw new AuthError({ message: 'Malformed Authorization header' });
    return { token: match[1], source: 'bearer' };
  }
  const cookie = readCookies(request).get(COOKIE_NAMES.access);
  return cookie === undefined || cookie === '' ? undefined : { token: cookie, source: 'cookie' };
}

/**
 * Global guard (playbook Step 6): every route requires a valid access token unless marked
 * `@Public()`. Tokens come from `Authorization: Bearer` (native apps) or the access cookie
 * (browsers). Cookie-authenticated writes must also carry the session's CSRF token, since a
 * browser attaches cookies to cross-site requests on its own. Revoked sessions are refused
 * even while their access tokens are unexpired.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AccessTokenService) private readonly accessTokens: AccessTokenService,
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(AUTH_KEYS) private readonly keys: AuthKeys,
  ) {}

  /**
   * @param context Current request.
   * @returns True when the route is public or the caller is authenticated.
   * @throws AuthError when no valid, unrevoked access token is presented.
   * @throws ForbiddenError CSRF_INVALID on a cookie-authenticated write without the token.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean | undefined>(IS_PUBLIC, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const credential = credentialOf(request);
    if (credential === undefined) throw new AuthError();
    const claims = await this.accessTokens.verify(credential.token);
    if (await this.sessions.isRevoked(claims.sessionId)) {
      throw new AuthError({ message: 'Session revoked' });
    }
    if (credential.source === 'cookie' && !SAFE_METHODS.has(request.method)) {
      const header = request.headers['x-csrf-token'];
      if (
        !isValidCsrfToken(
          this.keys.hmacKey,
          claims.sessionId,
          typeof header === 'string' ? header : undefined,
        )
      ) {
        throw new ForbiddenError({ code: ErrorCode.CSRF_INVALID });
      }
    }
    request.principal = claims;
    return true;
  }
}
