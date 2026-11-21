import { randomInt, randomUUID } from 'node:crypto';

import { generate } from 'otplib';

import type { TestApp } from '../http/test-app.js';

/** A light-injection response, as returned by `app.inject`. */
export type InjectResponse = Awaited<ReturnType<TestApp['app']['inject']>>;

/**
 * @returns A random client IP, so per-IP backoff from one test (or an earlier run within the
 *   backoff window) never leaks into another.
 */
export function nextIp(): string {
  return `10.${String(randomInt(256))}.${String(randomInt(256))}.${String(randomInt(1, 255))}`;
}

/** @returns An email address no other test uses. */
export const uniqueEmail = (): string => `player-${randomUUID()}@example.com`;

/** @returns An E.164 number no other test is likely to use. */
export const uniquePhone = (): string => `+1555${String(randomInt(1_000_000, 9_999_999))}`;

/** A strong password that the breach double does not list. */
export const GOOD_PASSWORD = 'tidal-anemone-lantern-42';

/** JSON POST through Fastify's injector. */
export function post(
  t: TestApp,
  url: string,
  body: unknown,
  options: { headers?: Record<string, string>; ip?: string } = {},
): Promise<InjectResponse> {
  return t.app.inject({
    method: 'POST',
    url,
    // A fresh IP per call unless pinned, so per-IP limits from one test never trip another.
    remoteAddress: options.ip ?? nextIp(),
    headers: { 'content-type': 'application/json', ...options.headers },
    payload: JSON.stringify(body),
  });
}

/** Test jurisdictions (seeded in global setup): P, S, X, a 21+ P state, and one with no row. */
export const TEST_STATES = { P: 'NV', S: 'TX', X: 'CA', P21: 'AL', NONE: 'WY' } as const;

/**
 * Runs a location check through the dev stub and returns the geo token header.
 *
 * @param place What the stub reports, e.g. `NV`, `NV;vpn`, `error`.
 */
export async function geoHeader(
  t: TestApp,
  context: 'signup' | 'purchase' | 'play_sc' | 'redeem',
  options: { ip: string; place?: string; headers?: Record<string, string> },
): Promise<Record<'x-geo-token', string>> {
  const response = await post(
    t,
    '/v1/geo/check',
    { context },
    {
      ip: options.ip,
      headers: { 'x-reef-dev-geo': options.place ?? TEST_STATES.P, ...options.headers },
    },
  );
  const body = response.json<{ result: string; geoToken?: string }>();
  if (body.geoToken === undefined) throw new Error(`geo check not allowed: ${response.body}`);
  return { 'x-geo-token': body.geoToken };
}

/**
 * POST to a location-gated signup route: pins one client IP, runs a signup geo check from it,
 * and sends the token with the request.
 */
export async function signupPost(
  t: TestApp,
  url: string,
  body: unknown,
  options: { headers?: Record<string, string>; ip?: string; place?: string } = {},
): Promise<InjectResponse> {
  const ip = options.ip ?? nextIp();
  const geo = await geoHeader(t, 'signup', {
    ip,
    ...(options.place === undefined ? {} : { place: options.place }),
  });
  return post(t, url, body, { ip, headers: { ...geo, ...options.headers } });
}

/** Native-app header: tokens in the body. */
export const MOBILE = { 'x-reef-client': 'mobile' } as const;

/** Tokens a native client receives. */
export interface MobileSession {
  readonly userId: string;
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly bearer: Record<'authorization', string>;
}

/**
 * Runs signup steps 1 and 2 and returns the signup ticket.
 */
export async function verifiedSignupTicket(
  t: TestApp,
  email: string,
  ip = nextIp(),
): Promise<string> {
  const started = await signupPost(
    t,
    '/v1/auth/signup',
    { contact: { channel: 'email', destination: email }, turnstileToken: 'pass' },
    { ip },
  );
  const { challengeId } = started.json<{ challengeId: string }>();
  const verified = await post(
    t,
    '/v1/auth/otp/verify',
    { challengeId, code: t.auth.outbox.latestCode(email) },
    { ip },
  );
  return verified.json<{ signupTicket: string }>().signupTicket;
}

/** A valid adult profile. */
export const PROFILE = { displayName: 'Reef Tester', dateOfBirth: '1990-04-02', stateCode: 'NV' };

/**
 * Signs up with email and password as a native client.
 *
 * @returns The new session's tokens.
 */
export async function signUp(
  t: TestApp,
  email: string = uniqueEmail(),
  password: string = GOOD_PASSWORD,
): Promise<MobileSession & { email: string; password: string }> {
  const signupTicket = await verifiedSignupTicket(t, email);
  const response = await signupPost(
    t,
    '/v1/auth/signup/complete',
    { signupTicket, profile: PROFILE, credential: { type: 'password', password } },
    { headers: MOBILE },
  );
  if (response.statusCode !== 201) throw new Error(`signup failed: ${response.body}`);
  return { ...asSession(response), email, password };
}

/** Reads a native-client session from a login, signup, or refresh response. */
export function asSession(response: InjectResponse): MobileSession {
  const body = response.json<{ userId: string; accessToken: string; refreshToken: string }>();
  return { ...body, bearer: { authorization: `Bearer ${body.accessToken}` } };
}

/**
 * @param secret Base32 TOTP secret.
 * @param at Time to generate for.
 * @returns The 6-digit code at that time.
 */
export function totpAt(secret: string, at: Date): Promise<string> {
  return generate({ secret, epoch: Math.floor(at.getTime() / 1000) });
}

/**
 * Enrols TOTP for a signed-in native client.
 *
 * @returns The secret and the 10 recovery codes.
 */
export async function enrollTotp(
  t: TestApp,
  session: MobileSession,
): Promise<{ secret: string; recoveryCodes: string[] }> {
  const setup = await post(t, '/v1/auth/2fa/totp/setup', {}, { headers: session.bearer });
  const { secret } = setup.json<{ secret: string }>();
  // Use the previous time step, so a code generated later in the test is never a replay.
  const code = await totpAt(secret, new Date(t.auth.clock.now().getTime() - 30_000));
  const confirmed = await post(
    t,
    '/v1/auth/2fa/totp/confirm',
    { code },
    { headers: session.bearer },
  );
  if (confirmed.statusCode !== 200) throw new Error(`TOTP confirm failed: ${confirmed.body}`);
  return { secret, recoveryCodes: confirmed.json<{ recoveryCodes: string[] }>().recoveryCodes };
}
