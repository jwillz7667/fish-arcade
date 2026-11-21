import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import pg from 'pg';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';

import { JurisdictionService } from '../../src/compliance/index.js';
import type { ErrorBody } from '../../src/http/error-response.js';
import { buildTestApp, type TestApp } from '../http/test-app.js';
import {
  geoHeader,
  GOOD_PASSWORD,
  nextIp,
  post,
  PROFILE,
  signupPost,
  signUp,
  TEST_STATES,
  uniqueEmail,
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

type Context = 'purchase' | 'play_sc' | 'redeem';
const ROUTE: Record<Context, string> = {
  purchase: '/v1/test/purchase',
  play_sc: '/v1/test/play-sc',
  redeem: '/v1/test/redeem',
};

const errorCode = (response: InjectResponse): string => response.json<ErrorBody>().error.code;

function geoCheck(
  context: Context | 'signup',
  place: string,
  options: { ip?: string; headers?: Record<string, string> } = {},
): Promise<InjectResponse> {
  return post(
    t,
    '/v1/geo/check',
    { context, devicePayload: 'sdk-blob' },
    { ip: options.ip ?? nextIp(), headers: { 'x-reef-dev-geo': place, ...options.headers } },
  );
}

/** A signed-in player who checks location for `context` from `place`, then calls the route. */
async function attempt(context: Context, place: string): Promise<InjectResponse> {
  const ip = nextIp();
  const bearer = (await signUp(t)).bearer;
  const geo = await geoHeader(t, context, { ip, place, headers: bearer });
  return post(t, ROUTE[context], {}, { ip, headers: { ...bearer, ...geo } });
}

describe('the jurisdiction gate by mode (spec §4.1)', () => {
  it.each<[Context, string]>([
    ['purchase', TEST_STATES.P],
    ['play_sc', TEST_STATES.P],
    ['redeem', TEST_STATES.P],
    ['purchase', TEST_STATES.S],
  ])('allows %s in %s', async (context, state) => {
    expect((await attempt(context, state)).statusCode).toBe(201);
  });

  it.each<[Context, string, string]>([
    ['play_sc', TEST_STATES.S, 'mode_not_permitted'],
    ['redeem', TEST_STATES.S, 'mode_not_permitted'],
    ['purchase', TEST_STATES.X, 'state_blocked'],
    ['play_sc', TEST_STATES.X, 'state_blocked'],
    ['redeem', TEST_STATES.P21, 'redemption_disabled'],
    ['purchase', TEST_STATES.NONE, 'unknown_state'],
  ])('refuses %s in %s (%s) at the check', async (context, state, reason) => {
    const response = await geoCheck(context, state, {
      headers: (await signUp(t)).bearer,
    });

    expect(response.json()).toEqual({ result: 'blocked', stateCode: state, reason });
  });
});

describe('location trust', () => {
  it.each([
    [`${TEST_STATES.P};vpn`, 'vpn_detected'],
    [`${TEST_STATES.P};confidence=0.5`, 'low_confidence'],
    ['abroad', 'location_unavailable'],
  ])('blocks %s as %s, even in a P state', async (place, reason) => {
    const response = await geoCheck('signup', place);

    expect(response.json()).toMatchObject({ result: 'blocked', reason });
  });

  it.each(['error', 'timeout', ''])(
    'fails closed with 503 when the provider %j fails',
    async (place) => {
      const response = await geoCheck('signup', place);

      expect([response.statusCode, errorCode(response)]).toEqual([503, 'DEPENDENCY_UNAVAILABLE']);
    },
  );

  it('records every check, including failures, in geo_checks', async () => {
    const ip = nextIp();

    await geoCheck('signup', TEST_STATES.P, { ip });
    await geoCheck('signup', TEST_STATES.X, { ip });
    await geoCheck('signup', `${TEST_STATES.P};vpn`, { ip });
    await geoCheck('signup', 'error', { ip });
    const { rows } = await db.query<{
      result: string;
      state_code: string | null;
      vpn_flag: boolean;
    }>('SELECT result, state_code, vpn_flag FROM geo_checks WHERE ip = $1 ORDER BY id', [ip]);

    expect(rows).toEqual([
      { result: 'allowed', state_code: TEST_STATES.P, vpn_flag: false },
      { result: 'blocked', state_code: TEST_STATES.X, vpn_flag: false },
      { result: 'blocked', state_code: TEST_STATES.P, vpn_flag: true },
      { result: 'error', state_code: null, vpn_flag: false },
    ]);
  });
});

describe('geo tokens', () => {
  it('are required on gated routes', async () => {
    const response = await post(
      t,
      ROUTE.purchase,
      {},
      {
        headers: (await signUp(t)).bearer,
      },
    );

    expect([response.statusCode, errorCode(response)]).toEqual([403, 'GEO_CHECK_REQUIRED']);
  });

  it('need a signed-in player for anything but signup', async () => {
    const response = await geoCheck('purchase', TEST_STATES.P);

    expect(response.statusCode).toBe(401);
  });

  it('only work for the action, player, and IP they were issued to', async () => {
    const ip = nextIp();
    const player = (await signUp(t)).bearer;
    const other = (await signUp(t)).bearer;
    const purchase = await geoHeader(t, 'purchase', { ip, headers: player });

    const wrongAction = await post(
      t,
      ROUTE.play_sc,
      {},
      { ip, headers: { ...player, ...purchase } },
    );
    const wrongPlayer = await post(
      t,
      ROUTE.purchase,
      {},
      { ip, headers: { ...other, ...purchase } },
    );
    const wrongIp = await post(
      t,
      ROUTE.purchase,
      {},
      { ip: nextIp(), headers: { ...player, ...purchase } },
    );
    const right = await post(t, ROUTE.purchase, {}, { ip, headers: { ...player, ...purchase } });

    expect([wrongAction, wrongPlayer, wrongIp].map(errorCode)).toEqual(
      Array(3).fill('GEO_CHECK_REQUIRED'),
    );
    expect(right.statusCode).toBe(201);
  });

  it('expire after 10 minutes (spec §15: SC play rechecks every 10 minutes)', async () => {
    const ip = nextIp();
    const { userId, bearer: player } = await signUp(t);
    const geo = await geoHeader(t, 'play_sc', { ip, headers: player });

    t.auth.clock.advance(9 * 60_000);
    const fresh = await post(t, ROUTE.play_sc, {}, { ip, headers: { ...player, ...geo } });
    t.auth.clock.advance(60_000 + 1_000);
    // A new access token for the same player: only the geo token is stale.
    const stale = await post(
      t,
      ROUTE.play_sc,
      {},
      {
        ip,
        headers: { authorization: await t.bearerFor(userId), ...geo },
      },
    );

    expect(fresh.statusCode).toBe(201);
    expect(errorCode(stale)).toBe('GEO_CHECK_REQUIRED');
  });

  it('refuse a forged or tampered token', async () => {
    const ip = nextIp();
    const player = (await signUp(t)).bearer;
    const { 'x-geo-token': token } = await geoHeader(t, 'purchase', { ip, headers: player });
    const [version, body, mac] = token.split('.');
    const claims = JSON.parse(Buffer.from(String(body), 'base64url').toString()) as object;
    const forgedBody = Buffer.from(JSON.stringify({ ...claims, st: TEST_STATES.X })).toString(
      'base64url',
    );

    const tampered = await post(
      t,
      ROUTE.purchase,
      {},
      {
        ip,
        headers: { ...player, 'x-geo-token': `${String(version)}.${forgedBody}.${String(mac)}` },
      },
    );

    expect(errorCode(tampered)).toBe('GEO_CHECK_REQUIRED');
  });
});

describe('jurisdiction changes', () => {
  it('apply at their scheduled time, even to tokens issued before, and bust the cache', async () => {
    const jurisdictions = t.app.get(JurisdictionService);
    const state = 'OR';
    await db.query(
      `INSERT INTO jurisdictions (state_code, effective_from, mode, min_age,
         sc_redemption_enabled, fish_games_enabled, legal_memo_ref)
       VALUES ($1, '2026-01-01T00:00:00Z', 'P', 18, true, true, 'TEST')`,
      [state],
    );
    // Redis outlives the per-run database; start without a cached rule from an earlier run.
    await jurisdictions.invalidate(state);
    const ip = nextIp();
    const player = (await signUp(t)).bearer;
    const geo = await geoHeader(t, 'play_sc', { ip, place: state, headers: player });
    const before = await post(t, ROUTE.play_sc, {}, { ip, headers: { ...player, ...geo } });

    const effectiveFrom = new Date(t.auth.clock.now().getTime() + 1_000);
    await jurisdictions.schedule(
      {
        stateCode: state,
        effectiveFrom,
        mode: 'S',
        minAge: 18,
        scRedemptionEnabled: false,
        fishGamesEnabled: true,
        legalMemoRef: 'MEMO-1',
      },
      { adminId: randomUUID(), ip: null },
    );
    const stillBefore = await post(t, ROUTE.play_sc, {}, { ip, headers: { ...player, ...geo } });
    // That read cached the old rule only until the change is due (1 s), not the usual 60 s.
    t.auth.clock.advance(1_500);
    await delay(1_100);
    const after = await post(t, ROUTE.play_sc, {}, { ip, headers: { ...player, ...geo } });

    expect([before.statusCode, stillBefore.statusCode]).toEqual([201, 201]);
    expect([after.statusCode, errorCode(after)]).toEqual([403, 'COMPLIANCE_BLOCKED']);
    const audit = await db.query(
      `SELECT 1 FROM audit_logs WHERE action = 'compliance.jurisdiction.scheduled' AND target_id = $1`,
      [state],
    );
    expect(audit.rowCount).toBe(1);
  });

  it('cannot be scheduled in the past', async () => {
    const jurisdictions = t.app.get(JurisdictionService);

    await expect(
      jurisdictions.schedule(
        {
          stateCode: 'KS',
          effectiveFrom: new Date(t.auth.clock.now().getTime() - 1),
          mode: 'P',
          minAge: 18,
          scRedemptionEnabled: true,
          fishGamesEnabled: true,
          legalMemoRef: 'MEMO-2',
        },
        { adminId: randomUUID(), ip: null },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});

describe('signup and jurisdictions', () => {
  const completeFrom = async (place: string, profile: typeof PROFILE) => {
    const ip = nextIp();
    const email = uniqueEmail();
    const started = await signupPost(
      t,
      '/v1/auth/signup',
      { contact: { channel: 'email', destination: email }, turnstileToken: 'pass' },
      { ip, place },
    );
    const { challengeId } = started.json<{ challengeId: string }>();
    const { signupTicket } = (
      await post(
        t,
        '/v1/auth/otp/verify',
        { challengeId, code: t.auth.outbox.latestCode(email) },
        { ip },
      )
    ).json<{ signupTicket: string }>();
    return signupPost(
      t,
      '/v1/auth/signup/complete',
      { signupTicket, profile, credential: { type: 'password', password: GOOD_PASSWORD } },
      { ip, place },
    );
  };

  it('refuses to start signup from a blocked state', async () => {
    const response = await geoCheck('signup', TEST_STATES.X);

    expect(response.json()).toMatchObject({ result: 'blocked', reason: 'state_blocked' });
  });

  it('refuses a declared home state that is blocked or has no rule', async () => {
    const blocked = await completeFrom(TEST_STATES.P, { ...PROFILE, stateCode: TEST_STATES.X });
    const unknown = await completeFrom(TEST_STATES.P, { ...PROFILE, stateCode: TEST_STATES.NONE });

    expect([blocked, unknown].map(errorCode)).toEqual(['COMPLIANCE_BLOCKED', 'COMPLIANCE_BLOCKED']);
  });

  it("applies the stricter state's minimum age (21+ where configured)", async () => {
    const now = t.auth.clock.now();
    const nineteen = `${String(now.getUTCFullYear() - 19)}-01-01`;

    const inStrictState = await completeFrom(TEST_STATES.P21, {
      ...PROFILE,
      dateOfBirth: nineteen,
    });
    const homeIsStrict = await completeFrom(TEST_STATES.P, {
      ...PROFILE,
      stateCode: TEST_STATES.P21,
      dateOfBirth: nineteen,
    });
    const neither = await completeFrom(TEST_STATES.P, { ...PROFILE, dateOfBirth: nineteen });

    expect([errorCode(inStrictState), errorCode(homeIsStrict)]).toEqual([
      'COMPLIANCE_BLOCKED',
      'COMPLIANCE_BLOCKED',
    ]);
    expect(neither.statusCode).toBe(201);
  });
});
