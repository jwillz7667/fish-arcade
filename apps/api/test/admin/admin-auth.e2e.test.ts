import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { ErrorBody } from '../../src/http/error-response.js';
import { buildTestApp, testEnv, type TestApp } from '../http/test-app.js';
import { adminCall, adminSignIn, cookiePairs, createAdmin } from '../support/admin-flows.js';
import { nextIp, totpAt, type InjectResponse } from '../support/auth-flows.js';
import { FakeIdp } from '../support/fake-idp.js';

let t: TestApp;
let db: pg.Pool;

beforeAll(async () => {
  t = await buildTestApp();
  db = new pg.Pool({ connectionString: inject('databaseUrls').admin, max: 2 });
});

afterAll(async () => {
  await t.app.close();
  await db.end();
});

const errorCode = (response: InjectResponse): string => response.json<ErrorBody>().error.code;

function devLogin(app: TestApp, email: string, ip = nextIp()): Promise<InjectResponse> {
  return app.app.inject({
    method: 'POST',
    url: '/v1/admin/auth/dev-login',
    remoteAddress: ip,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({ email }),
  });
}

describe('admin sign-in', () => {
  it('requires TOTP enrolment on first login, then a code on every login', async () => {
    const admin = await createAdmin(db, ['analyst']);

    const first = await devLogin(t, admin.email);
    const session = await adminSignIn(t, admin);
    const second = await devLogin(t, admin.email, session.ip);
    const ticket = cookiePairs(second).join('; ');
    const verified = await t.app.inject({
      method: 'POST',
      url: '/v1/admin/auth/mfa/verify',
      remoteAddress: session.ip,
      headers: { 'content-type': 'application/json', cookie: ticket },
      payload: JSON.stringify({ code: await totpAt(session.secret, t.auth.clock.now()) }),
    });

    expect(first.json()).toEqual({ next: 'mfa_enrollment_required' });
    expect(second.json()).toEqual({ next: 'mfa_required' });
    expect(verified.statusCode).toBe(200);
  });

  it('sets a Strict, httpOnly session cookie and a readable CSRF cookie', async () => {
    const admin = await createAdmin(db, ['analyst']);
    const login = await devLogin(t, admin.email);
    const ip = nextIp();
    const ticket = cookiePairs(login).join('; ');
    const setup = await t.app.inject({
      method: 'POST',
      url: '/v1/admin/auth/mfa/setup',
      remoteAddress: ip,
      headers: { cookie: ticket },
    });

    const verified = await t.app.inject({
      method: 'POST',
      url: '/v1/admin/auth/mfa/verify',
      remoteAddress: ip,
      headers: { 'content-type': 'application/json', cookie: ticket },
      payload: JSON.stringify({
        code: await totpAt(setup.json<{ secret: string }>().secret, t.auth.clock.now()),
      }),
    });
    const cookies = [verified.headers['set-cookie']].flat().map(String);

    expect(cookies.find((cookie) => cookie.startsWith('__Host-reef_admin='))).toMatch(
      /SameSite=Strict; HttpOnly$/,
    );
    expect(cookies.find((cookie) => cookie.startsWith('__Host-reef_admin_csrf='))).not.toMatch(
      /HttpOnly/,
    );
  });

  it('refuses unknown admins, other email domains, and disabled admins alike', async () => {
    const disabled = await createAdmin(db, ['analyst']);
    await db.query(`UPDATE admin_users SET status = 'disabled' WHERE id = $1`, [disabled.adminId]);
    const outsider = await createAdmin(db, ['analyst'], `staff-${String(Date.now())}@example.com`);

    const responses = await Promise.all([
      devLogin(t, 'nobody@reef.test'),
      devLogin(t, outsider.email),
      devLogin(t, disabled.email),
    ]);

    expect(responses.map(errorCode)).toEqual([
      'INVALID_CREDENTIALS',
      'INVALID_CREDENTIALS',
      'INVALID_CREDENTIALS',
    ]);
  });

  it('refuses a wrong code and ends the ticket after 5 tries', async () => {
    const admin = await createAdmin(db, ['analyst']);
    const session = await adminSignIn(t, admin);
    const ticket = cookiePairs(await devLogin(t, admin.email, session.ip)).join('; ');
    const tryCode = (code: string) =>
      t.app.inject({
        method: 'POST',
        url: '/v1/admin/auth/mfa/verify',
        remoteAddress: session.ip,
        headers: { 'content-type': 'application/json', cookie: ticket },
        payload: JSON.stringify({ code }),
      });

    const codes: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) codes.push(errorCode(await tryCode('000000')));

    expect(codes.slice(0, 5).every((code) => code === 'OTP_INVALID')).toBe(true);
    expect(['OTP_ATTEMPTS_EXCEEDED', 'RATE_LIMITED']).toContain(codes[5]);
  });

  it('refuses requests from outside the IP allowlist, even with a valid session', async () => {
    const session = await adminSignIn(t, await createAdmin(db, ['analyst']));

    const outside = await adminCall(t, session, 'GET', '/v1/admin/auth/session', undefined, {
      ip: '192.0.2.10',
    });
    const login = await devLogin(t, session.email, '192.0.2.10');

    expect([outside.statusCode, login.statusCode]).toEqual([403, 403]);
  });

  it('times out after 30 idle minutes (spec §13.3) but not while active', async () => {
    const session = await adminSignIn(t, await createAdmin(db, ['analyst']));

    t.auth.clock.advance(25 * 60_000);
    const active = await adminCall(t, session, 'GET', '/v1/admin/auth/session');
    t.auth.clock.advance(25 * 60_000);
    const stillActive = await adminCall(t, session, 'GET', '/v1/admin/auth/session');
    t.auth.clock.advance(31 * 60_000);
    const idle = await adminCall(t, session, 'GET', '/v1/admin/auth/session');

    expect([active.statusCode, stillActive.statusCode, idle.statusCode]).toEqual([200, 200, 401]);
  });

  it('requires the CSRF header on writes', async () => {
    const session = await adminSignIn(t, await createAdmin(db, ['super_admin']));

    const response = await adminCall(
      t,
      session,
      'POST',
      '/v1/admin/test/write',
      {},
      { csrf: false },
    );

    expect([response.statusCode, errorCode(response)]).toEqual([403, 'CSRF_INVALID']);
  });

  it('ends the session on logout', async () => {
    const session = await adminSignIn(t, await createAdmin(db, ['analyst']));

    const logout = await adminCall(t, session, 'POST', '/v1/admin/auth/logout');
    const after = await adminCall(t, session, 'GET', '/v1/admin/auth/session');

    expect([logout.statusCode, after.statusCode]).toEqual([204, 401]);
  });

  it('keeps player tokens out of the back office and admin sessions out of player routes', async () => {
    const session = await adminSignIn(t, await createAdmin(db, ['super_admin']));

    const asPlayer = await t.app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      remoteAddress: session.ip,
      headers: { cookie: session.cookie },
    });
    const noSession = await t.app.inject({
      method: 'GET',
      url: '/v1/admin/auth/session',
      remoteAddress: session.ip,
      headers: { authorization: await t.bearerFor(session.adminId) },
    });

    expect([asPlayer.statusCode, noSession.statusCode]).toEqual([401, 401]);
  });

  it('refuses the local login when the API runs with OIDC', async () => {
    const idp = new FakeIdp('reef-admin', 'idp-secret');
    await idp.start();
    const oidcApp = await buildTestApp(
      testEnv({
        ADMIN_LOGIN_MODE: 'oidc',
        ADMIN_OIDC_ISSUER: idp.issuer,
        ADMIN_OIDC_CLIENT_ID: 'reef-admin',
        ADMIN_OIDC_CLIENT_SECRET: 'idp-secret',
        ADMIN_OIDC_REDIRECT_URI: 'http://localhost:4000/v1/admin/auth/oidc/callback',
      }),
    );
    try {
      const response = await devLogin(oidcApp, 'admin@reef.test');
      expect(response.statusCode).toBe(403);
    } finally {
      await oidcApp.app.close();
      await idp.stop();
    }
  });
});

describe('admin SSO (OIDC with PKCE)', () => {
  let idp: FakeIdp;
  let oidcApp: TestApp;

  beforeAll(async () => {
    idp = new FakeIdp('reef-admin', 'idp-secret');
    await idp.start();
    oidcApp = await buildTestApp(
      testEnv({
        ADMIN_LOGIN_MODE: 'oidc',
        ADMIN_OIDC_ISSUER: idp.issuer,
        ADMIN_OIDC_CLIENT_ID: 'reef-admin',
        ADMIN_OIDC_CLIENT_SECRET: 'idp-secret',
        ADMIN_OIDC_REDIRECT_URI: 'http://localhost:4000/v1/admin/auth/oidc/callback',
      }),
    );
  });

  afterAll(async () => {
    await oidcApp.app.close();
    await idp.stop();
  });

  async function ssoLogin(
    identity: Parameters<FakeIdp['authorize']>[1],
    options: { state?: string } = {},
  ) {
    const ip = nextIp();
    const start = await oidcApp.app.inject({
      method: 'GET',
      url: '/v1/admin/auth/oidc/start',
      remoteAddress: ip,
    });
    const location = String(start.headers.location);
    const handle = cookiePairs(start).join('; ');
    const { code, state } = idp.authorize(location, identity);
    const callback = await oidcApp.app.inject({
      method: 'GET',
      url: `/v1/admin/auth/oidc/callback?code=${encodeURIComponent(code)}&state=${encodeURIComponent(options.state ?? state)}`,
      remoteAddress: ip,
      headers: { cookie: handle },
    });
    return { start, location, callback };
  }

  it('sends the browser to the IdP with PKCE, then on to the admin MFA page', async () => {
    const admin = await createAdmin(db, ['analyst']);

    const { start, location, callback } = await ssoLogin({ email: admin.email });

    expect(start.statusCode).toBe(302);
    expect(new URL(location).searchParams.get('code_challenge_method')).toBe('S256');
    expect([callback.statusCode, callback.headers.location]).toEqual([
      302,
      'http://localhost:3001/login/mfa?next=mfa_enrollment_required',
    ]);
    expect(
      cookiePairs(callback).some(
        (pair) => pair.startsWith('__Host-reef_admin_mfa=') && !pair.endsWith('='),
      ),
    ).toBe(true);
  });

  it.each([
    ['a mismatched state', {}, { state: 'forged-state' }],
    ['another audience', { audience: 'someone-else' }, {}],
    ['a wrong nonce', { nonce: 'replayed-nonce' }, {}],
    ['an unverified email', { isEmailVerified: false }, {}],
  ])('refuses %s', async (_label, overrides, options) => {
    const admin = await createAdmin(db, ['analyst']);

    const { callback } = await ssoLogin({ email: admin.email, ...overrides }, options);

    expect(callback.statusCode).toBe(401);
  });

  it('binds the admin to their IdP subject and refuses a different person with the same email', async () => {
    const admin = await createAdmin(db, ['analyst']);

    const first = await ssoLogin({ email: admin.email });
    const again = await ssoLogin({ email: admin.email });
    const impostor = await ssoLogin({ email: admin.email, subject: 'someone-who-got-the-email' });

    expect([first.callback.statusCode, again.callback.statusCode]).toEqual([302, 302]);
    expect(errorCode(impostor.callback)).toBe('INVALID_CREDENTIALS');
  });

  it('refuses an IdP user who is not an admin', async () => {
    const { callback } = await ssoLogin({ email: 'intern@reef.test' });

    expect(errorCode(callback)).toBe('INVALID_CREDENTIALS');
  });
});
