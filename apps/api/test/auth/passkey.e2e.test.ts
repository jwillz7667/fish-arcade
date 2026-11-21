import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import type { ErrorBody } from '../../src/http/error-response.js';
import { buildTestApp, type TestApp } from '../http/test-app.js';
import {
  asSession,
  MOBILE,
  post,
  signupPost,
  PROFILE,
  signUp,
  uniqueEmail,
  verifiedSignupTicket,
  type InjectResponse,
} from '../support/auth-flows.js';
import { SoftAuthenticator } from '../support/soft-authenticator.js';

const ORIGIN = 'http://localhost:3000';

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

/** Signs up with a passkey instead of a password. */
async function signUpWithPasskey(authenticator: SoftAuthenticator): Promise<InjectResponse> {
  const signupTicket = await verifiedSignupTicket(t, uniqueEmail());
  const options = await post(t, '/v1/auth/signup/passkey-options', {
    signupTicket,
    displayName: PROFILE.displayName,
  });
  const response = authenticator.register(options.json<{ challenge: string }>());
  return signupPost(
    t,
    '/v1/auth/signup/complete',
    { signupTicket, profile: PROFILE, credential: { type: 'passkey', response } },
    { headers: MOBILE },
  );
}

async function passkeyLogin(
  authenticator: SoftAuthenticator,
  origin = ORIGIN,
): Promise<InjectResponse> {
  const started = await post(t, '/v1/auth/passkey/options', {});
  const { challengeId, options } = started.json<{
    challengeId: string;
    options: { challenge: string; allowCredentials?: unknown };
  }>();
  expect(options.allowCredentials).toBeUndefined();
  return post(
    t,
    '/v1/auth/passkey/login',
    { challengeId, response: authenticator.authenticate(options.challenge, { origin }) },
    { headers: MOBILE },
  );
}

describe('passkeys', () => {
  it('signs up with a passkey and signs in with it', async () => {
    const authenticator = new SoftAuthenticator('localhost', ORIGIN);

    const signup = await signUpWithPasskey(authenticator);
    const login = await passkeyLogin(authenticator);

    expect([signup.statusCode, login.statusCode]).toEqual([201, 200]);
    expect(asSession(login).userId).toBe(asSession(signup).userId);
    const info = await t.app.inject({
      method: 'GET',
      url: '/v1/auth/session',
      headers: asSession(login).bearer,
    });
    expect(info.json()).toMatchObject({ amr: ['hwk', 'mfa'] });
  });

  it('refuses a passkey login to a closed account', async () => {
    const authenticator = new SoftAuthenticator('localhost', ORIGIN);
    const signup = await signUpWithPasskey(authenticator);
    await db.query(`UPDATE users SET status = 'closed' WHERE id = $1`, [asSession(signup).userId]);

    const login = await passkeyLogin(authenticator);

    expect([login.statusCode, errorCode(login)]).toEqual([401, 'INVALID_CREDENTIALS']);
  });

  it('adds a passkey to a password account', async () => {
    const session = await signUp(t);
    const authenticator = new SoftAuthenticator('localhost', ORIGIN);

    const options = await post(t, '/v1/auth/passkeys/options', {}, { headers: session.bearer });
    const registered = await post(
      t,
      '/v1/auth/passkeys',
      { response: authenticator.register(options.json<{ challenge: string }>()) },
      { headers: session.bearer },
    );
    const login = await passkeyLogin(authenticator);

    expect([registered.statusCode, asSession(login).userId]).toEqual([201, session.userId]);
  });

  it('refuses an assertion made for another origin', async () => {
    const authenticator = new SoftAuthenticator('localhost', ORIGIN);
    await signUpWithPasskey(authenticator);

    const response = await passkeyLogin(authenticator, 'https://phish.example');

    expect([response.statusCode, errorCode(response)]).toEqual([401, 'INVALID_CREDENTIALS']);
  });

  it('refuses a signature counter that went backwards (a cloned authenticator)', async () => {
    const authenticator = new SoftAuthenticator('localhost', ORIGIN);
    await signUpWithPasskey(authenticator);
    await passkeyLogin(authenticator);
    await passkeyLogin(authenticator);

    authenticator.setCounter(0);
    const response = await passkeyLogin(authenticator);

    expect(errorCode(response)).toBe('INVALID_CREDENTIALS');
  });

  it('spends each login challenge once', async () => {
    const authenticator = new SoftAuthenticator('localhost', ORIGIN);
    await signUpWithPasskey(authenticator);
    const started = await post(t, '/v1/auth/passkey/options', {});
    const { challengeId, options } = started.json<{
      challengeId: string;
      options: { challenge: string };
    }>();
    const body = { challengeId, response: authenticator.authenticate(options.challenge) };

    const [first, replay] = [
      await post(t, '/v1/auth/passkey/login', body),
      await post(t, '/v1/auth/passkey/login', body),
    ];

    expect([first.statusCode, replay.statusCode]).toEqual([200, 401]);
  });

  it('refuses an unknown credential', async () => {
    const stranger = new SoftAuthenticator('localhost', ORIGIN);

    const response = await passkeyLogin(stranger);

    expect(errorCode(response)).toBe('INVALID_CREDENTIALS');
  });
});

describe('passkey edge cases', () => {
  it('refuses a password login for a passkey-only account, like any wrong password', async () => {
    const authenticator = new SoftAuthenticator('localhost', ORIGIN);
    const email = uniqueEmail();
    const signupTicket = await verifiedSignupTicket(t, email);
    const options = await post(t, '/v1/auth/signup/passkey-options', {
      signupTicket,
      displayName: PROFILE.displayName,
    });
    await signupPost(t, '/v1/auth/signup/complete', {
      signupTicket,
      profile: PROFILE,
      credential: {
        type: 'passkey',
        response: authenticator.register(options.json<{ challenge: string }>()),
      },
    });

    const response = await post(t, '/v1/auth/login', {
      identifier: email,
      password: 'any-password-at-all',
    });

    expect([response.statusCode, errorCode(response)]).toEqual([401, 'INVALID_CREDENTIALS']);
  });

  it('refuses registering the same passkey twice', async () => {
    const session = await signUp(t);
    const authenticator = new SoftAuthenticator('localhost', ORIGIN);
    const register = async () => {
      const options = await post(t, '/v1/auth/passkeys/options', {}, { headers: session.bearer });
      return post(
        t,
        '/v1/auth/passkeys',
        { response: authenticator.register(options.json<{ challenge: string }>()) },
        {
          headers: session.bearer,
        },
      );
    };

    const [first, second] = [await register(), await register()];

    expect([first.statusCode, second.statusCode]).toEqual([201, 409]);
  });

  it('refuses finishing a registration that was never started', async () => {
    const session = await signUp(t);
    const authenticator = new SoftAuthenticator('localhost', ORIGIN);

    const response = await post(
      t,
      '/v1/auth/passkeys',
      { response: authenticator.register({ challenge: 'abc' }) },
      {
        headers: session.bearer,
      },
    );

    expect(errorCode(response)).toBe('INVALID_CREDENTIALS');
  });
});
