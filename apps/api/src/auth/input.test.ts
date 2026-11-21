import { describe, expect, it } from 'vitest';

import { readCookies } from './http/cookies.js';
import { ageInYears, assertMinimumAge, signupProfileSchema } from './signup/signup-profile.js';
import { contactSchema, parseIdentifier } from './users/contact.js';

describe('contacts', () => {
  it('lowercases emails and keeps E.164 numbers', () => {
    expect(contactSchema.parse({ channel: 'email', destination: ' Player@Example.COM ' })).toEqual({
      channel: 'email',
      value: 'player@example.com',
    });
    expect(contactSchema.parse({ channel: 'sms', destination: '+15551234567' })).toEqual({
      channel: 'sms',
      value: '+15551234567',
    });
  });

  it.each([
    ['email', 'not-an-email'],
    ['sms', '5551234567'],
    ['sms', '+1 555 123 4567'],
    ['email', '+15551234567'],
  ])('rejects %s destination %j', (channel, destination) => {
    expect(contactSchema.safeParse({ channel, destination }).success).toBe(false);
  });

  it('reads login identifiers as email or phone', () => {
    expect([
      parseIdentifier('A@B.co'),
      parseIdentifier('+447700900123'),
      parseIdentifier('nobody'),
      parseIdentifier('x@'),
    ]).toEqual([
      { channel: 'email', value: 'a@b.co' },
      { channel: 'sms', value: '+447700900123' },
      undefined,
      undefined,
    ]);
  });
});

describe('signup profile', () => {
  it('validates real calendar dates and two-letter states', () => {
    const base = { displayName: 'Reef Tester', stateCode: 'NY' };

    expect(signupProfileSchema.safeParse({ ...base, dateOfBirth: '1990-02-28' }).success).toBe(
      true,
    );
    expect(signupProfileSchema.safeParse({ ...base, dateOfBirth: '1990-02-30' }).success).toBe(
      false,
    );
    expect(signupProfileSchema.safeParse({ ...base, dateOfBirth: '90-02-01' }).success).toBe(false);
    expect(
      signupProfileSchema.safeParse({ ...base, dateOfBirth: '1990-02-01', stateCode: 'ny' })
        .success,
    ).toBe(false);
    expect(
      signupProfileSchema.safeParse({
        displayName: '<b>x</b>',
        stateCode: 'NY',
        dateOfBirth: '1990-02-01',
      }).success,
    ).toBe(false);
  });

  it('counts age by whole years in UTC, turning over on the birthday', () => {
    const on = new Date(Date.UTC(2026, 3, 2));

    expect([
      ageInYears('2008-04-02', on),
      ageInYears('2008-04-03', on),
      ageInYears('2008-03-31', on),
    ]).toEqual([18, 17, 18]);
  });

  it('blocks under-18s', () => {
    const on = new Date(Date.UTC(2026, 3, 2));

    expect(() => {
      assertMinimumAge('2008-04-03', on);
    }).toThrow(expect.objectContaining({ code: 'COMPLIANCE_BLOCKED' }));
    expect(() => {
      assertMinimumAge('2008-04-02', on);
    }).not.toThrow();
  });
});

describe('readCookies', () => {
  const request = (cookie?: string) => ({ headers: cookie === undefined ? {} : { cookie } });

  it('parses pairs and keeps the first of duplicate names', () => {
    const cookies = readCookies(request('a=1; __Host-reef_at=tok; b=2; a=planted; junk; =x'));

    expect([...cookies.entries()]).toEqual([
      ['a', '1'],
      ['__Host-reef_at', 'tok'],
      ['b', '2'],
    ]);
  });

  it('returns nothing without a header', () => {
    expect(readCookies(request()).size).toBe(0);
  });
});
