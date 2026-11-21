import { ValidationError } from '@reef/errors';

/** Ledger currencies. GC and SC never mix inside one balance. */
export type Currency = 'GC' | 'SC';

/** Who owns a ledger account. Mirrors the `LedgerOwnerType` database enum. */
export type OwnerType = 'player' | 'session' | 'house' | 'jackpot' | 'redemption';

/** What a ledger account holds. Mirrors the `LedgerAccountKind` database enum. */
export type AccountKind =
  | 'GC'
  | 'SC_bonus'
  | 'SC_redeemable'
  | 'session_escrow'
  | 'GC_issued'
  | 'SC_promo'
  | 'game_result'
  | 'jackpot_pool'
  | 'redemption_pending'
  | 'redemption_paid';

/** A fully described ledger account. `code` is its unique spec §10.2 name. */
export interface AccountRef {
  readonly code: string;
  readonly ownerType: OwnerType;
  /** UUID of the owning player, session, or jackpot; null for global accounts. */
  readonly ownerId: string | null;
  readonly currency: Currency;
  readonly kind: AccountKind;
}

/** Wallet balances a player holds (spec §10.2). */
export type PlayerAccountKind = 'GC' | 'SC_bonus' | 'SC_redeemable';

/** House accounts (spec §10.2). `game_result` exists once per currency. */
export type HouseAccountKind = 'GC_issued' | 'SC_promo' | 'game_result';

/** Stages of the payout pipeline (spec §10.2). */
export type RedemptionStage = 'pending' | 'paid';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const JACKPOT_TIER = /^[a-z][a-z0-9_]{0,31}$/;

function requireUuid(value: string, field: string): string {
  if (!UUID.test(value)) {
    throw new ValidationError({
      message: `${field} must be a lowercase UUID`,
      issues: [{ path: field, message: 'Must be a lowercase UUID' }],
    });
  }
  return value;
}

/**
 * A player's wallet account, e.g. `player:{id}:SC_bonus`.
 *
 * @param userId Player UUID.
 * @param kind `GC`, `SC_bonus`, or `SC_redeemable`.
 * @returns The account reference.
 * @throws ValidationError when `userId` is not a lowercase UUID.
 */
export function playerAccount(userId: string, kind: PlayerAccountKind): AccountRef {
  return {
    code: `player:${requireUuid(userId, 'userId')}:${kind}`,
    ownerType: 'player',
    ownerId: userId,
    currency: kind === 'GC' ? 'GC' : 'SC',
    kind,
  };
}

/**
 * A table session's escrow account, `session:{id}:{currency}` (spec §10.3).
 *
 * @param sessionId Table session UUID.
 * @param currency Session currency.
 * @returns The account reference.
 * @throws ValidationError when `sessionId` is not a lowercase UUID.
 */
export function sessionAccount(sessionId: string, currency: Currency): AccountRef {
  return {
    code: `session:${requireUuid(sessionId, 'sessionId')}:${currency}`,
    ownerType: 'session',
    ownerId: sessionId,
    currency,
    kind: 'session_escrow',
  };
}

/**
 * A house account. `GC_issued` is GC-only and `SC_promo` is SC-only; `game_result` is split by
 * currency (`house:game_result:GC`, `house:game_result:SC`) so GC and SC never share a balance.
 *
 * @param kind House account kind.
 * @param currency Required for `game_result`; must match the kind otherwise.
 * @returns The account reference.
 * @throws ValidationError when the currency does not fit the kind.
 */
export function houseAccount(kind: HouseAccountKind, currency?: Currency): AccountRef {
  if (kind === 'game_result') {
    if (currency === undefined) {
      throw new ValidationError({ message: 'house:game_result needs a currency' });
    }
    return {
      code: `house:game_result:${currency}`,
      ownerType: 'house',
      ownerId: null,
      currency,
      kind,
    };
  }
  const fixed: Currency = kind === 'GC_issued' ? 'GC' : 'SC';
  if (currency !== undefined && currency !== fixed) {
    throw new ValidationError({ message: `house:${kind} holds ${fixed} only` });
  }
  return { code: `house:${kind}`, ownerType: 'house', ownerId: null, currency: fixed, kind };
}

/**
 * A jackpot pool, `jackpot:{tier}:{currency}` (spec §10.2, §7.3).
 *
 * @param jackpot The jackpot's UUID and tier name.
 * @param currency Pool currency.
 * @returns The account reference.
 * @throws ValidationError for a malformed ID or tier.
 */
export function jackpotAccount(
  jackpot: { id: string; tier: string },
  currency: Currency,
): AccountRef {
  if (!JACKPOT_TIER.test(jackpot.tier)) {
    throw new ValidationError({
      message: 'Jackpot tier must be lowercase snake_case',
      issues: [{ path: 'tier', message: 'Must be lowercase snake_case, up to 32 characters' }],
    });
  }
  return {
    code: `jackpot:${jackpot.tier}:${currency}`,
    ownerType: 'jackpot',
    ownerId: requireUuid(jackpot.id, 'jackpotId'),
    currency,
    kind: 'jackpot_pool',
  };
}

/**
 * The payout pipeline accounts, `redemption:pending` and `redemption:paid`. SC only.
 *
 * @param stage Pipeline stage.
 * @returns The account reference.
 */
export function redemptionAccount(stage: RedemptionStage): AccountRef {
  return {
    code: `redemption:${stage}`,
    ownerType: 'redemption',
    ownerId: null,
    currency: 'SC',
    kind: stage === 'pending' ? 'redemption_pending' : 'redemption_paid',
  };
}

/**
 * Whether an account holds player money and so must never go negative (spec §10.2; mirrored
 * by the `balances_player_owned_non_negative` database constraint).
 *
 * @param account Account to check.
 * @returns True for player and session accounts.
 */
export function isPlayerOwned(account: Pick<AccountRef, 'ownerType'>): boolean {
  return account.ownerType === 'player' || account.ownerType === 'session';
}
