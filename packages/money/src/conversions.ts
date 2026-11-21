import { ErrorCode, ValidationError } from '@reef/errors';

import {
  cents,
  sats,
  SATS_PER_BTC,
  units,
  UNITS_PER_CENT,
  type Cents,
  type CentsPerBtc,
  type Sats,
  type Units,
} from './types.js';

/**
 * Converts coin units to cents, rounding down. Spec §10.1: redemption converts SC to cents
 * rounding down, so the player is never paid a fraction of a cent they do not hold.
 *
 * @param amount Non-negative coin units.
 * @returns Whole cents, rounded down.
 * @throws ValidationError (INVALID_AMOUNT) when `amount` is negative.
 */
export function unitsToCents(amount: Units): Cents {
  if (amount < 0n) {
    throw new ValidationError({
      code: ErrorCode.INVALID_AMOUNT,
      message: 'Cannot convert negative units to cents',
    });
  }
  return cents(amount / UNITS_PER_CENT);
}

/**
 * Converts cents to coin units. Exact.
 *
 * @param amount Cents.
 * @returns The same value in coin units.
 */
export function centsToUnits(amount: Cents): Units {
  return units(amount * UNITS_PER_CENT);
}

/**
 * BTC paid to a player. CLAUDE.md and spec §22.3: payouts round down to the satoshi, so the
 * platform never pays more than the cents owed.
 *
 * @param amount Cents to pay out.
 * @param rate Oracle rate at send time.
 * @returns Satoshis, rounded down.
 */
export function centsToSatsForPayout(amount: Cents, rate: CentsPerBtc): Sats {
  return sats((amount * SATS_PER_BTC) / rate);
}

/**
 * BTC a player owes for a purchase. CLAUDE.md: amounts owed by a player round up to the
 * satoshi, so the platform is never short of the cents charged.
 *
 * @param amount Cents charged.
 * @param rate Oracle rate at invoice creation.
 * @returns Satoshis, rounded up.
 */
export function centsToSatsOwed(amount: Cents, rate: CentsPerBtc): Sats {
  return sats((amount * SATS_PER_BTC + rate - 1n) / rate);
}

/**
 * Values satoshis in cents, rounding down.
 *
 * @param amount Satoshis.
 * @param rate Rate to value them at.
 * @returns Whole cents, rounded down.
 */
export function satsToCents(amount: Sats, rate: CentsPerBtc): Cents {
  return cents((amount * rate) / SATS_PER_BTC);
}
