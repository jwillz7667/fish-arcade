import { timingSafeEqual } from 'node:crypto';

import {
  ConflictError,
  ErrorCode,
  InsufficientFundsError,
  IntegrityError,
  isDomainError,
} from '@reef/errors';
import {
  hashJournal,
  isPlayerOwned,
  validateJournal,
  type AccountRef,
  type JournalInput,
} from '@reef/ledger';
import type { Pool, PoolClient } from 'pg';

import { isUniqueViolation } from './sql-errors.js';

/** Result of {@link postJournal}. */
export interface PostedJournal {
  readonly journalId: string;
  /** True when the idempotency key had already been posted with the same payload. */
  readonly isReplay: boolean;
}

interface AccountRow {
  readonly id: string;
  readonly code: string;
  readonly owner_type: string;
  readonly owner_id: string | null;
  readonly currency: string;
  readonly kind: string;
}

const IDEMPOTENCY_INDEX = 'journals_idempotency_key_key';

function sameHash(stored: string, expected: string): boolean {
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

async function findPosted(
  client: PoolClient,
  idempotencyKey: string,
  requestHash: string,
): Promise<PostedJournal | undefined> {
  const { rows } = await client.query<{ id: string; request_hash: string }>(
    'SELECT id, request_hash FROM journals WHERE idempotency_key = $1',
    [idempotencyKey],
  );
  const row = rows[0];
  if (row === undefined) return undefined;
  if (!sameHash(row.request_hash, requestHash)) {
    throw new ConflictError({
      code: ErrorCode.IDEMPOTENCY_CONFLICT,
      message: `Idempotency key reused with a different journal: ${idempotencyKey}`,
    });
  }
  return { journalId: row.id, isReplay: true };
}

/** Creates any missing accounts and balance rows, then returns account IDs by code. */
async function resolveAccounts(
  client: PoolClient,
  accounts: readonly AccountRef[],
): Promise<Map<string, string>> {
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
  const byCode = new Map(rows.map((row) => [row.code, row]));
  for (const account of accounts) {
    const row = byCode.get(account.code);
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
     SELECT id, owner_type FROM ledger_accounts WHERE code = ANY($1::text[])
     ON CONFLICT (account_id) DO NOTHING`,
    [codes],
  );
  return new Map(rows.map((row) => [row.code, row.id]));
}

async function post(
  client: PoolClient,
  input: JournalInput,
  requestHash: string,
): Promise<PostedJournal> {
  const replay = await findPosted(client, input.idempotencyKey, requestHash);
  if (replay !== undefined) return replay;

  const ids = await resolveAccounts(
    client,
    input.entries.map((entry) => entry.account),
  );
  const entries = input.entries.map((entry) => ({
    ...entry,
    accountId: ids.get(entry.account.code) ?? '',
  }));
  const accountIds = entries.map((entry) => entry.accountId).sort();

  // Locks in ascending account ID order, the same in every journal, so two journals that touch
  // the same accounts queue instead of deadlocking.
  const { rows: locked } = await client.query<{ account_id: string; amount: string }>(
    'SELECT account_id, amount FROM balances WHERE account_id = ANY($1::uuid[]) ORDER BY account_id FOR UPDATE',
    [accountIds],
  );
  const current = new Map(locked.map((row) => [row.account_id, BigInt(row.amount)]));
  for (const entry of entries) {
    const next = (current.get(entry.accountId) ?? 0n) + entry.amount;
    if (isPlayerOwned(entry.account) && next < 0n) {
      throw new InsufficientFundsError({ message: `Journal would overdraw ${entry.account.code}` });
    }
  }

  const { rows: journals } = await client.query<{ id: string }>(
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
  const journalId = journals[0]?.id ?? '';
  const amounts = entries.map((entry) => entry.amount.toString());
  await client.query(
    `INSERT INTO ledger_entries (journal_id, account_id, amount)
     SELECT $1, account_id, amount FROM unnest($2::uuid[], $3::bigint[]) AS e(account_id, amount)`,
    [journalId, entries.map((entry) => entry.accountId), amounts],
  );
  await client.query(
    `UPDATE balances SET amount = balances.amount + d.delta, version = version + 1, updated_at = now()
     FROM unnest($1::uuid[], $2::bigint[]) AS d(account_id, delta)
     WHERE balances.account_id = d.account_id`,
    [entries.map((entry) => entry.accountId), amounts],
  );
  return { journalId, isReplay: false };
}

/**
 * Posts one double-entry journal (spec §10.2, playbook Step 4). The only way balances change.
 *
 * In one transaction: replays an existing journal with the same idempotency key and payload,
 * creates missing accounts, locks the affected balances in ascending account ID order, checks
 * that player money stays non-negative, then writes the journal, its entries, and the new
 * balances. Zero-sum is checked here and again by a deferred database trigger at commit.
 *
 * @param pool Connection pool for reef_app.
 * @param input The journal.
 * @returns The journal ID and whether this call was a replay.
 * @throws ValidationError when the journal is malformed or does not balance per currency.
 * @throws ConflictError (IDEMPOTENCY_CONFLICT) when the key was used with a different payload.
 * @throws InsufficientFundsError when a player or session balance would go negative.
 * @throws IntegrityError when stored data contradicts the journal or a database invariant fires.
 */
export async function postJournal(pool: Pool, input: JournalInput): Promise<PostedJournal> {
  validateJournal(input);
  const requestHash = hashJournal(input);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const result = await post(client, input, requestHash);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  } catch (error) {
    // A concurrent call with the same key committed first: answer as a replay.
    if (isUniqueViolation(error, IDEMPOTENCY_INDEX)) {
      const replay = await findPosted(client, input.idempotencyKey, requestHash);
      if (replay !== undefined) return replay;
    }
    if (isDomainError(error)) throw error;
    throw new IntegrityError({ message: 'Journal could not be posted', cause: error });
  } finally {
    client.release();
  }
}
