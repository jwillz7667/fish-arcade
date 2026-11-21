import type { FastifyRequest } from 'fastify';

import type { IssuedTokens } from '../sessions/session-service.js';

/**
 * Cookie names. `__Host-` pins a cookie to this exact host and path `/`; `__Secure-` lets the
 * refresh cookie be scoped to the auth routes. Browsers enforce both prefixes.
 */
export const COOKIE_NAMES = {
  access: '__Host-reef_at',
  refresh: '__Secure-reef_rt',
  csrf: '__Host-reef_csrf',
} as const;

/** Where cookies are written: a Fastify reply, or anything with the same `header` method. */
export interface CookieSink {
  header(name: 'set-cookie', value: string[]): unknown;
}

/** Path the refresh cookie is sent on: only the auth routes ever see it. */
export const REFRESH_COOKIE_PATH = '/v1/auth';

const COOKIE_VALUE = /^[A-Za-z0-9._~-]+$/;

/** Attributes for {@link serializeCookie}. Every cookie is `Secure`. */
export interface CookieOptions {
  readonly path: string;
  readonly maxAgeSeconds: number;
  readonly isHttpOnly: boolean;
  /** Defaults to Lax. The back office uses Strict. */
  readonly sameSite?: 'Lax' | 'Strict';
}

/**
 * @param name Cookie name.
 * @param value base64url or JWT value, or empty to expire the cookie.
 * @param options Path, lifetime, and flags.
 * @returns A `Set-Cookie` header value.
 * @throws Error when the value has characters that could inject attributes.
 */
export function serializeCookie(name: string, value: string, options: CookieOptions): string {
  // Only our own base64url and JWT values are written; anything else is a bug.
  if (value !== '' && !COOKIE_VALUE.test(value))
    throw new Error(`Refusing to write cookie ${name}`);
  const parts = [
    `${name}=${value}`,
    `Path=${options.path}`,
    // Rounded up: a cookie outliving its token by under a second is harmless (the token is
    // refused), while one expiring early would drop a still-valid session.
    `Max-Age=${String(Math.max(0, Math.ceil(options.maxAgeSeconds)))}`,
    'Secure',
    `SameSite=${options.sameSite ?? 'Lax'}`,
  ];
  if (options.isHttpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

/**
 * Reads cookies from the request header. Later duplicates do not override the first value, so
 * a cookie planted by a sibling subdomain cannot shadow ours.
 *
 * @param request Current request.
 * @returns Cookie name to value.
 */
export function readCookies(request: Pick<FastifyRequest, 'headers'>): ReadonlyMap<string, string> {
  const cookies = new Map<string, string>();
  const header = request.headers.cookie;
  if (header === undefined) return cookies;
  for (const pair of header.split(';')) {
    const separator = pair.indexOf('=');
    if (separator < 0) continue;
    const name = pair.slice(0, separator).trim();
    const value = pair.slice(separator + 1).trim();
    if (name !== '' && !cookies.has(name)) cookies.set(name, value);
  }
  return cookies;
}

const secondsUntil = (date: Date, now: Date): number => (date.getTime() - now.getTime()) / 1000;

/**
 * Sets the web session cookies (playbook Step 6): httpOnly, Secure, SameSite=Lax. The CSRF
 * cookie is readable by the page, which echoes it in `X-CSRF-Token`.
 *
 * @param reply Current reply.
 * @param tokens Tokens from login or refresh.
 * @param now Current time.
 */
export function setSessionCookies(reply: CookieSink, tokens: IssuedTokens, now: Date): void {
  const refreshMaxAge = secondsUntil(tokens.refreshTokenExpiresAt, now);
  void reply.header('set-cookie', [
    serializeCookie(COOKIE_NAMES.access, tokens.accessToken, {
      path: '/',
      maxAgeSeconds: secondsUntil(tokens.accessTokenExpiresAt, now),
      isHttpOnly: true,
    }),
    serializeCookie(COOKIE_NAMES.refresh, tokens.refreshToken, {
      path: REFRESH_COOKIE_PATH,
      maxAgeSeconds: refreshMaxAge,
      isHttpOnly: true,
    }),
    serializeCookie(COOKIE_NAMES.csrf, tokens.csrfToken, {
      path: '/',
      maxAgeSeconds: refreshMaxAge,
      isHttpOnly: false,
    }),
  ]);
}

/**
 * Expires every session cookie (logout, or a refresh that failed).
 *
 * @param reply Current reply.
 */
export function clearSessionCookies(reply: CookieSink): void {
  void reply.header('set-cookie', [
    serializeCookie(COOKIE_NAMES.access, '', { path: '/', maxAgeSeconds: 0, isHttpOnly: true }),
    serializeCookie(COOKIE_NAMES.refresh, '', {
      path: REFRESH_COOKIE_PATH,
      maxAgeSeconds: 0,
      isHttpOnly: true,
    }),
    serializeCookie(COOKIE_NAMES.csrf, '', { path: '/', maxAgeSeconds: 0, isHttpOnly: false }),
  ]);
}
