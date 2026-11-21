import {
  SATS_PER_BTC,
  UNITS_PER_COIN,
  type Cents,
  type CentsPerBtc,
  type Sats,
  type Units,
} from './types.js';

/** How many decimal places {@link formatCoins} shows. */
export type CoinPrecision = 'whole' | 'cents' | 'full';

function decimalsFor(precision: CoinPrecision): number {
  switch (precision) {
    case 'whole':
      return 0;
    case 'cents':
      return 2;
    case 'full':
      return 6;
  }
}

function floorDiv(value: bigint, divisor: bigint): bigint {
  const quotient = value / divisor;
  return value % divisor !== 0n && value < 0n ? quotient - 1n : quotient;
}

function groupThousands(digits: string): string {
  const groups: string[] = [];
  for (let end = digits.length; end > 0; end -= 3) {
    groups.unshift(digits.slice(Math.max(0, end - 3), end));
  }
  return groups.join(',');
}

// `decimals` is a digit count, never an amount, so a plain number is fine here.
function formatScaled(value: bigint, decimals: number): string {
  const sign = value < 0n ? '-' : '';
  const magnitude = value < 0n ? -value : value;
  const scale = 10n ** BigInt(decimals);
  const whole = groupThousands((magnitude / scale).toString());
  if (decimals === 0) return `${sign}${whole}`;
  const fraction = (magnitude % scale).toString().padStart(decimals, '0');
  return `${sign}${whole}.${fraction}`;
}

/**
 * Formats coin units for display, such as `"1,234.56"`. CLAUDE.md: coin display rounds down
 * (toward negative infinity), so a player never sees more than they hold.
 *
 * @param amount Coin units.
 * @param precision Decimal places: `whole` (0), `cents` (2, default), or `full` (6).
 * @returns The formatted amount, without a currency label.
 */
export function formatCoins(amount: Units, precision: CoinPrecision = 'cents'): string {
  const decimals = decimalsFor(precision);
  const step = UNITS_PER_COIN / 10n ** BigInt(decimals);
  return formatScaled(floorDiv(amount, step), decimals);
}

/**
 * Formats cents as US dollars, such as `"$1,234.56"`.
 *
 * @param amount Cents.
 * @returns The formatted dollar amount.
 */
export function formatUsd(amount: Cents): string {
  return `$${formatScaled(amount, 2)}`;
}

/**
 * Formats a rate as dollars per bitcoin, such as `"$65,432.10/BTC"`.
 *
 * @param rate Cents per BTC.
 * @returns The formatted rate.
 */
export function formatRate(rate: CentsPerBtc): string {
  return `$${formatScaled(rate, 2)}/BTC`;
}

/**
 * Formats satoshis as bitcoin with all 8 decimals, such as `"0.00012345 BTC"`. Exact.
 *
 * @param amount Satoshis.
 * @returns The formatted bitcoin amount.
 */
export function formatBtc(amount: Sats): string {
  const whole = groupThousands((amount / SATS_PER_BTC).toString());
  const fraction = (amount % SATS_PER_BTC).toString().padStart(8, '0');
  return `${whole}.${fraction} BTC`;
}
