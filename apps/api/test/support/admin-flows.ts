import { randomUUID } from 'node:crypto';

import type pg from 'pg';

import type { TestApp } from '../http/test-app.js';
import { nextIp, totpAt, type InjectResponse } from './auth-flows.js';

/** A signed-in admin, ready to call admin routes. */
export interface AdminSession {
  readonly adminId: string;
  readonly email: string;
  readonly secret: string;
  readonly ip: string;
  readonly csrfToken: string;
  /** Session and CSRF cookies, for the `cookie` header. */
  readonly cookie: string;
}

/**
 * Creates an admin with the given roles, straight in the database (as a super admin would).
 *
 * @returns The admin's ID and email.
 */
export async function createAdmin(
  db: pg.Pool,
  roles: readonly string[],
  email = `staff-${randomUUID()}@reef.test`,
): Promise<{ adminId: string; email: string }> {
  await db.query(
    `INSERT INTO roles (name) SELECT unnest($1::text[]) ON CONFLICT (name) DO NOTHING`,
    [
      [
        'super_admin',
        'ops_manager',
        'support_agent',
        'compliance_officer',
        'finance',
        'game_ops',
        'affiliate_manager',
        'analyst',
      ],
    ],
  );
  const { rows } = await db.query<{ id: string }>(
    'INSERT INTO admin_users (email) VALUES ($1) RETURNING id',
    [email],
  );
  const adminId = rows[0]?.id ?? '';
  await db.query(
    `INSERT INTO admin_user_roles (admin_user_id, role_id) SELECT $1, id FROM roles WHERE name = ANY($2::text[])`,
    [adminId, roles],
  );
  return { adminId, email };
}

/** Values of `Set-Cookie` headers, as `name=value` pairs. */
export function cookiePairs(response: InjectResponse): string[] {
  return [response.headers['set-cookie']]
    .flat()
    .filter((cookie): cookie is string => typeof cookie === 'string')
    .map((cookie) => cookie.split(';')[0] ?? '');
}

/**
 * Dev login, TOTP enrolment, and MFA: the whole first sign-in.
 *
 * @returns A signed-in admin session.
 */
export async function adminSignIn(
  t: TestApp,
  admin: { adminId: string; email: string },
  ip = nextIp(),
): Promise<AdminSession> {
  const login = await t.app.inject({
    method: 'POST',
    url: '/v1/admin/auth/dev-login',
    remoteAddress: ip,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email: admin.email }),
  });
  if (login.statusCode !== 200) throw new Error(`dev login failed: ${login.body}`);
  const ticketCookie = cookiePairs(login).join('; ');
  const setup = await t.app.inject({
    method: 'POST',
    url: '/v1/admin/auth/mfa/setup',
    remoteAddress: ip,
    headers: { cookie: ticketCookie },
  });
  const { secret } = setup.json<{ secret: string }>();
  // The previous step, so a code generated later in the test is never a replay.
  const code = await totpAt(secret, new Date(t.auth.clock.now().getTime() - 30_000));
  const verified = await t.app.inject({
    method: 'POST',
    url: '/v1/admin/auth/mfa/verify',
    remoteAddress: ip,
    headers: { 'content-type': 'application/json', cookie: ticketCookie },
    payload: JSON.stringify({ code }),
  });
  if (verified.statusCode !== 200) throw new Error(`admin MFA failed: ${verified.body}`);
  const cookie = cookiePairs(verified)
    .filter((pair) => !pair.endsWith('='))
    .join('; ');
  return {
    ...admin,
    secret,
    ip,
    cookie,
    csrfToken: verified.json<{ csrfToken: string }>().csrfToken,
  };
}

/** Calls an admin route as a signed-in admin, with CSRF on writes. */
export function adminCall(
  t: TestApp,
  session: AdminSession,
  method: 'GET' | 'POST' | 'PUT',
  url: string,
  body?: unknown,
  options: { csrf?: boolean; ip?: string } = {},
): Promise<InjectResponse> {
  const isWrite = method !== 'GET';
  return t.app.inject({
    method,
    url,
    remoteAddress: options.ip ?? session.ip,
    headers: {
      cookie: session.cookie,
      ...(isWrite ? { 'content-type': 'application/json' } : {}),
      ...(isWrite && options.csrf !== false ? { 'x-csrf-token': session.csrfToken } : {}),
    },
    ...(isWrite ? { payload: JSON.stringify(body ?? {}) } : {}),
  });
}
