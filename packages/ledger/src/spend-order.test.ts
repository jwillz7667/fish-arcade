import { ErrorCode } from '@reef/errors';
import { units } from '@reef/money';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SC_WINNINGS_KIND, splitScBet } from './spend-order.js';

const balances = (bonus: bigint, redeemable: bigint) => ({
  bonus: units(bonus),
  redeemable: units(redeemable),
});

describe('splitScBet (spec §10.2)', () => {
  it.each([
    [balances(100n, 50n), 30n, 30n, 0n],
    [balances(100n, 50n), 100n, 100n, 0n],
    [balances(100n, 50n), 120n, 100n, 20n],
    [balances(0n, 50n), 50n, 0n, 50n],
  ])('draws bonus first: %o bet %s', (current, bet, fromBonus, fromRedeemable) => {
    expect(splitScBet(current, units(bet))).toEqual({ fromBonus, fromRedeemable });
  });

  it('rejects a bet the two balances cannot cover', () => {
    expect(() => splitScBet(balances(10n, 10n), units(21n))).toThrow(
      expect.objectContaining({ code: ErrorCode.INSUFFICIENT_FUNDS }),
    );
  });

  it.each([
    [balances(1n, 1n), 0n],
    [balances(1n, 1n), -1n],
    [balances(-1n, 5n), 1n],
    [balances(5n, -1n), 1n],
  ])('rejects invalid input %o bet %s', (current, bet) => {
    expect(() => splitScBet(current, units(bet))).toThrow(
      expect.objectContaining({ code: ErrorCode.INVALID_AMOUNT }),
    );
  });

  it('always covers the bet exactly, never touches redeemable while bonus remains, never overdraws', () => {
    const amount = fc.bigInt({ min: 0n, max: 10n ** 15n });
    fc.assert(
      fc.property(
        amount,
        amount,
        fc.bigInt({ min: 1n, max: 2n * 10n ** 15n }),
        (bonus, redeemable, bet) => {
          fc.pre(bonus + redeemable >= bet);
          const split = splitScBet(balances(bonus, redeemable), units(bet));
          return (
            split.fromBonus + split.fromRedeemable === bet &&
            split.fromBonus <= bonus &&
            split.fromRedeemable <= redeemable &&
            (split.fromRedeemable === 0n || split.fromBonus === bonus)
          );
        },
      ),
    );
  });

  it('credits winnings to SC_redeemable', () => {
    expect(SC_WINNINGS_KIND).toBe('SC_redeemable');
  });
});
