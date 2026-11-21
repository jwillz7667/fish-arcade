import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { ACCOUNT_BACKOFF, backoffDelayMs } from './auth-policy.js';

describe('backoffDelayMs', () => {
  it('allows the free failures, then doubles from the base delay', () => {
    const delays = [1, 5, 6, 7, 8, 9].map((failures) => backoffDelayMs(failures, ACCOUNT_BACKOFF));

    expect(delays).toEqual([0, 0, 1_000, 2_000, 4_000, 8_000]);
  });

  it('caps at the maximum delay, even for huge failure counts', () => {
    expect(
      [16, 1_000, Number.MAX_SAFE_INTEGER].map((n) => backoffDelayMs(n, ACCOUNT_BACKOFF)),
    ).toEqual([ACCOUNT_BACKOFF.maxDelayMs, ACCOUNT_BACKOFF.maxDelayMs, ACCOUNT_BACKOFF.maxDelayMs]);
  });

  it('never decreases as failures grow', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 10_000 }), (failures) => {
        expect(backoffDelayMs(failures + 1, ACCOUNT_BACKOFF)).toBeGreaterThanOrEqual(
          backoffDelayMs(failures, ACCOUNT_BACKOFF),
        );
      }),
    );
  });
});
