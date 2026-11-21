import { serializeCookie, type CookieSink } from '../../auth/http/cookies.js';
import type { IssuedAdminSession } from '../auth/admin-session-service.js';

/** Back office cookies. Strict: never sent on cross-site requests, including top-level links. */
export const ADMIN_COOKIES = {
  session: '__Host-reef_admin',
  csrf: '__Host-reef_admin_csrf',
  mfaTicket: '__Host-reef_admin_mfa',
  // Lax, not Strict: it must come back on the IdP's top-level redirect to the callback.
  oidc: '__Host-reef_admin_oidc',
} as const;

/**
 * @param reply Current reply.
 * @param session New session.
 * @param now Current time.
 */
export function setAdminSessionCookies(
  reply: CookieSink,
  session: IssuedAdminSession,
  now: Date,
): void {
  const maxAgeSeconds = (session.expiresAt.getTime() - now.getTime()) / 1000;
  reply.header('set-cookie', [
    serializeCookie(ADMIN_COOKIES.session, session.token, {
      path: '/',
      maxAgeSeconds,
      isHttpOnly: true,
      sameSite: 'Strict',
    }),
    serializeCookie(ADMIN_COOKIES.csrf, session.csrfToken, {
      path: '/',
      maxAgeSeconds,
      isHttpOnly: false,
      sameSite: 'Strict',
    }),
    serializeCookie(ADMIN_COOKIES.mfaTicket, '', {
      path: '/',
      maxAgeSeconds: 0,
      isHttpOnly: true,
      sameSite: 'Strict',
    }),
  ]);
}

/**
 * @param reply Current reply.
 * @param mfaTicket Ticket from primary login, valid 5 minutes.
 */
export function setAdminMfaCookie(reply: CookieSink, mfaTicket: string): void {
  reply.header('set-cookie', [
    serializeCookie(ADMIN_COOKIES.mfaTicket, mfaTicket, {
      path: '/',
      maxAgeSeconds: 300,
      isHttpOnly: true,
      sameSite: 'Strict',
    }),
  ]);
}

/**
 * @param reply Current reply.
 * @param handle Handle for the pending OIDC login, valid 10 minutes.
 */
export function setAdminOidcCookie(reply: CookieSink, handle: string): void {
  reply.header('set-cookie', [
    serializeCookie(ADMIN_COOKIES.oidc, handle, {
      path: '/',
      maxAgeSeconds: 600,
      isHttpOnly: true,
      sameSite: 'Lax',
    }),
  ]);
}

/**
 * Expires every back office cookie (logout).
 *
 * @param reply Current reply.
 */
export function clearAdminCookies(reply: CookieSink): void {
  reply.header(
    'set-cookie',
    Object.values(ADMIN_COOKIES).map((name) =>
      serializeCookie(name, '', {
        path: '/',
        maxAgeSeconds: 0,
        isHttpOnly: true,
        sameSite: 'Strict',
      }),
    ),
  );
}
