import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { DevStubGeoProvider } from './geo/dev-stub-provider.js';
import { decideLocation, locationProblem } from './geo/geo-decision.js';
import type { GeoLocation } from './geo/geo-provider.js';
import { signGeoToken, verifyGeoToken, type GeoTokenClaims } from './geo/geo-token.js';
import {
  decideJurisdiction,
  GATED_CONTEXTS,
  type JurisdictionMode,
  type JurisdictionRule,
} from './jurisdictions/jurisdiction-policy.js';

const rule = (mode: JurisdictionMode, scRedemptionEnabled = true): JurisdictionRule => ({
  stateCode: 'NV',
  mode,
  minAge: 18,
  scRedemptionEnabled,
  fishGamesEnabled: true,
  effectiveFrom: new Date(0),
});

const allowed = (context: (typeof GATED_CONTEXTS)[number], r: JurisdictionRule | undefined) =>
  decideJurisdiction(context, r).isAllowed;

describe('decideJurisdiction (spec §4.1)', () => {
  it('allows everything in P, and redemption only when enabled', () => {
    expect(GATED_CONTEXTS.map((context) => allowed(context, rule('P')))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(decideJurisdiction('redeem', rule('P', false))).toEqual({
      isAllowed: false,
      reason: 'redemption_disabled',
    });
  });

  it('allows only signup and Gold Coin purchases in S', () => {
    expect(GATED_CONTEXTS.map((context) => allowed(context, rule('S')))).toEqual([
      true,
      true,
      false,
      false,
    ]);
    expect(decideJurisdiction('play_sc', rule('S'))).toEqual({
      isAllowed: false,
      reason: 'mode_not_permitted',
    });
  });

  it('blocks everything in X and in states with no rule', () => {
    expect(GATED_CONTEXTS.map((context) => allowed(context, rule('X')))).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(GATED_CONTEXTS.map((context) => decideJurisdiction(context, undefined))).toEqual(
      Array(4).fill({ isAllowed: false, reason: 'unknown_state' }),
    );
  });
});

describe('location trust', () => {
  const location = (overrides: Partial<GeoLocation> = {}): GeoLocation => ({
    stateCode: 'NV',
    confidence: 1,
    vpnDetected: false,
    lat: null,
    lng: null,
    ...overrides,
  });

  it('blocks VPNs first, then low confidence, then an unplaceable device', () => {
    expect([
      locationProblem(location({ vpnDetected: true, confidence: 0 }), 0.9),
      locationProblem(location({ confidence: 0.89 }), 0.9),
      locationProblem(location({ stateCode: null }), 0.9),
      locationProblem(location({ confidence: 0.9 }), 0.9),
    ]).toEqual(['vpn_detected', 'low_confidence', 'location_unavailable', undefined]);
  });

  it('applies the state rule only to a trusted location', () => {
    expect(
      decideLocation({
        context: 'play_sc',
        location: location({ vpnDetected: true }),
        rule: rule('P'),
        minConfidence: 0.9,
      }),
    ).toEqual({
      isAllowed: false,
      reason: 'vpn_detected',
    });
    expect(
      decideLocation({
        context: 'play_sc',
        location: location(),
        rule: rule('P'),
        minConfidence: 0.9,
      }),
    ).toEqual({ isAllowed: true });
  });
});

describe('geo tokens', () => {
  const key = randomBytes(32);
  const claims: GeoTokenClaims = {
    checkId: '42',
    context: 'purchase',
    stateCode: 'NV',
    userId: '7f8b0f4e-3a52-4d55-9a0c-6a1f8d1f2b3c',
    ip: '203.0.113.9',
    expiresAt: new Date(Date.UTC(2026, 10, 21, 12, 10)),
  };

  it('round-trip their claims', () => {
    expect(verifyGeoToken(key, signGeoToken(key, claims))).toEqual(claims);
    expect(verifyGeoToken(key, signGeoToken(key, { ...claims, userId: null }))?.userId).toBeNull();
  });

  it('reject another key, a changed body, and junk', () => {
    const token = signGeoToken(key, claims);
    const [version, , mac] = token.split('.');
    const otherBody = Buffer.from(
      JSON.stringify({ cid: '1', ctx: 'redeem', st: 'NV', uid: null, ip: 'x', exp: 1 }),
    ).toString('base64url');

    expect(verifyGeoToken(randomBytes(32), token)).toBeUndefined();
    expect(verifyGeoToken(key, `${String(version)}.${otherBody}.${String(mac)}`)).toBeUndefined();
    expect(verifyGeoToken(key, 'g1.abc')).toBeUndefined();
    expect(verifyGeoToken(key, '')).toBeUndefined();
  });

  it('reject a correctly signed body that is not valid claims', async () => {
    const { hmacHex } = await import('../auth/crypto/secrets.js');
    const sign = (body: string) => `g1.${body}.${hmacHex(key, 'geo-token', body)}`;

    expect(
      verifyGeoToken(key, sign(Buffer.from('not json').toString('base64url'))),
    ).toBeUndefined();
    expect(
      verifyGeoToken(key, sign(Buffer.from('{"cid":"x"}').toString('base64url'))),
    ).toBeUndefined();
  });
});

describe('DevStubGeoProvider', () => {
  const stub = new DevStubGeoProvider();
  const check = (header?: string) =>
    stub.check({
      context: 'signup',
      devicePayload: '',
      ip: '127.0.0.1',
      headers: header === undefined ? {} : { 'x-reef-dev-geo': header },
    });

  it('reads the state and flags from the header', async () => {
    expect(await check('NV')).toMatchObject({ stateCode: 'NV', confidence: 1, vpnDetected: false });
    expect(await check('NV;vpn;confidence=0.25')).toMatchObject({
      stateCode: 'NV',
      confidence: 0.25,
      vpnDetected: true,
    });
    expect(await check('abroad')).toMatchObject({ stateCode: null });
  });

  it('fails closed on a missing, malformed, or error header', async () => {
    await expect(check()).rejects.toThrow();
    await expect(check('nevada')).rejects.toThrow();
    await expect(check('NV;sideways')).rejects.toThrow();
    await expect(check('error')).rejects.toThrow();
  });
});
