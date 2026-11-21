import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { ErrorBody } from '../../src/http/error-response.js';
import { buildTestApp, type TestApp } from '../http/test-app.js';
import {
  asSession,
  MOBILE,
  nextIp,
  post,
  signUp,
  type InjectResponse,
  type MobileSession,
} from '../support/auth-flows.js';

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
const refresh = (refreshToken: string) =>
  post(t, '/v1/auth/refresh', { refreshToken }, { headers: MOBILE });
const whoAmI = (session: MobileSession) =>
  t.app.inject({ method: 'GET', url: '/v1/auth/session', headers: session.bearer });

/** Browser login: returns the cookie header to send back and the CSRF token. */
async function browserLogin(): Promise<{
  cookie: string;
  csrfToken: string;
  refreshCookie: string;
}> {
  const account = await signUp(t);
  const response = await post(t, '/v1/auth/login', {
    identifier: account.email,
    password: account.password,
  });
  const cookies = [response.headers['set-cookie']]
    .flat()
    .map((cookie) => String(cookie).split(';')[0] ?? '');
  return {
    cookie: cookies.join('; '),
    csrfToken: response.json<{ csrfToken: string }>().csrfToken,
    refreshCookie: cookies.find((cookie) => cookie.startsWith('__Secure-reef_rt=')) ?? '',
  };
}

describe('refresh tokens', () => {
  it('rotates on every use: the new token works and the old one is spent', async () => {
    const session = await signUp(t);

    const rotated = await refresh(session.refreshToken);
    const next = asSession(rotated);

    expect(rotated.statusCode).toBe(200);
    expect(next.refreshToken).not.toBe(session.refreshToken);
    expect((await whoAmI(next)).statusCode).toBe(200);
  });

  it('stores refresh tokens only as hashes', async () => {
    const session = await signUp(t);

    const { rows } = await db.query<{ token_hash: string }>(
      'SELECT rt.token_hash FROM refresh_tokens rt JOIN auth_sessions s ON s.id = rt.session_id WHERE s.user_id = $1',
      [session.userId],
    );

    expect(rows.map((row) => row.token_hash)).not.toContain(session.refreshToken);
    expect(rows[0]?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('treats reuse of a spent token as theft and revokes the whole family', async () => {
    const session = await signUp(t);
    const next = asSession(await refresh(session.refreshToken));

    const reused = await refresh(session.refreshToken);
    const latest = await refresh(next.refreshToken);
    const access = await whoAmI(next);

    expect([reused.statusCode, latest.statusCode, access.statusCode]).toEqual([401, 401, 401]);
    const { rows } = await db.query<{ revoke_reason: string }>(
      'SELECT revoke_reason FROM auth_sessions WHERE user_id = $1',
      [session.userId],
    );
    expect(rows.map((row) => row.revoke_reason)).toEqual(['refresh_token_reuse']);
    const audit = await db.query('SELECT 1 FROM audit_logs WHERE action = $1 AND actor_id = $2', [
      'auth.refresh.reuse_detected',
      session.userId,
    ]);
    expect(audit.rowCount).toBe(1);
  });

  it('lets at most one of two concurrent refreshes win, and the race revokes the family', async () => {
    const session = await signUp(t);

    const results = await Promise.all([
      refresh(session.refreshToken),
      refresh(session.refreshToken),
    ]);
    const winner = results.find((response) => response.statusCode === 200);

    expect(results.map((response) => response.statusCode).sort()).toEqual([200, 401]);
    expect(
      winner === undefined ? 401 : (await refresh(asSession(winner).refreshToken)).statusCode,
    ).toBe(401);
  });

  it('keeps the original login time across refreshes, so refresh never satisfies step-up', async () => {
    const session = await signUp(t);
    const before = (await whoAmI(session)).json<{ authTime: string }>().authTime;

    t.auth.clock.advance(2_000);
    const next = asSession(await refresh(session.refreshToken));

    expect((await whoAmI(next)).json<{ authTime: string }>().authTime).toBe(before);
  });

  it('rejects unknown and malformed tokens', async () => {
    const unknown = await refresh('A'.repeat(43));
    const malformed = await refresh('nope');

    expect([unknown.statusCode, malformed.statusCode]).toEqual([401, 400]);
  });
});

describe('CSRF for cookie sessions', () => {
  it('refuses a cookie-authenticated write without the CSRF header', async () => {
    const browser = await browserLogin();

    const response = await post(t, '/v1/test/write', {}, { headers: { cookie: browser.cookie } });

    expect([response.statusCode, errorCode(response)]).toEqual([403, 'CSRF_INVALID']);
  });

  it('refuses a CSRF token from another session', async () => {
    const [victim, attacker] = [await browserLogin(), await browserLogin()];

    const response = await post(
      t,
      '/v1/test/write',
      {},
      { headers: { cookie: victim.cookie, 'x-csrf-token': attacker.csrfToken } },
    );

    expect(errorCode(response)).toBe('CSRF_INVALID');
  });

  it('accepts the write with the session CSRF token, and reads without one', async () => {
    const browser = await browserLogin();

    const write = await post(
      t,
      '/v1/test/write',
      {},
      { headers: { cookie: browser.cookie, 'x-csrf-token': browser.csrfToken } },
    );
    const read = await t.app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { cookie: browser.cookie },
    });

    expect([write.statusCode, read.statusCode]).toEqual([201, 200]);
  });

  it('requires the CSRF header to refresh from the cookie', async () => {
    const browser = await browserLogin();

    const without = await post(
      t,
      '/v1/auth/refresh',
      {},
      { headers: { cookie: browser.refreshCookie } },
    );
    const withToken = await post(
      t,
      '/v1/auth/refresh',
      {},
      {
        headers: { cookie: browser.refreshCookie, 'x-csrf-token': browser.csrfToken },
      },
    );

    expect([without.statusCode, errorCode(without)]).toEqual([403, 'CSRF_INVALID']);
    expect(withToken.statusCode).toBe(200);
  });

  it('does not require CSRF for bearer tokens, which browsers never attach on their own', async () => {
    const session = await signUp(t);

    const response = await post(t, '/v1/test/write', {}, { headers: session.bearer });

    expect(response.statusCode).toBe(201);
  });
});

describe('logout and access', () => {
  it('revokes the session: its access and refresh tokens stop working at once', async () => {
    const session = await signUp(t);

    const logout = await post(
      t,
      '/v1/auth/logout',
      { refreshToken: session.refreshToken },
      { headers: MOBILE },
    );

    expect(logout.statusCode).toBe(204);
    expect([
      (await whoAmI(session)).statusCode,
      (await refresh(session.refreshToken)).statusCode,
    ]).toEqual([401, 401]);
  });

  it('clears browser cookies on logout', async () => {
    const browser = await browserLogin();

    const response = await post(
      t,
      '/v1/auth/logout',
      {},
      {
        headers: { cookie: browser.refreshCookie, 'x-csrf-token': browser.csrfToken },
      },
    );

    expect(
      [response.headers['set-cookie']]
        .flat()
        .every((cookie) => String(cookie).includes('Max-Age=0')),
    ).toBe(true);
  });

  it('denies by default: routes without @Public need a token', async () => {
    const anonymous = await t.app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      remoteAddress: nextIp(),
    });
    const garbage = await t.app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { authorization: 'Bearer not.a.jwt' },
    });
    const scheme = await t.app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: { authorization: 'Basic abc' },
    });

    expect([anonymous.statusCode, garbage.statusCode, scheme.statusCode]).toEqual([401, 401, 401]);
  });

  it('expires access tokens after 10 minutes', async () => {
    const session = await signUp(t);

    t.auth.clock.advance(10 * 60_000 + 1_000);

    expect((await whoAmI(session)).statusCode).toBe(401);
  });
});

describe('refresh and logout without a token', () => {
  it('refuses a refresh with no token and treats a token-less logout as done', async () => {
    const refreshed = await post(t, '/v1/auth/refresh', {});
    const logout = await post(t, '/v1/auth/logout', {});

    expect([refreshed.statusCode, logout.statusCode]).toEqual([401, 204]);
  });

  it('clears cookies when a cookie refresh fails', async () => {
    const response = await post(
      t,
      '/v1/auth/refresh',
      {},
      {
        headers: { cookie: `__Secure-reef_rt=${'A'.repeat(43)}`, 'x-csrf-token': 'x' },
      },
    );

    expect(response.statusCode).toBe(401);
    expect(
      [response.headers['set-cookie']]
        .flat()
        .every((cookie) => String(cookie).includes('Max-Age=0')),
    ).toBe(true);
  });
});
