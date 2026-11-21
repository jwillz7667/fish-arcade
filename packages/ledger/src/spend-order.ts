import { ErrorCode, InsufficientFundsError, ValidationError } from '@reef/errors';
import { units, type Units } from '@reef/money';

import type { PlayerAccountKind } from './accounts.js';

/** A player's two SC balances. */
export interface ScBalances {
  readonly bonus: Units;
  readonly redeemable: Units;
}

/** How an SC bet is funded. */
export interface ScBetSplit {
  readonly fromBonus: Units;
  readonly fromRedeemable: Units;
}

/**
 * Spec §10.2 (1x playthrough without a counter): SC winnings always land in `SC_redeemable`.
 */
export const SC_WINNINGS_KIND: PlayerAccountKind = 'SC_redeemable';

/**
 * Splits an SC bet across the player's balances. Spec §10.2: bets draw from `SC_bonus` first,
 * then `SC_redeemable`, so every SC is wagered once before anything it produces can be
 * redeemed.
 *
 * @param balances Current SC balances. Neither may be negative.
 * @param bet Bet amount in units. Must be positive.
 * @returns How much comes from each balance; the two parts sum to `bet`.
 * @throws ValidationError (INVALID_AMOUNT) for a non-positive bet or a negative balance.
 * @throws InsufficientFundsError when both balances together cannot cover the bet.
 */
export function splitScBet(balances: ScBalances, bet: Units): ScBetSplit {
  if (bet <= 0n || balances.bonus < 0n || balances.redeemable < 0n) {
    throw new ValidationError({
      code: ErrorCode.INVALID_AMOUNT,
      message: 'Bet must be positive and balances non-negative',
    });
  }
  if (balances.bonus + balances.redeemable < bet) {
    throw new InsufficientFundsError({ message: 'SC balances cannot cover the bet' });
  }
  const fromBonus = bet < balances.bonus ? bet : balances.bonus;
  return { fromBonus: units(fromBonus), fromRedeemable: units(bet - fromBonus) };
}
