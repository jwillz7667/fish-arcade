import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ErrorBody } from '../../src/http/error-response.js';
import { buildTestApp, type TestApp } from '../http/test-app.js';
import {
  asSession,
  enrollTotp,
  MOBILE,
  post,
  signUp,
  totpAt,
  uniqueEmail,
  type InjectResponse,
} from '../support/auth-flows.js';

let t: TestApp;

beforeAll(async () => {
  t = await buildTestApp();
});

afterAll(async () => {
  await t.app.close();
});

const errorCode = (response: InjectResponse): string => response.json<ErrorBody>().error.code;
const sensitive = (headers: Record<string, string>) =>
  post(t, '/v1/test/sensitive', {}, { headers });

/** A signed-up player with TOTP, and a code for the next time step that was not used yet. */
async function enrolled() {
  const session = await signUp(t);
  const { secret, recoveryCodes } = await enrollTotp(t, session);
  return { session, secret, recoveryCodes, code: await totpAt(secret, t.auth.clock.now()) };
}

describe('step-up', () => {
  it('passes with a fresh login and a valid TOTP code', async () => {
    const { session, code } = await enrolled();

    const response = await sensitive({ ...session.bearer, 'x-step-up-code': code });

    expect(response.statusCode).toBe(201);
  });

  it('passes with a recovery code', async () => {
    const { session, recoveryCodes } = await enrolled();

    const response = await sensitive({
      ...session.bearer,
      'x-step-up-code': recoveryCodes[0] ?? '',
    });

    expect(response.statusCode).toBe(201);
  });

  it('requires a code', async () => {
    const { session } = await enrolled();

    const response = await sensitive(session.bearer);

    expect([response.statusCode, errorCode(response)]).toEqual([401, 'STEP_UP_REQUIRED']);
  });

  it('rejects a wrong code', async () => {
    const { session, code } = await enrolled();
    const wrong = code === '000000' ? '000001' : '000000';

    const response = await sensitive({ ...session.bearer, 'x-step-up-code': wrong });

    expect([response.statusCode, errorCode(response)]).toEqual([401, 'OTP_INVALID']);
  });

  it('requires a login within the last 5 minutes, even with a valid code', async () => {
    const { session, secret } = await enrolled();

    t.auth.clock.advance(5 * 60_000 + 1_000);
    const response = await sensitive({
      ...session.bearer,
      'x-step-up-code': await totpAt(secret, t.auth.clock.now()),
    });

    expect([response.statusCode, errorCode(response)]).toEqual([401, 'STEP_UP_REQUIRED']);
  });

  it('is not satisfied by refreshing an old session', async () => {
    const { session, secret } = await enrolled();

    t.auth.clock.advance(5 * 60_000 + 1_000);
    const refreshed = asSession(
      await post(
        t,
        '/v1/auth/refresh',
        { refreshToken: session.refreshToken },
        { headers: MOBILE },
      ),
    );
    const response = await sensitive({
      ...refreshed.bearer,
      'x-step-up-code': await totpAt(secret, t.auth.clock.now()),
    });

    expect(errorCode(response)).toBe('STEP_UP_REQUIRED');
  });

  it('refuses players without 2FA', async () => {
    const session = await signUp(t);

    const response = await sensitive({ ...session.bearer, 'x-step-up-code': '123456' });

    expect([response.statusCode, errorCode(response)]).toEqual([403, 'MFA_NOT_ENROLLED']);
  });
});

describe('routes behind step-up', () => {
  it('disabling 2FA needs step-up, then turns it off and signs out other sessions', async () => {
    const { session, code, recoveryCodes } = await enrolled();
    // A second device, signed in with a recovery code.
    const { mfaTicket } = (
      await post(t, '/v1/auth/login', { identifier: session.email, password: session.password })
    ).json<{ mfaTicket: string }>();
    const otherDevice = asSession(
      await post(
        t,
        '/v1/auth/login/mfa',
        { mfaTicket, code: recoveryCodes[0] },
        { headers: MOBILE },
      ),
    );
    const whoAmI = (bearer: Record<string, string>) =>
      t.app.inject({ method: 'GET', url: '/v1/auth/session', headers: bearer });

    const denied = await post(t, '/v1/auth/2fa/totp/disable', {}, { headers: session.bearer });
    const allowed = await post(
      t,
      '/v1/auth/2fa/totp/disable',
      {},
      {
        headers: { ...session.bearer, 'x-step-up-code': code },
      },
    );

    expect([denied.statusCode, allowed.statusCode]).toEqual([401, 204]);
    expect((await whoAmI(session.bearer)).json()).toMatchObject({ isMfaEnabled: false });
    expect((await whoAmI(otherDevice.bearer)).statusCode).toBe(401);
  });

  it('changing email needs step-up and a code sent to the new address', async () => {
    const { session, code } = await enrolled();
    const newEmail = uniqueEmail();

    const denied = await post(
      t,
      '/v1/auth/contact',
      { contact: { channel: 'email', destination: newEmail } },
      { headers: session.bearer },
    );
    const started = await post(
      t,
      '/v1/auth/contact',
      { contact: { channel: 'email', destination: newEmail } },
      {
        headers: { ...session.bearer, 'x-step-up-code': code },
      },
    );
    const { challengeId } = started.json<{ challengeId: string }>();
    const verified = await post(
      t,
      '/v1/auth/contact/verify',
      { challengeId, code: t.auth.outbox.latestCode(newEmail) },
      { headers: session.bearer },
    );
    const login = await post(
      t,
      '/v1/auth/login',
      { identifier: newEmail, password: session.password },
      { headers: MOBILE },
    );

    expect([denied.statusCode, started.statusCode, verified.statusCode]).toEqual([401, 202, 204]);
    expect(login.json()).toMatchObject({ status: 'mfa_required' });
  });

  it('sends nothing for an address that belongs to another account, and the change never verifies', async () => {
    const { session, code } = await enrolled();
    const taken = await signUp(t);
    const before = t.auth.outbox.to(taken.email).length;

    const started = await post(
      t,
      '/v1/auth/contact',
      { contact: { channel: 'email', destination: taken.email } },
      {
        headers: { ...session.bearer, 'x-step-up-code': code },
      },
    );
    const { challengeId } = started.json<{ challengeId: string }>();
    const guess = await post(
      t,
      '/v1/auth/contact/verify',
      { challengeId, code: '123456' },
      { headers: session.bearer },
    );

    expect(started.statusCode).toBe(202);
    expect(t.auth.outbox.to(taken.email)).toHaveLength(before);
    expect(errorCode(guess)).toBe('OTP_INVALID');
  });

  it("refuses to verify another player's contact change", async () => {
    const { session, code } = await enrolled();
    const intruder = await signUp(t);
    const newEmail = uniqueEmail();

    const started = await post(
      t,
      '/v1/auth/contact',
      { contact: { channel: 'email', destination: newEmail } },
      {
        headers: { ...session.bearer, 'x-step-up-code': code },
      },
    );
    const { challengeId } = started.json<{ challengeId: string }>();
    const hijack = await post(
      t,
      '/v1/auth/contact/verify',
      { challengeId, code: t.auth.outbox.latestCode(newEmail) },
      { headers: intruder.bearer },
    );

    expect(errorCode(hijack)).toBe('OTP_INVALID');
  });
});

describe('adding a second factor', () => {
  it('needs a recent login to start TOTP enrolment, so a stolen token cannot plant one', async () => {
    const session = await signUp(t);

    t.auth.clock.advance(5 * 60_000 + 1_000);
    const response = await post(t, '/v1/auth/2fa/totp/setup', {}, { headers: session.bearer });

    expect([response.statusCode, errorCode(response)]).toEqual([401, 'STEP_UP_REQUIRED']);
  });

  it('needs a 2FA code to add a passkey once 2FA is on', async () => {
    const { session, code } = await enrolled();

    const without = await post(t, '/v1/auth/passkeys/options', {}, { headers: session.bearer });
    const withCode = await post(
      t,
      '/v1/auth/passkeys/options',
      {},
      {
        headers: { ...session.bearer, 'x-step-up-code': code },
      },
    );

    expect([without.statusCode, errorCode(without), withCode.statusCode]).toEqual([
      401,
      'STEP_UP_REQUIRED',
      200,
    ]);
  });
});
