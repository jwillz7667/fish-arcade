import { ErrorCode, ValidationError } from '@reef/errors';

import {
  cents,
  CENTS_PER_DOLLAR,
  sats,
  SATS_PER_BTC,
  units,
  UNITS_PER_COIN,
  type Cents,
  type Sats,
  type Units,
} from './types.js';

// Whole part capped at 15 digits: comfortably above any real balance, and it bounds the input.
const WHOLE_PATTERN = /^(?:0|[1-9]\d{0,14})$/;
const DIGITS_PATTERN = /^\d+$/;

function invalidDecimal(): ValidationError {
  return new ValidationError({
    code: ErrorCode.INVALID_AMOUNT,
    message: 'Amount is not a valid decimal',
    issues: [{ path: '', message: 'Must be a non-negative decimal amount' }],
  });
}

function parseDecimal(text: string, scale: bigint, fractionDigits: number): bigint {
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const fraction = dot === -1 ? '' : text.slice(dot + 1);
  if (!WHOLE_PATTERN.test(whole)) throw invalidDecimal();
  const isFractionValid =
    dot === -1 || (DIGITS_PATTERN.test(fraction) && fraction.length <= fractionDigits);
  if (!isFractionValid) throw invalidDecimal();
  return BigInt(whole) * scale + BigInt(fraction.padEnd(fractionDigits, '0'));
}

/**
 * Parses a coin amount such as `"12.5"` into units, exactly. Rejects signs, exponents,
 * separators, and more than 6 decimal places.
 *
 * @param text Decimal coin amount.
 * @returns The amount in units.
 * @throws ValidationError (INVALID_AMOUNT) when `text` is not a valid amount.
 */
export function parseCoins(text: string): Units {
  return units(parseDecimal(text, UNITS_PER_COIN, 6));
}

/**
 * Parses a dollar amount such as `"19.99"` into cents, exactly. Rejects signs, currency
 * symbols, separators, and more than 2 decimal places.
 *
 * @param text Decimal dollar amount.
 * @returns The amount in cents.
 * @throws ValidationError (INVALID_AMOUNT) when `text` is not a valid amount.
 */
export function parseUsd(text: string): Cents {
  return cents(parseDecimal(text, CENTS_PER_DOLLAR, 2));
}

/**
 * Parses a bitcoin amount such as `"0.00012345"` (as BTCPay and bitcoind report it) into
 * satoshis, exactly. Rejects signs, exponents, separators, and more than 8 decimal places.
 *
 * @param text Decimal bitcoin amount.
 * @returns The amount in satoshis.
 * @throws ValidationError (INVALID_AMOUNT) when `text` is not a valid amount.
 */
export function parseBtc(text: string): Sats {
  return sats(parseDecimal(text, SATS_PER_BTC, 8));
}
