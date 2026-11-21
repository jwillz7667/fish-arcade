import { describe, expect, it } from 'vitest';

import { isSensitiveKey, REDACTED, redactSensitive } from './redact.js';

// Every field the playbook names, plus the "ends in Secret or Key" rule.
const REQUIRED_KEYS = [
  'password',
  'token',
  'authorization',
  'cookie',
  'otp',
  'secret',
  'apiKey',
  'ssn',
  'dob',
  'address',
  'email',
  'phone',
  'xpub',
  'descriptor',
  'clientSecret',
  'webhookSecret',
  'privateKey',
  'hmacKey',
];

const VARIANT_KEYS = [
  'API_KEY',
  'x-api-key',
  'APIKey',
  'set-cookie',
  'refreshToken',
  'access_token',
  'passwordHash',
  'otpCode',
  'payoutAddress',
  'address_line1',
  'emailAddress',
  'phoneNumber',
  'dateOfBirth',
  'firstName',
  'last_name',
  'seedPhrase',
  'DATABASE_URL',
  'REDIS_URL',
  'DATABASE_ADMIN_URL',
  'MIGRATION_DATABASE_URL',
  'signupTicket',
  'mfaTicket',
  'x-csrf-token',
  'totpUri',
  'recoveryCodes',
  'credential',
];

describe('isSensitiveKey', () => {
  it.each([...REQUIRED_KEYS, ...VARIANT_KEYS])('treats %s as sensitive', (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    'userId',
    'tokenId',
    'payoutAddressId',
    'keyId',
    'amount',
    'status',
    'requestId',
    'statusCode',
    'challengeId',
    'name',
    '',
    '__',
  ])('treats %j as safe', (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe('redactSensitive', () => {
  it.each(REQUIRED_KEYS)('redacts %s at the top level and when nested', (key) => {
    const output = redactSensitive({ [key]: 'value', nested: { deeper: [{ [key]: 'value' }] } });

    expect(output).toEqual({ [key]: REDACTED, nested: { deeper: [{ [key]: REDACTED }] } });
  });

  it('redacts whole objects under a sensitive key', () => {
    expect(redactSensitive({ address: { line1: '1 Main St', zip: '10001' } })).toEqual({
      address: REDACTED,
    });
  });

  it('redacts request headers', () => {
    const output = redactSensitive({
      req: { headers: { authorization: 'Bearer x', cookie: 'sid=1', 'user-agent': 'ua' } },
    });

    expect(output).toEqual({
      req: { headers: { authorization: REDACTED, cookie: REDACTED, 'user-agent': 'ua' } },
    });
  });

  it('keeps safe fields untouched', () => {
    const output = redactSensitive({
      userId: 'u_1',
      count: 3,
      ok: true,
      none: null,
      missing: undefined,
    });

    expect(output).toEqual({ userId: 'u_1', count: 3, ok: true, none: null, missing: undefined });
  });

  it('serialises bigint money values as strings', () => {
    expect(redactSensitive({ amountUnits: 1_000_000n })).toEqual({ amountUnits: '1000000' });
  });

  it('serialises dates as ISO strings', () => {
    expect(redactSensitive({ at: new Date('2026-01-02T03:04:05.000Z') })).toEqual({
      at: '2026-01-02T03:04:05.000Z',
    });
  });

  it('turns errors into plain objects and redacts their fields and causes', () => {
    const cause = Object.assign(new Error('inner'), { email: 'a@b.c' });
    const error = Object.assign(new Error('outer', { cause }), { code: 'X', token: 't' });

    const output = redactSensitive({ err: error });

    expect(output).toEqual({
      err: {
        type: 'Error',
        message: 'outer',
        stack: error.stack,
        code: 'X',
        token: REDACTED,
        cause: { type: 'Error', message: 'inner', stack: cause.stack, email: REDACTED },
      },
    });
  });

  it('cuts circular references', () => {
    const node: Record<string, unknown> = { id: 1 };
    node['self'] = node;

    expect(redactSensitive({ node })).toEqual({ node: { id: 1, self: '[Circular]' } });
  });

  it('truncates very deep payloads', () => {
    let deep: Record<string, unknown> = { leaf: true };
    for (let level = 0; level < 20; level += 1) deep = { child: deep };

    expect(JSON.stringify(redactSensitive({ deep }))).toContain('[Truncated]');
  });
});
