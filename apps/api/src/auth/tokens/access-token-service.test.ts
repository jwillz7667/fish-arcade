import { createPublicKey, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';

import { AuthError } from '@reef/errors';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import type { Clock } from '../clock.js';
import type { AuthKeys } from '../crypto/auth-keys.js';
import { AccessTokenService } from './access-token-service.js';

function keys(): AuthKeys {
  const { privateKey } = generateKeyPairSync('ed25519');
  return {
    signingKey: privateKey,
    verifyKey: createPublicKey(privateKey),
    keyId: 'k1',
    hmacKey: randomBytes(32),
  };
}

function movableClock(
  start = Date.UTC(2026, 10, 20, 12),
): Clock & { advance: (ms: number) => void } {
  let now = start;
  return {
    now: () => new Date(now),
    advance: (ms) => {
      now += ms;
    },
  };
}

const claims = () => ({
  userId: randomUUID(),
  sessionId: randomUUID(),
  authTime: new Date(Date.UTC(2026, 10, 20, 11, 59)),
  amr: ['pwd', 'otp'],
});

describe('AccessTokenService', () => {
  it('round-trips the claims and expires 10 minutes after issue', async () => {
    const clock = movableClock();
    const service = new AccessTokenService(keys(), clock);
    const input = claims();

    const { token, expiresAt } = await service.sign(input);

    expect(await service.verify(token)).toEqual(input);
    expect(expiresAt.getTime() - clock.now().getTime()).toBe(600_000);
  });

  it('rejects an expired token', async () => {
    const clock = movableClock();
    const service = new AccessTokenService(keys(), clock);
    const { token } = await service.sign(claims());

    clock.advance(600_001);

    await expect(service.verify(token)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a token signed by another key', async () => {
    const clock = movableClock();
    const { token } = await new AccessTokenService(keys(), clock).sign(claims());

    await expect(new AccessTokenService(keys(), clock).verify(token)).rejects.toBeInstanceOf(
      AuthError,
    );
  });

  it('rejects a tampered payload', async () => {
    const service = new AccessTokenService(keys(), movableClock());
    const [header, , signature] = (await service.sign(claims())).token.split('.');
    const forged = Buffer.from(JSON.stringify({ sub: randomUUID() })).toString('base64url');

    await expect(
      service.verify(`${String(header)}.${forged}.${String(signature)}`),
    ).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects an unsigned token and a token for another audience', async () => {
    const authKeys = keys();
    const clock = movableClock();
    const service = new AccessTokenService(authKeys, clock);
    const unsigned = `${Buffer.from('{"alg":"none","typ":"at+jwt"}').toString('base64url')}.${Buffer.from('{}').toString('base64url')}.`;
    const otherAudience = await new SignJWT({ sid: randomUUID(), auth_time: 1, amr: ['pwd'] })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt' })
      .setSubject(randomUUID())
      .setIssuer('reef-api')
      .setAudience('reef-admin')
      .setIssuedAt(Math.floor(clock.now().getTime() / 1000))
      .setExpirationTime('5m')
      .setJti(randomUUID())
      .sign(authKeys.signingKey);

    await expect(service.verify(unsigned)).rejects.toBeInstanceOf(AuthError);
    await expect(service.verify(otherAudience)).rejects.toBeInstanceOf(AuthError);
  });

  it('rejects a well-signed token with malformed claims', async () => {
    const authKeys = keys();
    const clock = movableClock();
    const token = await new SignJWT({ sid: 'not-a-uuid', auth_time: 1, amr: [] })
      .setProtectedHeader({ alg: 'EdDSA', typ: 'at+jwt' })
      .setSubject(randomUUID())
      .setIssuer('reef-api')
      .setAudience('reef-player')
      .setIssuedAt(Math.floor(clock.now().getTime() / 1000))
      .setExpirationTime(Math.floor(clock.now().getTime() / 1000) + 60)
      .setJti(randomUUID())
      .sign(authKeys.signingKey);

    await expect(new AccessTokenService(authKeys, clock).verify(token)).rejects.toBeInstanceOf(
      AuthError,
    );
  });
});
