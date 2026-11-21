import { createHash } from 'node:crypto';

import { IntegrityError, ValidationError } from '@reef/errors';
import {
  playerAccount,
  splitScBet,
  validateJournal,
  type AccountRef,
  type JournalEntryInput,
  type JournalRef,
  type ScBetSplit,
} from '@reef/ledger';
import { units, type Units } from '@reef/money';
import type { Pool } from 'pg';

import { runJournalTransaction, type PostedJournal } from './journal-transaction.js';
import { insertJournal, lockBalances, resolveAccounts } from './journal-writer.js';

/** An SC bet, described by intent: the split is decided under the balance locks. */
export interface ScBetInput {
  /** Journal type, such as `sc_bet` or `session_join`. */
  readonly type: string;
  readonly idempotencyKey: string;
  readonly userId: string;
  /** Units to wager. Positive. */
  readonly bet: Units;
  /** Where the wager goes: an SC game-result or session-escrow account. */
  readonly to: AccountRef;
  readonly ref?: JournalRef;
  readonly createdBy: string;
}

/** A posted SC bet and how it was split. */
export interface PostedScBet extends PostedJournal {
  readonly split: ScBetSplit;
}

function intentHash(input: ScBetInput): string {
  const canonical = JSON.stringify({
    kind: 'sc_bet',
    type: input.type,
    userId: input.userId,
    bet: input.bet.toString(),
    to: input.to.code,
    ref: input.ref === undefined ? null : [input.ref.type, input.ref.id],
    createdBy: input.createdBy,
  });
  return createHash('sha256').update(canonical, 'utf8').digest('hex');
}

function negate(amount: bigint): Units {
  return units(0n - amount);
}

/**
 * Posts an SC bet in the spec §10.2 spend order: `SC_bonus` first, then `SC_redeemable`. The
 * split is computed from the balances after they are locked, so concurrent bets cannot both see
 * the same bonus and draw redeemable SC while bonus SC remains (review R1, L3). Replays return
 * the split of the original journal.
 *
 * @param pool Connection pool for reef_app.
 * @param input The bet.
 * @returns The journal ID, whether it was a replay, and the split.
 * @throws ValidationError when the bet is not positive or the destination is not an SC account.
 * @throws InsufficientFundsError when the player's SC cannot cover the bet.
 * @throws ConflictError (IDEMPOTENCY_CONFLICT) when the key was used for a different bet.
 * @throws DependencyUnavailableError or IntegrityError as for `postJournal`.
 */
export async function postScBet(pool: Pool, input: ScBetInput): Promise<PostedScBet> {
  if (input.to.currency !== 'SC') {
    throw new ValidationError({ issues: [{ path: 'to', message: 'must be an SC account' }] });
  }
  const bonus = playerAccount(input.userId, 'SC_bonus');
  const redeemable = playerAccount(input.userId, 'SC_redeemable');
  const requestHash = intentHash(input);
  const posted = await runJournalTransaction(
    pool,
    { idempotencyKey: input.idempotencyKey, requestHash },
    async (client) => {
      const ids = await resolveAccounts(client, [bonus, redeemable, input.to]);
      const locked = await lockBalances(client, [...ids.values()]);
      const balanceOf = (account: AccountRef): Units => {
        const accountId = ids.get(account.code);
        if (accountId === undefined) {
          throw new IntegrityError({ message: `Ledger account ${account.code} not resolved` });
        }
        // resolveAccounts created the balance row, so a missing lock result is a new zero row.
        return units(locked.get(accountId) ?? 0n);
      };
      const split = splitScBet(
        { bonus: balanceOf(bonus), redeemable: balanceOf(redeemable) },
        input.bet,
      );
      // ledger_entries never holds a zero amount, so an untouched balance gets no entry.
      const entries: JournalEntryInput[] = [
        ...(split.fromBonus > 0n ? [{ account: bonus, amount: negate(split.fromBonus) }] : []),
        ...(split.fromRedeemable > 0n
          ? [{ account: redeemable, amount: negate(split.fromRedeemable) }]
          : []),
        { account: input.to, amount: input.bet },
      ];
      const journal = {
        type: input.type,
        idempotencyKey: input.idempotencyKey,
        entries,
        createdBy: input.createdBy,
        ...(input.ref === undefined ? {} : { ref: input.ref }),
      };
      validateJournal(journal);
      return insertJournal(client, journal, requestHash, ids, locked);
    },
  );
  return { ...posted, split: await splitOf(pool, posted.journalId, bonus, redeemable) };
}

async function splitOf(
  pool: Pool,
  journalId: string,
  bonus: AccountRef,
  redeemable: AccountRef,
): Promise<ScBetSplit> {
  const { rows } = await pool.query<{ code: string; amount: string }>(
    `SELECT a.code, e.amount FROM ledger_entries e JOIN ledger_accounts a ON a.id = e.account_id
      WHERE e.journal_id = $1 AND a.code = ANY($2::text[])`,
    [journalId, [bonus.code, redeemable.code]],
  );
  if (rows.length === 0) throw new IntegrityError({ message: 'SC bet journal has no SC debit' });
  const debitOf = (account: AccountRef) =>
    negate(BigInt(rows.find((row) => row.code === account.code)?.amount ?? '0'));
  return { fromBonus: debitOf(bonus), fromRedeemable: debitOf(redeemable) };
}
