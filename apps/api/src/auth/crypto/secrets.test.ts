import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { csrfTokenFor, isValidCsrfToken } from '../sessions/csrf.js';
import { hmacHex, randomToken, safeEqual, sha256Hex } from './secrets.js';

const key = randomBytes(32);

describe('secrets', () => {
  it('mints 256-bit base64url tokens that differ every time', () => {
    const [a, b] = [randomToken(), randomToken()];

    expect([a.length, /^[A-Za-z0-9_-]+$/.test(a), a === b]).toEqual([43, true, false]);
  });

  it('separates HMACs by purpose and by part boundaries', () => {
    expect(hmacHex(key, 'otp', 'a', 'b')).not.toBe(hmacHex(key, 'recovery-code', 'a', 'b'));
    expect(hmacHex(key, 'otp', 'ab', 'c')).not.toBe(hmacHex(key, 'otp', 'a', 'bc'));
  });

  it('compares in constant time and handles different lengths', () => {
    expect([safeEqual('abc', 'abc'), safeEqual('abc', 'abd'), safeEqual('a', 'abc')]).toEqual([
      true,
      false,
      false,
    ]);
  });

  it('hashes with SHA-256', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });
});

describe('CSRF tokens', () => {
  it('accepts only the token of the same session', () => {
    const token = csrfTokenFor(key, 'session-a');

    expect([
      isValidCsrfToken(key, 'session-a', token),
      isValidCsrfToken(key, 'session-b', token),
      isValidCsrfToken(key, 'session-a', undefined),
      isValidCsrfToken(key, 'session-a', ''),
    ]).toEqual([true, false, false, false]);
  });
});
