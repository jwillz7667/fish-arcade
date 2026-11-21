import { describe, expect, it } from 'vitest';

import { kycTransition, levelsSatisfying, type KycStatus } from './kyc-status.js';
import { signWebhook, webhookSignatureProblem } from './webhook-signature.js';

const STATUSES: readonly KycStatus[] = ['pending', 'passed', 'failed', 'review', 'sanctions_hit'];

// Every (from, to) pair the platform accepts; anything else must be rejected.
const ALLOWED = new Set([
  'pending→passed',
  'pending→failed',
  'pending→review',
  'pending→sanctions_hit',
  'review→passed',
  'review→failed',
  'review→sanctions_hit',
  'passed→sanctions_hit',
]);

describe('kycTransition', () => {
  it.each(STATUSES.flatMap((from) => STATUSES.map((to) => [from, to] as const)))(
    '%s → %s',
    (from, to) => {
      const expected =
        from === to
          ? { kind: 'unchanged' }
          : ALLOWED.has(`${from}→${to}`)
            ? { kind: 'apply', to }
            : { kind: 'rejected' };

      expect(kycTransition(from, to)).toEqual(expected);
    },
  );

  it('lets a full check satisfy a light requirement, not the other way round', () => {
    expect([levelsSatisfying('light'), levelsSatisfying('full')]).toEqual([
      ['light', 'full'],
      ['full'],
    ]);
  });
});

describe('webhook signatures', () => {
  const secret = 'webhook-secret-webhook-secret-123';
  const body = Buffer.from('{"id":"evt_1"}');
  const at = new Date(Date.UTC(2026, 10, 21, 12));
  const check = (header: string | undefined, now = at, rawBody = body) =>
    webhookSignatureProblem({ secret, header, rawBody, now });

  it('accepts its own signature within 5 minutes either way', () => {
    const header = signWebhook(secret, body, at);

    expect([
      check(header),
      check(header, new Date(at.getTime() + 300_000)),
      check(header, new Date(at.getTime() - 300_000)),
    ]).toEqual([undefined, undefined, undefined]);
  });

  it('rejects stale and future timestamps', () => {
    const header = signWebhook(secret, body, at);

    expect([
      check(header, new Date(at.getTime() + 301_000)),
      check(header, new Date(at.getTime() - 301_000)),
    ]).toEqual(['stale', 'stale']);
  });

  it('rejects another body, another secret, a moved timestamp, and malformed headers', () => {
    const header = signWebhook(secret, body, at);
    const [, mac] = header.split(',v1=');
    const movedTimestamp = `t=${String(Math.floor(at.getTime() / 1000) + 1)},v1=${String(mac)}`;

    expect([
      check(header, at, Buffer.from('{"id":"evt_2"}')),
      check(signWebhook('another-secret-another-secret-xx', body, at)),
      check(movedTimestamp),
      check(undefined),
      check('t=abc,v1=00'),
      check(`v1=${String(mac)}`),
    ]).toEqual(['mismatch', 'mismatch', 'mismatch', 'malformed', 'malformed', 'malformed']);
  });
});
