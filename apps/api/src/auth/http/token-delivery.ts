import type { FastifyReply, FastifyRequest } from 'fastify';

import type { IssuedTokens } from '../sessions/session-service.js';
import { setSessionCookies } from './cookies.js';

/** Response body after a successful login, signup, or refresh. */
export type SessionResponse =
  | {
      readonly status: 'authenticated';
      readonly userId: string;
      readonly accessTokenExpiresAt: string;
      readonly csrfToken: string;
    }
  | {
      readonly status: 'authenticated';
      readonly userId: string;
      readonly accessToken: string;
      readonly accessTokenExpiresAt: string;
      readonly refreshToken: string;
      readonly refreshTokenExpiresAt: string;
    };

/**
 * @param request Current request.
 * @returns True for native apps, which keep tokens in the platform keychain and send them as
 *   `Authorization: Bearer`; false for browsers, which get httpOnly cookies.
 */
export function isNativeClient(request: FastifyRequest): boolean {
  return request.headers['x-reef-client'] === 'mobile';
}

/**
 * Hands tokens to the client in the way that suits it. Browsers never see the refresh token
 * in a body, so script on the page cannot read it.
 *
 * @param request Current request.
 * @param reply Current reply.
 * @param tokens Tokens to deliver.
 * @param now Current time, for cookie lifetimes.
 * @returns The response body.
 */
export function deliverTokens(
  request: FastifyRequest,
  reply: FastifyReply,
  tokens: IssuedTokens,
  now: Date,
): SessionResponse {
  // Responses carrying tokens must never be stored by a cache.
  void reply.header('cache-control', 'no-store');
  if (isNativeClient(request)) {
    return {
      status: 'authenticated',
      userId: tokens.userId,
      accessToken: tokens.accessToken,
      accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
      refreshToken: tokens.refreshToken,
      refreshTokenExpiresAt: tokens.refreshTokenExpiresAt.toISOString(),
    };
  }
  setSessionCookies(reply, tokens, now);
  return {
    status: 'authenticated',
    userId: tokens.userId,
    accessTokenExpiresAt: tokens.accessTokenExpiresAt.toISOString(),
    csrfToken: tokens.csrfToken,
  };
}
