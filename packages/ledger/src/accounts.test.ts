import { ErrorCode } from '@reef/errors';
import { describe, expect, it } from 'vitest';

import {
  houseAccount,
  isPlayerOwned,
  jackpotAccount,
  playerAccount,
  redemptionAccount,
  sessionAccount,
} from './accounts.js';

const ID = '0192f1c4-5b6a-7c8d-9e0f-1a2b3c4d5e6f';
const invalid = expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED });

describe('account helpers (spec §10.2 names)', () => {
  it.each([
    [playerAccount(ID, 'GC'), `player:${ID}:GC`, 'player', ID, 'GC', 'GC'],
    [playerAccount(ID, 'SC_bonus'), `player:${ID}:SC_bonus`, 'player', ID, 'SC', 'SC_bonus'],
    [
      playerAccount(ID, 'SC_redeemable'),
      `player:${ID}:SC_redeemable`,
      'player',
      ID,
      'SC',
      'SC_redeemable',
    ],
    [sessionAccount(ID, 'SC'), `session:${ID}:SC`, 'session', ID, 'SC', 'session_escrow'],
    [houseAccount('GC_issued'), 'house:GC_issued', 'house', null, 'GC', 'GC_issued'],
    [houseAccount('SC_promo', 'SC'), 'house:SC_promo', 'house', null, 'SC', 'SC_promo'],
    [houseAccount('game_result', 'GC'), 'house:game_result:GC', 'house', null, 'GC', 'game_result'],
    [
      jackpotAccount({ id: ID, tier: 'grand' }, 'SC'),
      'jackpot:grand:SC',
      'jackpot',
      ID,
      'SC',
      'jackpot_pool',
    ],
    [
      redemptionAccount('pending'),
      'redemption:pending',
      'redemption',
      null,
      'SC',
      'redemption_pending',
    ],
    [redemptionAccount('paid'), 'redemption:paid', 'redemption', null, 'SC', 'redemption_paid'],
  ])('%o', (account, code, ownerType, ownerId, currency, kind) => {
    expect(account).toEqual({ code, ownerType, ownerId, currency, kind });
  });

  it.each([
    () => playerAccount('not-a-uuid', 'GC'),
    () => playerAccount(ID.toUpperCase(), 'GC'),
    () => sessionAccount('x', 'GC'),
    () => houseAccount('game_result'),
    () => houseAccount('GC_issued', 'SC'),
    () => jackpotAccount({ id: ID, tier: 'Grand Prize' }, 'SC'),
    () => jackpotAccount({ id: 'x', tier: 'grand' }, 'SC'),
  ])('rejects invalid input %#', (build) => {
    expect(build).toThrow(invalid);
  });

  it('flags only player and session accounts as player-owned', () => {
    expect(
      [
        playerAccount(ID, 'GC'),
        sessionAccount(ID, 'GC'),
        houseAccount('GC_issued'),
        jackpotAccount({ id: ID, tier: 'mini' }, 'GC'),
        redemptionAccount('paid'),
      ].map(isPlayerOwned),
    ).toEqual([true, true, false, false, false]);
  });
});
