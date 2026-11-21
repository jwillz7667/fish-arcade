import { randomBytes } from 'node:crypto';

import { generate } from 'otplib';
import { describe, expect, it } from 'vitest';

import { generateOtpCode, hashOtpCode } from '../otp/otp-code.js';
import {
  generateRecoveryCodes,
  hashRecoveryCode,
  normalizeRecoveryCode,
} from './recovery-codes.js';
import { generateTotpSecret, totpUri, verifyTotp } from './totp.js';

const key = randomBytes(32);
const at = new Date(Date.UTC(2026, 10, 20, 12, 0, 10));
const codeAt = (secret: string, date: Date) =>
  generate({ secret, epoch: Math.floor(date.getTime() / 1000) });

describe('OTP codes', () => {
  it('are 6 zero-padded digits', () => {
    const codes = Array.from({ length: 200 }, generateOtpCode);

    expect(codes.every((code) => /^\d{6}$/.test(code))).toBe(true);
  });

  it('hash differently per challenge', () => {
    expect(hashOtpCode(key, 'challenge-a', '123456')).not.toBe(
      hashOtpCode(key, 'challenge-b', '123456'),
    );
  });
});

describe('recovery codes', () => {
  it('issues 10 distinct XXXXX-XXXXX codes from the unambiguous alphabet', () => {
    const codes = generateRecoveryCodes();

    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    expect(codes.every((code) => /^[0-9A-HJKMNP-TV-Z]{5}-[0-9A-HJKMNP-TV-Z]{5}$/.test(code))).toBe(
      true,
    );
  });

  it('match however the player types them', () => {
    const [code = ''] = generateRecoveryCodes();
    const variants = [code.toLowerCase(), code.replace('-', ''), ` ${code} `];

    expect(variants.map((variant) => hashRecoveryCode(key, 'u1', variant))).toEqual(
      Array(3).fill(hashRecoveryCode(key, 'u1', code)),
    );
  });

  it('map look-alike letters to digits and bind to the user', () => {
    expect(normalizeRecoveryCode('il0o1-ABCDE')).toBe('1100' + '1ABCDE');
    expect(hashRecoveryCode(key, 'u1', 'ABCDE-FGHJK')).not.toBe(
      hashRecoveryCode(key, 'u2', 'ABCDE-FGHJK'),
    );
  });
});

describe('TOTP', () => {
  it('accepts the current code and returns its time step', async () => {
    const secret = generateTotpSecret();

    const step = await verifyTotp({
      secret,
      code: await codeAt(secret, at),
      lastTimeStep: null,
      now: at,
    });

    expect(step).toBe(Math.floor(at.getTime() / 30_000));
  });

  it('accepts the previous step but never a future one', async () => {
    const secret = generateTotpSecret();
    const previous = await codeAt(secret, new Date(at.getTime() - 30_000));
    const future = await codeAt(secret, new Date(at.getTime() + 30_000));

    expect(await verifyTotp({ secret, code: previous, lastTimeStep: null, now: at })).toBeDefined();
    expect(await verifyTotp({ secret, code: future, lastTimeStep: null, now: at })).toBeUndefined();
  });

  it('refuses a code at or before the last accepted step', async () => {
    const secret = generateTotpSecret();
    const code = await codeAt(secret, at);
    const step = Math.floor(at.getTime() / 30_000);

    expect(await verifyTotp({ secret, code, lastTimeStep: step, now: at })).toBeUndefined();
    expect(await verifyTotp({ secret, code, lastTimeStep: step - 1, now: at })).toBe(step);
  });

  it('builds an otpauth URI for authenticator apps', () => {
    expect(totpUri('JBSWY3DPEHPK3PXP', 'Reef account')).toMatch(
      /^otpauth:\/\/totp\/Reef:Reef%20account\?.*secret=JBSWY3DPEHPK3PXP/,
    );
  });
});
