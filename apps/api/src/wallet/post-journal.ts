import { hashJournal, validateJournal, type JournalInput } from '@reef/ledger';
import type { Pool } from 'pg';

import { runJournalTransaction, type PostedJournal } from './journal-transaction.js';
import { insertJournal, lockBalances, resolveAccounts } from './journal-writer.js';

export type { PostedJournal } from './journal-transaction.js';

/**
 * Posts one double-entry journal (spec §10.2, playbook Step 4). The only way balances change.
 *
 * In one transaction: claims the idempotency key, replays an existing journal with the same key
 * and payload, creates missing accounts, locks the affected balances in ascending account ID
 * order, checks that player money stays non-negative, then writes the journal, its entries, and
 * the new balances. Zero-sum per currency is checked here and again by a deferred database
 * trigger at commit. Deadlocks and serialization failures are retried; the idempotency key makes
 * that safe.
 *
 * @param pool Connection pool for reef_app.
 * @param input The journal.
 * @returns The journal ID and whether this call was a replay.
 * @throws ValidationError when the journal is malformed or does not balance per currency.
 * @throws ConflictError (IDEMPOTENCY_CONFLICT) when the key was used with a different payload.
 * @throws InsufficientFundsError when a player or session balance would go negative.
 * @throws DependencyUnavailableError when the database is unreachable or keeps aborting the
 *   transaction. Safe to retry with the same idempotency key.
 * @throws IntegrityError when stored data contradicts the journal or a database invariant fires.
 */
export async function postJournal(pool: Pool, input: JournalInput): Promise<PostedJournal> {
  validateJournal(input);
  const requestHash = hashJournal(input);
  return runJournalTransaction(
    pool,
    { idempotencyKey: input.idempotencyKey, requestHash },
    async (client) => {
      const ids = await resolveAccounts(
        client,
        input.entries.map((entry) => entry.account),
      );
      const locked = await lockBalances(client, [...ids.values()]);
      return insertJournal(client, input, requestHash, ids, locked);
    },
  );
}
