import { timingSafeEqual } from 'node:crypto';

import {
  ConflictError,
  DependencyUnavailableError,
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

import {
  isConnectionFailure,
  isRetryableTransactionFailure,
  isUniqueViolation,
} from './sql-errors.js';

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
/** Deadlocks and serialization failures are retried until this many attempts in total. */
const MAX_ATTEMPTS = 3;

function sameHash(stored: string, expected: string): boolean {
  const a = Buffer.from(stored, 'hex');
  const b = Buffer.from(expected, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

const byCode = (a: AccountRef, b: AccountRef): number =>
  a.code < b.code ? -1 : a.code > b.code ? 1 : 0;

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

async function post(
  client: PoolClient,
  input: JournalInput,
  requestHash: string,
): Promise<PostedJournal> {
  // Claims the key before any balance lock. A concurrent call with the same key waits here
  // until the first commits, then finds its journal and replays it. Without this it would
  // re-read the balance the first call already debited and fail with InsufficientFunds.
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
    input.idempotencyKey,
  ]);
  const replay = await findPosted(client, input.idempotencyKey, requestHash);
  if (replay !== undefined) return replay;

  const ids = await resolveAccounts(
    client,
    input.entries.map((entry) => entry.account),
  );
  const entries = input.entries.map((entry) => {
    const accountId = ids.get(entry.account.code);
    if (accountId === undefined) {
      throw new IntegrityError({ message: `Ledger account ${entry.account.code} not resolved` });
    }
    return { ...entry, accountId };
  });
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
  const journalId = journals[0]?.id;
  if (journalId === undefined) {
    throw new IntegrityError({ message: 'Journal insert returned no row' });
  }
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

/** @returns False when the connection is unusable and must be destroyed rather than reused. */
async function rollback(client: PoolClient): Promise<boolean> {
  try {
    await client.query('ROLLBACK');
    return true;
  } catch {
    // The original error is the one to report; this only decides the connection's fate.
    return false;
  }
}

/** One transaction attempt. Raw database errors propagate for {@link postJournal} to classify. */
async function attempt(
  pool: Pool,
  input: JournalInput,
  requestHash: string,
): Promise<PostedJournal> {
  const client = await pool.connect();
  let isUsable = true;
  try {
    await client.query('BEGIN');
    const result = await post(client, input, requestHash);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    isUsable = await rollback(client);
    // The advisory lock makes this unreachable; it stays as a second line of defence.
    if (isUsable && isUniqueViolation(error, IDEMPOTENCY_INDEX)) {
      const replay = await findPosted(client, input.idempotencyKey, requestHash);
      if (replay !== undefined) return replay;
    }
    throw error;
  } finally {
    client.release(!isUsable);
  }
}

/**
 * Posts one double-entry journal (spec §10.2, playbook Step 4). The only way balances change.
 *
 * In one transaction: claims the idempotency key, replays an existing journal with the same key
 * and payload, creates missing accounts, locks the affected balances in ascending account ID
 * order, checks that player money stays non-negative, then writes the journal, its entries, and
 * the new balances. Zero-sum is checked here and again by a deferred database trigger at commit.
 * Deadlocks and serialization failures are retried; the idempotency key makes that safe.
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
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await attempt(pool, input, requestHash);
    } catch (error) {
      if (isDomainError(error)) throw error;
      const isRetryable = isRetryableTransactionFailure(error);
      if (isRetryable && attemptNumber < MAX_ATTEMPTS) continue;
      if (isRetryable || isConnectionFailure(error)) {
        throw new DependencyUnavailableError({
          dependency: 'postgres',
          message: 'Journal could not be posted; retry with the same idempotency key',
          cause: error,
        });
      }
      throw new IntegrityError({ message: 'Journal could not be posted', cause: error });
    }
  }
}
