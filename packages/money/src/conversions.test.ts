import { ErrorCode } from '@reef/errors';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  centsToSatsForPayout,
  centsToSatsOwed,
  centsToUnits,
  satsToCents,
  unitsToCents,
} from './conversions.js';
import { cents, centsPerBtc, sats, SATS_PER_BTC, units, UNITS_PER_CENT } from './types.js';

const centsArb = fc.bigInt({ min: 0n, max: 10n ** 15n }).map(cents);
const satsArb = fc.bigInt({ min: 0n, max: 21_000_000n * SATS_PER_BTC }).map(sats);
// $0.01 to $100M per BTC.
const rateArb = fc.bigInt({ min: 1n, max: 10n ** 10n }).map(centsPerBtc);
const unitsArb = fc.bigInt({ min: 0n, max: 10n ** 21n }).map(units);

describe('unitsToCents', () => {
  it('rounds down: 1.999999 coins is 199 cents', () => {
    expect(unitsToCents(units(1_999_999n))).toBe(199n);
  });

  it('rejects negative units', () => {
    expect(() => unitsToCents(units(-1n))).toThrow(
      expect.objectContaining({ code: ErrorCode.INVALID_AMOUNT }),
    );
  });

  it('never exceeds the exact value and is within one cent of it', () => {
    fc.assert(
      fc.property(unitsArb, (amount) => {
        const result = unitsToCents(amount);
        return result * UNITS_PER_CENT <= amount && (result + 1n) * UNITS_PER_CENT > amount;
      }),
    );
  });

  it('inverts centsToUnits exactly', () => {
    fc.assert(fc.property(centsArb, (amount) => unitsToCents(centsToUnits(amount)) === amount));
  });
});

describe('centsToSatsForPayout', () => {
  it('rounds down: $1 at $30,000/BTC is 3,333 sats', () => {
    expect(centsToSatsForPayout(cents(100n), centsPerBtc(3_000_000n))).toBe(3_333n);
  });

  it('never pays more than the exact value, and is within one sat of it', () => {
    fc.assert(
      fc.property(centsArb, rateArb, (amount, rate) => {
        const exact = amount * SATS_PER_BTC;
        const result = centsToSatsForPayout(amount, rate);
        return result * rate <= exact && (result + 1n) * rate > exact;
      }),
    );
  });
});

describe('centsToSatsOwed', () => {
  it('rounds up: $1 at $30,000/BTC is 3,334 sats', () => {
    expect(centsToSatsOwed(cents(100n), centsPerBtc(3_000_000n))).toBe(3_334n);
  });

  it('is exact when the division is exact', () => {
    expect(centsToSatsOwed(cents(100n), centsPerBtc(10_000_000n))).toBe(1_000n);
  });

  it('never charges less than the exact value, and is within one sat of it', () => {
    fc.assert(
      fc.property(centsArb, rateArb, (amount, rate) => {
        const exact = amount * SATS_PER_BTC;
        const result = centsToSatsOwed(amount, rate);
        return result * rate >= exact && (result - 1n) * rate < exact;
      }),
    );
  });

  it('is never below the payout conversion of the same amount', () => {
    fc.assert(
      fc.property(
        centsArb,
        rateArb,
        (amount, rate) => centsToSatsOwed(amount, rate) >= centsToSatsForPayout(amount, rate),
      ),
    );
  });
});

describe('satsToCents', () => {
  it('rounds down: 3,334 sats at $30,000/BTC is 100 cents', () => {
    expect(satsToCents(sats(3_334n), centsPerBtc(3_000_000n))).toBe(100n);
  });

  it('never exceeds the exact value, and is within one cent of it', () => {
    fc.assert(
      fc.property(satsArb, rateArb, (amount, rate) => {
        const exact = amount * rate;
        const result = satsToCents(amount, rate);
        return result * SATS_PER_BTC <= exact && (result + 1n) * SATS_PER_BTC > exact;
      }),
    );
  });

  it('covers at least the cents charged when valuing sats owed', () => {
    fc.assert(
      fc.property(centsArb, rateArb, (amount, rate) => {
        const owed = centsToSatsOwed(amount, rate);
        return owed * rate >= amount * SATS_PER_BTC;
      }),
    );
  });
});
