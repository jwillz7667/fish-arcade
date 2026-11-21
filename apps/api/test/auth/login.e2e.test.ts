import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { ErrorBody } from '../../src/http/error-response.js';
import { buildTestApp, type TestApp } from '../http/test-app.js';
import {
  asSession,
  enrollTotp,
  GOOD_PASSWORD,
  MOBILE,
  nextIp,
  post,
  PROFILE,
  signUp,
  totpAt,
  uniqueEmail,
  uniquePhone,
  type InjectResponse,
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

const login = (
  identifier: string,
  password: string,
  ip = nextIp(),
  headers: Record<string, string> = MOBILE,
) => post(t, '/v1/auth/login', { identifier, password }, { ip, headers });

const errorCode = (response: InjectResponse): string => response.json<ErrorBody>().error.code;

// Everything a client could compare, minus the per-request ID.
function observable(response: InjectResponse): unknown {
  const body = response.json<ErrorBody>();
  return {
    status: response.statusCode,
    code: body.error.code,
    message: body.error.message,
    keys: Object.keys(body.error).sort(),
  };
}

describe('password login', () => {
  it('returns tokens in the body for native apps', async () => {
    const account = await signUp(t);

    const response = await login(account.email, account.password);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'authenticated', userId: account.userId });
    expect(response.headers['set-cookie']).toBeUndefined();
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('sets httpOnly, Secure, SameSite=Lax cookies for browsers and keeps the refresh token out of the body', async () => {
    const account = await signUp(t);

    const response = await login(account.email, account.password, nextIp(), {});
    const cookies = [response.headers['set-cookie']].flat().map(String);

    expect(Object.keys(response.json<object>()).sort()).toEqual([
      'accessTokenExpiresAt',
      'csrfToken',
      'status',
      'userId',
    ]);
    expect(cookies.find((cookie) => cookie.startsWith('__Host-reef_at='))).toMatch(
      /Path=\/; Max-Age=600; Secure; SameSite=Lax; HttpOnly$/,
    );
    expect(cookies.find((cookie) => cookie.startsWith('__Secure-reef_rt='))).toMatch(
      /Path=\/v1\/auth; .*Secure; SameSite=Lax; HttpOnly$/,
    );
    expect(cookies.find((cookie) => cookie.startsWith('__Host-reef_csrf='))).not.toMatch(
      /HttpOnly/,
    );
  });

  it('matches the email case-insensitively', async () => {
    const account = await signUp(t);

    const response = await login(account.email.toUpperCase(), account.password);

    expect(response.statusCode).toBe(200);
  });

  it('answers an unknown account exactly like a wrong password', async () => {
    const account = await signUp(t);

    const wrongPassword = await login(account.email, 'not-the-password-at-all');
    const unknown = await login(uniqueEmail(), 'not-the-password-at-all');
    const malformed = await login('not-an-identifier', 'not-the-password-at-all');

    expect(observable(wrongPassword)).toEqual({
      status: 401,
      code: 'INVALID_CREDENTIALS',
      message: 'The sign-in details are incorrect.',
      keys: ['code', 'message', 'requestId'],
    });
    expect(observable(unknown)).toEqual(observable(wrongPassword));
    expect(observable(malformed)).toEqual(observable(wrongPassword));
  });

  it('locks an account identifier after its 6th failure, the same for unknown accounts', async () => {
    const account = await signUp(t);
    const unknown = uniqueEmail();

    const statuses = async (identifier: string) => {
      const results: number[] = [];
      // A new IP per attempt isolates the per-account rule from the per-IP one.
      for (let attempt = 0; attempt < 7; attempt += 1)
        results.push((await login(identifier, 'wrong-password-123')).statusCode);
      return results;
    };
    const known = await statuses(account.email);
    const missing = await statuses(unknown);
    const blockedRight = await login(account.email, account.password);

    // 5 free failures; the 6th sets a 1-second lock that doubles with each later failure.
    expect(known).toEqual([401, 401, 401, 401, 401, 401, 429]);
    expect(missing).toEqual(known);
    expect([blockedRight.statusCode, blockedRight.headers['retry-after']]).toEqual([429, '1']);
  });

  it('backs off per IP across accounts', async () => {
    const ip = nextIp();

    const results: number[] = [];
    for (let attempt = 0; attempt < 22; attempt += 1)
      results.push((await login(uniqueEmail(), 'wrong-password-123', ip)).statusCode);

    expect(results.slice(0, 21).every((status) => status === 401)).toBe(true);
    expect(results[21]).toBe(429);
  });

  it('clears the per-account count after a successful login', async () => {
    const account = await signUp(t);
    for (let attempt = 0; attempt < 4; attempt += 1)
      await login(account.email, 'wrong-password-123');

    await login(account.email, account.password);
    const afterSuccess = [];
    for (let attempt = 0; attempt < 5; attempt += 1)
      afterSuccess.push((await login(account.email, 'wrong-password-123')).statusCode);

    expect(afterSuccess).toEqual([401, 401, 401, 401, 401]);
  });

  it('audits failures without the identifier', async () => {
    const account = await signUp(t);

    await login(account.email, 'wrong-password-123');

    const { rows } = await db.query<{ actor_id: string | null; after: unknown }>(
      `SELECT actor_id, after FROM audit_logs WHERE action = 'auth.login.failed' AND target_id = $1`,
      [account.userId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.actor_id).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(account.email);
  });
});

describe('two-factor login', () => {
  it('asks for a second factor, then signs in with a TOTP code', async () => {
    const account = await signUp(t);
    const { secret } = await enrollTotp(t, account);

    const first = await login(account.email, account.password);
    const { mfaTicket } = first.json<{ status: string; mfaTicket: string }>();
    const second = await post(
      t,
      '/v1/auth/login/mfa',
      { mfaTicket, code: await totpAt(secret, t.auth.clock.now()) },
      { headers: MOBILE },
    );

    expect(first.json()).toMatchObject({ status: 'mfa_required' });
    expect(second.statusCode).toBe(200);
    const info = await t.app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: asSession(second).bearer,
    });
    expect(info.json()).toMatchObject({ amr: ['pwd', 'otp', 'mfa'], isMfaEnabled: true });
  });

  it('refuses a TOTP code that was already used', async () => {
    const account = await signUp(t);
    const { secret } = await enrollTotp(t, account);
    const code = await totpAt(secret, t.auth.clock.now());

    const ticketA = (await login(account.email, account.password)).json<{ mfaTicket: string }>()
      .mfaTicket;
    const ticketB = (await login(account.email, account.password)).json<{ mfaTicket: string }>()
      .mfaTicket;
    const first = await post(t, '/v1/auth/login/mfa', { mfaTicket: ticketA, code });
    const replay = await post(t, '/v1/auth/login/mfa', { mfaTicket: ticketB, code });

    expect([first.statusCode, replay.statusCode, errorCode(replay)]).toEqual([
      200,
      401,
      'OTP_INVALID',
    ]);
  });

  it('accepts each recovery code once', async () => {
    const account = await signUp(t);
    const { recoveryCodes } = await enrollTotp(t, account);
    const [code] = recoveryCodes;

    const ticketA = (await login(account.email, account.password)).json<{ mfaTicket: string }>()
      .mfaTicket;
    const ticketB = (await login(account.email, account.password)).json<{ mfaTicket: string }>()
      .mfaTicket;
    const first = await post(t, '/v1/auth/login/mfa', {
      mfaTicket: ticketA,
      code: code?.toLowerCase(),
    });
    const again = await post(t, '/v1/auth/login/mfa', { mfaTicket: ticketB, code });

    expect(recoveryCodes).toHaveLength(10);
    expect([first.statusCode, again.statusCode]).toEqual([200, 401]);
  });

  it('stores recovery codes and the TOTP secret only in protected form', async () => {
    const account = await signUp(t);
    const { secret, recoveryCodes } = await enrollTotp(t, account);

    const codes = await db.query<{ code_hash: string }>(
      'SELECT code_hash FROM recovery_codes WHERE user_id = $1',
      [account.userId],
    );
    const mfa = await db.query<{ totp_secret_enc: string }>(
      'SELECT totp_secret_enc FROM user_mfa WHERE user_id = $1',
      [account.userId],
    );

    expect(codes.rows).toHaveLength(10);
    expect(JSON.stringify(codes.rows)).not.toContain(recoveryCodes[0]?.replace('-', ''));
    expect(mfa.rows[0]?.totp_secret_enc).not.toContain(secret);
  });

  it('ends an MFA ticket after 5 wrong codes', async () => {
    const account = await signUp(t);
    await enrollTotp(t, account);
    const { mfaTicket } = (await login(account.email, account.password)).json<{
      mfaTicket: string;
    }>();

    const codes: string[] = [];
    for (let attempt = 0; attempt < 6; attempt += 1) {
      codes.push(
        errorCode(await post(t, '/v1/auth/login/mfa', { mfaTicket, code: 'AAAAA-AAAAA' })),
      );
    }

    expect(codes).toEqual([...Array<string>(5).fill('OTP_INVALID'), 'OTP_ATTEMPTS_EXCEEDED']);
  });
});

describe('login edge cases', () => {
  it('signs in with a phone number', async () => {
    const phone = uniquePhone();
    const started = await post(t, '/v1/auth/signup', {
      contact: { channel: 'sms', destination: phone },
      turnstileToken: 'pass',
    });
    const { challengeId } = started.json<{ challengeId: string }>();
    const { signupTicket } = (
      await post(t, '/v1/auth/otp/verify', { challengeId, code: t.auth.outbox.latestCode(phone) })
    ).json<{ signupTicket: string }>();
    await post(t, '/v1/auth/signup/complete', {
      signupTicket,
      profile: PROFILE,
      credential: { type: 'password', password: GOOD_PASSWORD },
    });

    const response = await login(phone, GOOD_PASSWORD);

    expect(response.statusCode).toBe(200);
  });

  it('refuses an unknown or expired MFA ticket', async () => {
    const response = await post(t, '/v1/auth/login/mfa', {
      mfaTicket: 'A'.repeat(43),
      code: '123456',
    });

    expect(response.statusCode).toBe(401);
  });

  it('refuses enrolling TOTP twice, a wrong setup code, and a confirm with no setup', async () => {
    const account = await signUp(t);
    const { secret } = await enrollTotp(t, account);
    const fresh = await signUp(t);

    const again = await post(
      t,
      '/v1/auth/2fa/totp/setup',
      {},
      {
        headers: { ...account.bearer, 'x-step-up-code': await totpAt(secret, t.auth.clock.now()) },
      },
    );
    await post(t, '/v1/auth/2fa/totp/setup', {}, { headers: fresh.bearer });
    const wrong = await post(
      t,
      '/v1/auth/2fa/totp/confirm',
      { code: '000000' },
      { headers: fresh.bearer },
    );
    const unstarted = await post(
      t,
      '/v1/auth/2fa/totp/confirm',
      { code: '000000' },
      {
        headers: (await signUp(t)).bearer,
      },
    );

    expect(again.statusCode).toBe(409);
    expect(errorCode(wrong)).toBe('OTP_INVALID');
    expect(errorCode(unstarted)).toBe('OTP_EXPIRED');
  });
});
