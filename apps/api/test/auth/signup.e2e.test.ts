import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { ErrorBody } from '../../src/http/error-response.js';
import { buildTestApp, type TestApp } from '../http/test-app.js';
import {
  GOOD_PASSWORD,
  MOBILE,
  nextIp,
  post,
  signupPost,
  PROFILE,
  signUp,
  uniqueEmail,
  uniquePhone,
  verifiedSignupTicket,
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

const startSignup = (destination: string, channel: 'email' | 'sms' = 'email', ip = nextIp()) =>
  signupPost(
    t,
    '/v1/auth/signup',
    { contact: { channel, destination }, turnstileToken: 'pass' },
    { ip },
  );

const errorCode = (response: InjectResponse): string => response.json<ErrorBody>().error.code;

async function challengeFor(destination: string): Promise<string> {
  const channel = destination.startsWith('+') ? 'sms' : 'email';
  return (await startSignup(destination, channel)).json<{ challengeId: string }>().challengeId;
}

describe('signup', () => {
  it('creates an account from email, code, profile, and password, and signs it in', async () => {
    const email = uniqueEmail();

    const session = await signUp(t, email);
    const info = await t.app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: session.bearer,
    });

    expect(info.json()).toMatchObject({
      userId: session.userId,
      amr: ['otp', 'pwd'],
      isMfaEnabled: false,
    });
    const { rows } = await db.query<{ email_enc: string; password_hash: string }>(
      'SELECT email_enc, password_hash FROM users WHERE id = $1',
      [session.userId],
    );
    expect(rows[0]?.email_enc.startsWith('v1.')).toBe(true);
    expect(rows[0]?.email_enc).not.toContain(email);
    expect(rows[0]?.password_hash.startsWith('$argon2id$')).toBe(true);
  });

  it('signs up by phone, with the code sent by SMS', async () => {
    const phone = uniquePhone();
    const challengeId = await challengeFor(phone);

    const verified = await post(t, '/v1/auth/otp/verify', {
      challengeId,
      code: t.auth.outbox.latestCode(phone),
    });

    expect(verified.statusCode).toBe(200);
    expect(t.auth.outbox.to(phone).map((message) => message.channel)).toEqual(['sms']);
  });

  it('answers identically for an address that already has an account, and sends no code', async () => {
    const { email } = await signUp(t);
    const fresh = uniqueEmail();

    const [taken, open] = [await startSignup(email), await startSignup(fresh)];

    expect([taken.statusCode, Object.keys(taken.json<object>())]).toEqual([
      open.statusCode,
      Object.keys(open.json<object>()),
    ]);
    expect(t.auth.outbox.to(email).at(-1)?.text).not.toMatch(/\d{6}/);
    expect(t.auth.outbox.to(email).at(-1)?.subject).toMatch(/tried to sign up/);
  });

  it('never lets a challenge for an existing account verify', async () => {
    const { email } = await signUp(t);
    const challengeId = await challengeFor(email);

    const guesses = await Promise.all(
      ['000000', '123456', '999999'].map((code) =>
        post(t, '/v1/auth/otp/verify', { challengeId, code }),
      ),
    );

    expect(guesses.map(errorCode)).toEqual(['OTP_INVALID', 'OTP_INVALID', 'OTP_INVALID']);
  });

  it('rejects a failed bot check before sending anything', async () => {
    const email = uniqueEmail();

    const response = await signupPost(t, '/v1/auth/signup', {
      contact: { channel: 'email', destination: email },
      turnstileToken: 'bot',
    });

    expect([response.statusCode, errorCode(response)]).toEqual([403, 'BOT_CHECK_FAILED']);
    expect(t.auth.outbox.to(email)).toEqual([]);
  });

  it('rejects a breached password and keeps the ticket usable', async () => {
    const signupTicket = await verifiedSignupTicket(t, uniqueEmail());
    const complete = (password: string) =>
      signupPost(
        t,
        '/v1/auth/signup/complete',
        { signupTicket, profile: PROFILE, credential: { type: 'password', password } },
        { headers: MOBILE },
      );

    const breached = await complete('correct horse battery staple');
    const retried = await complete(GOOD_PASSWORD);

    expect([breached.statusCode, breached.json<ErrorBody>().error.issues]).toEqual([
      400,
      [{ path: 'password', message: expect.stringMatching(/breach/) }],
    ]);
    expect(retried.statusCode).toBe(201);
  });

  it('rejects passwords under 12 characters', async () => {
    const signupTicket = await verifiedSignupTicket(t, uniqueEmail());

    const response = await signupPost(t, '/v1/auth/signup/complete', {
      signupTicket,
      profile: PROFILE,
      credential: { type: 'password', password: 'short-pw-11' },
    });

    expect(response.json<ErrorBody>().error.issues?.map((issue) => issue.path)).toEqual([
      'credential.password',
    ]);
  });

  it('blocks players under 18 (spec §5.1)', async () => {
    const signupTicket = await verifiedSignupTicket(t, uniqueEmail());
    const now = t.auth.clock.now();
    const seventeen = `${String(now.getUTCFullYear() - 17)}-01-01`;

    const response = await signupPost(t, '/v1/auth/signup/complete', {
      signupTicket,
      profile: { ...PROFILE, dateOfBirth: seventeen },
      credential: { type: 'password', password: GOOD_PASSWORD },
    });

    expect([response.statusCode, errorCode(response)]).toEqual([403, 'COMPLIANCE_BLOCKED']);
  });

  it('spends the signup ticket once', async () => {
    const signupTicket = await verifiedSignupTicket(t, uniqueEmail());
    const body = {
      signupTicket,
      profile: PROFILE,
      credential: { type: 'password', password: GOOD_PASSWORD },
    };

    const [first, second] = [
      await signupPost(t, '/v1/auth/signup/complete', body),
      await signupPost(t, '/v1/auth/signup/complete', body),
    ];

    expect([first.statusCode, second.statusCode]).toEqual([201, 401]);
  });
});

describe('one-time codes', () => {
  it('rejects a wrong code, then accepts the right one', async () => {
    const email = uniqueEmail();
    const challengeId = await challengeFor(email);
    const code = t.auth.outbox.latestCode(email);
    const wrong = code === '000000' ? '000001' : '000000';

    const bad = await post(t, '/v1/auth/otp/verify', { challengeId, code: wrong });
    const good = await post(t, '/v1/auth/otp/verify', { challengeId, code });

    expect([bad.statusCode, errorCode(bad), good.statusCode]).toEqual([401, 'OTP_INVALID', 200]);
  });

  it('allows 5 attempts, then refuses even the right code', async () => {
    const email = uniqueEmail();
    const challengeId = await challengeFor(email);
    const code = t.auth.outbox.latestCode(email);
    const wrong = code === '000000' ? '000001' : '000000';

    const failures = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      failures.push(errorCode(await post(t, '/v1/auth/otp/verify', { challengeId, code: wrong })));
    }
    const right = await post(t, '/v1/auth/otp/verify', { challengeId, code });

    expect(failures).toEqual(Array(5).fill('OTP_INVALID'));
    expect(errorCode(right)).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('caps attempts under concurrent guessing', async () => {
    const email = uniqueEmail();
    const challengeId = await challengeFor(email);
    const code = t.auth.outbox.latestCode(email);
    const wrong = code === '000000' ? '000001' : '000000';

    await Promise.all(
      Array.from({ length: 12 }, () =>
        post(t, '/v1/auth/otp/verify', { challengeId, code: wrong }),
      ),
    );
    const { rows } = await db.query<{ attempts: number }>(
      'SELECT attempts FROM otp_challenges WHERE id = $1',
      [challengeId],
    );
    const right = await post(t, '/v1/auth/otp/verify', { challengeId, code });

    expect(rows[0]?.attempts).toBe(5);
    expect(errorCode(right)).toBe('OTP_ATTEMPTS_EXCEEDED');
  });

  it('expires codes after 10 minutes', async () => {
    const email = uniqueEmail();
    const challengeId = await challengeFor(email);
    const code = t.auth.outbox.latestCode(email);

    t.auth.clock.advance(10 * 60_000 + 1_000);
    const response = await post(t, '/v1/auth/otp/verify', { challengeId, code });

    expect(errorCode(response)).toBe('OTP_EXPIRED');
  });

  it('holds resends for 60 seconds, then sends a new code that replaces the old one', async () => {
    const email = uniqueEmail();
    const challengeId = await challengeFor(email);
    const firstCode = t.auth.outbox.latestCode(email);

    const early = await post(t, '/v1/auth/otp/resend', { challengeId });
    t.auth.clock.advance(60_000);
    const resent = await post(t, '/v1/auth/otp/resend', { challengeId });
    const secondCode = t.auth.outbox.latestCode(email);
    const old =
      firstCode === secondCode
        ? undefined
        : await post(t, '/v1/auth/otp/verify', { challengeId, code: firstCode });
    const fresh = await post(t, '/v1/auth/otp/verify', { challengeId, code: secondCode });

    expect([early.statusCode, early.headers['retry-after']]).toEqual([429, '60']);
    expect(resent.statusCode).toBe(202);
    expect(old === undefined ? 'OTP_INVALID' : errorCode(old)).toBe('OTP_INVALID');
    expect(fresh.statusCode).toBe(200);
  });

  it('stores codes only as keyed hashes', async () => {
    const email = uniqueEmail();
    const challengeId = await challengeFor(email);
    const code = t.auth.outbox.latestCode(email);

    const { rows } = await db.query<{ code_hash: string; destination_enc: string }>(
      'SELECT code_hash, destination_enc FROM otp_challenges WHERE id = $1',
      [challengeId],
    );

    expect(rows[0]?.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0]?.code_hash).not.toContain(code);
    expect(rows[0]?.destination_enc).not.toContain(email);
  });
});

describe('audit', () => {
  it('records signup actions without PII', async () => {
    const email = uniqueEmail();

    const session = await signUp(t, email);

    const { rows } = await db.query<{ action: string; after: unknown }>(
      `SELECT action, after FROM audit_logs
        WHERE actor_id = $1 OR target_id = $1 OR after->>'challengeId' IN (
          SELECT id::text FROM otp_challenges WHERE created_at > now() - interval '1 minute')
        ORDER BY id`,
      [session.userId],
    );
    const actions = rows.map((row) => row.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'auth.signup.started',
        'auth.otp.verified',
        'auth.signup.completed',
        'auth.session.started',
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain(email);
  });
});

describe('resend limits and unknown challenges', () => {
  it('stops resending after 5 sends in total', async () => {
    const email = uniqueEmail();
    const challengeId = await challengeFor(email);

    const statuses: number[] = [];
    for (let send = 0; send < 5; send += 1) {
      t.auth.clock.advance(60_000);
      const response = await post(t, '/v1/auth/otp/resend', { challengeId });
      statuses.push(response.statusCode);
    }

    expect(statuses.slice(0, 4)).toEqual([202, 202, 202, 202]);
    expect(statuses[4]).toBe(401);
    expect(t.auth.outbox.to(email)).toHaveLength(5);
  });

  it('treats an unknown challenge like a wrong code', async () => {
    const id = '00000000-0000-4000-8000-000000000000';

    const verify = await post(t, '/v1/auth/otp/verify', { challengeId: id, code: '123456' });
    const resend = await post(t, '/v1/auth/otp/resend', { challengeId: id });

    expect([errorCode(verify), errorCode(resend)]).toEqual(['OTP_INVALID', 'OTP_INVALID']);
  });

  it('refuses a passkey signup that never asked for passkey options', async () => {
    const signupTicket = await verifiedSignupTicket(t, uniqueEmail());

    const response = await signupPost(t, '/v1/auth/signup/complete', {
      signupTicket,
      profile: PROFILE,
      credential: {
        type: 'passkey',
        response: {
          id: 'abc',
          rawId: 'abc',
          type: 'public-key',
          response: { clientDataJSON: 'e30', attestationObject: 'oA' },
          clientExtensionResults: {},
        },
      },
    });

    expect(response.statusCode).toBe(401);
  });
});
