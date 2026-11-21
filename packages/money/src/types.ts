import { ErrorCode, ValidationError } from '@reef/errors';

declare const brand: unique symbol;

/** A bigint tagged with a compile-time unit so amounts in different units cannot mix. */
type Brand<Name extends string> = bigint & { readonly [brand]: Name };

/**
 * Coin base units. Spec §10.1: 1 coin = 1,000,000 units. Signed, because ledger entries
 * and house balances can be negative.
 */
export type Units = Brand<'Units'>;

/** US cents. Never negative. */
export type Cents = Brand<'Cents'>;

/** Satoshis. Never negative. */
export type Sats = Brand<'Sats'>;

/** Exchange rate in integer US cents per 1 BTC. CLAUDE.md: rates are integer cents per BTC. Always positive. */
export type CentsPerBtc = Brand<'CentsPerBtc'>;

/** Units in one coin (spec §10.1). */
export const UNITS_PER_COIN = 1_000_000n;
/** Cents in one dollar. */
export const CENTS_PER_DOLLAR = 100n;
/** Units in one cent. Spec §10.1: 1 SC = 100 cents, so 1 cent = 10,000 units. */
export const UNITS_PER_CENT = UNITS_PER_COIN / CENTS_PER_DOLLAR;
/** Satoshis in one bitcoin. */
export const SATS_PER_BTC = 100_000_000n;

function invalidAmount(message: string): ValidationError {
  return new ValidationError({ code: ErrorCode.INVALID_AMOUNT, message });
}

/**
 * Tags a bigint as coin units.
 *
 * @param value Amount in units. May be negative.
 * @returns The value as {@link Units}.
 */
export function units(value: bigint): Units {
  return value as Units;
}

/**
 * Tags a bigint as cents.
 *
 * @param value Amount in cents.
 * @returns The value as {@link Cents}.
 * @throws ValidationError (INVALID_AMOUNT) when `value` is negative.
 */
export function cents(value: bigint): Cents {
  if (value < 0n) throw invalidAmount('Cents must not be negative');
  return value as Cents;
}

/**
 * Tags a bigint as satoshis.
 *
 * @param value Amount in satoshis.
 * @returns The value as {@link Sats}.
 * @throws ValidationError (INVALID_AMOUNT) when `value` is negative.
 */
export function sats(value: bigint): Sats {
  if (value < 0n) throw invalidAmount('Sats must not be negative');
  return value as Sats;
}

/**
 * Tags a bigint as a BTC/USD rate.
 *
 * @param value Integer cents per BTC.
 * @returns The value as {@link CentsPerBtc}.
 * @throws ValidationError (INVALID_AMOUNT) when `value` is zero or negative.
 */
export function centsPerBtc(value: bigint): CentsPerBtc {
  if (value <= 0n) throw invalidAmount('Rate must be positive');
  return value as CentsPerBtc;
}
