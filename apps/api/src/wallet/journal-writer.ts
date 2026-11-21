import { InsufficientFundsError, IntegrityError } from '@reef/errors';
import { isPlayerOwned, type AccountRef, type JournalInput } from '@reef/ledger';
import type { PoolClient } from 'pg';

interface AccountRow {
  readonly id: string;
  readonly code: string;
  readonly owner_type: string;
  readonly owner_id: string | null;
  readonly currency: string;
  readonly kind: string;
}

const byCode = (a: AccountRef, b: AccountRef): number =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

/**
 * Creates any missing accounts and balance rows.
 *
 * @param client Transaction client.
 * @param refs Accounts the journal touches.
 * @returns Account IDs by code.
 * @throws IntegrityError when a stored account's attributes contradict its code.
 */
export async function resolveAccounts(
  client: PoolClient,
  refs: readonly AccountRef[],
): Promise<Map<string, string>> {
  // Accounts are inserted in code order and balances in ID order, the same in every journal,
  // so two journals creating the same new accounts queue on the unique index instead of
  // deadlocking.
  const accounts = [...new Map(refs.map((ref) => [ref.code, ref])).values()].sort(byCode);
  const codes = accounts.map((account) => account.code);
  await client.query(
    `INSERT INTO ledger_accounts (code, owner_type, owner_id, currency, kind)
     SELECT * FROM unnest($1::text[], $2::"LedgerOwnerType"[], $3::uuid[], $4::"Currency"[], $5::"LedgerAccountKind"[])
     ON CONFLICT (code) DO NOTHING`,
    [
      codes,
      accounts.map((account) => account.ownerType),
      accounts.map((account) => account.ownerId),
      accounts.map((account) => account.currency),
      accounts.map((account) => account.kind),
    ],
  );
  const { rows } = await client.query<AccountRow>(
    'SELECT id, code, owner_type, owner_id, currency, kind FROM ledger_accounts WHERE code = ANY($1::text[])',
    [codes],
  );
  const rowsByCode = new Map(rows.map((row) => [row.code, row]));
  for (const account of accounts) {
    const row = rowsByCode.get(account.code);
    const matches =
      row !== undefined &&
      row.owner_type === account.ownerType &&
      row.owner_id === account.ownerId &&
      row.currency === account.currency &&
      row.kind === account.kind;
    if (!matches) {
      throw new IntegrityError({
        message: `Ledger account ${account.code} has unexpected attributes`,
      });
    }
  }
  await client.query(
    `INSERT INTO balances (account_id, owner_type)
     SELECT id, owner_type FROM ledger_accounts WHERE code = ANY($1::text[]) ORDER BY id
     ON CONFLICT (account_id) DO NOTHING`,
    [codes],
  );
  return new Map(rows.map((row) => [row.code, row.id]));
}

/**
 * Locks balances until the transaction ends, in ascending account ID order: the same in every
 * journal, so two journals over the same accounts queue instead of deadlocking.
 *
 * @param client Transaction client.
 * @param accountIds Accounts to lock.
 * @returns Locked balances by account ID.
 */
export async function lockBalances(
  client: PoolClient,
  accountIds: readonly string[],
): Promise<Map<string, bigint>> {
  const { rows } = await client.query<{ account_id: string; amount: string }>(
    'SELECT account_id, amount FROM balances WHERE account_id = ANY($1::uuid[]) ORDER BY account_id FOR UPDATE',
    [[...accountIds].sort()],
  );
  return new Map(rows.map((row) => [row.account_id, BigInt(row.amount)]));
}

/**
 * Checks player money stays non-negative, then writes the journal, its entries, and the new
 * balances. The balances must already be locked with {@link lockBalances}.
 *
 * @param client Transaction client.
 * @param input A validated journal.
 * @param requestHash Hash stored with the idempotency key.
 * @param ids Account IDs by code, from {@link resolveAccounts}.
 * @param locked Locked balances by account ID.
 * @returns The new journal's ID.
 * @throws InsufficientFundsError when a player or session balance would go negative.
 * @throws IntegrityError when an account was not resolved or an insert returns nothing.
 */
export async function insertJournal(
  client: PoolClient,
  input: JournalInput,
  requestHash: string,
  ids: ReadonlyMap<string, string>,
  locked: ReadonlyMap<string, bigint>,
): Promise<string> {
  const entries = input.entries.map((entry) => {
    const accountId = ids.get(entry.account.code);
    if (accountId === undefined) {
      throw new IntegrityError({ message: `Ledger account ${entry.account.code} not resolved` });
    }
    const next = (locked.get(accountId) ?? 0n) + entry.amount;
    if (isPlayerOwned(entry.account) && next < 0n) {
      throw new InsufficientFundsError({ message: `Journal would overdraw ${entry.account.code}` });
    }
    return { accountId, amount: entry.amount.toString() };
  });
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journals (type, idempotency_key, request_hash, ref_type, ref_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [
      input.type,
      input.idempotencyKey,
      requestHash,
      input.ref?.type ?? null,
      input.ref?.id ?? null,
      input.createdBy,
    ],
  );
  const journalId = rows[0]?.id;
  if (journalId === undefined) {
    throw new IntegrityError({ message: 'Journal insert returned no row' });
  }
  const accountIds = entries.map((entry) => entry.accountId);
  const amounts = entries.map((entry) => entry.amount);
  await client.query(
    `INSERT INTO ledger_entries (journal_id, account_id, amount)
     SELECT $1, account_id, amount FROM unnest($2::uuid[], $3::bigint[]) AS e(account_id, amount)`,
    [journalId, accountIds, amounts],
  );
  await client.query(
    `UPDATE balances SET amount = balances.amount + d.delta, version = version + 1, updated_at = now()
     FROM unnest($1::uuid[], $2::bigint[]) AS d(account_id, delta)
     WHERE balances.account_id = d.account_id`,
    [accountIds, amounts],
  );
  return journalId;
}
