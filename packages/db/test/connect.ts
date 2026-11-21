import { randomUUID } from 'node:crypto';

import pg from 'pg';
import { inject } from 'vitest';

import type { DatabaseRole } from '../src/roles.js';

/** Opens a connection as `role` to the disposable test database, runs `fn`, and closes it. */
export async function withClient<T>(
  role: DatabaseRole | 'admin',
  fn: (client: pg.Client) => Promise<T>,
): Promise<T> {
  const client = new pg.Client({ connectionString: inject('databaseUrls')[role] });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** Ledger account owner types, as stored. */
export type OwnerType = 'player' | 'session' | 'house' | 'jackpot' | 'redemption';

/** Inserts a ledger account and its zero balance row. Returns the account ID. */
export async function createAccount(
  client: pg.Client,
  ownerType: OwnerType,
  currency: 'GC' | 'SC' = 'GC',
): Promise<string> {
  const isGlobal = ownerType === 'house' || ownerType === 'redemption';
  const kind = {
    player: 'GC',
    session: 'session_escrow',
    house: 'GC_issued',
    jackpot: 'jackpot_pool',
    redemption: 'redemption_pending',
  }[ownerType];
  const ownerId = isGlobal ? null : randomUUID();
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ledger_accounts (code, owner_type, owner_id, currency, kind)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [`${ownerType}:${randomUUID()}:${kind}`, ownerType, ownerId, currency, kind],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('account insert returned no id');
  await client.query('INSERT INTO balances (account_id, owner_type) VALUES ($1, $2)', [
    id,
    ownerType,
  ]);
  return id;
}

/** Inserts a journal row and returns its ID. Entries are added separately. */
export async function createJournal(client: pg.Client): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO journals (type, idempotency_key, request_hash, created_by)
     VALUES ('test', $1, 'hash', 'integration-test') RETURNING id`,
    [randomUUID()],
  );
  const id = rows[0]?.id;
  if (id === undefined) throw new Error('journal insert returned no id');
  return id;
}

/** Inserts one ledger entry. */
export async function addEntry(
  client: pg.Client,
  journalId: string,
  accountId: string,
  amount: bigint,
): Promise<void> {
  await client.query(
    'INSERT INTO ledger_entries (journal_id, account_id, amount) VALUES ($1, $2, $3)',
    [journalId, accountId, amount.toString()],
  );
}

/** Runs `fn` in a transaction and returns the SQLSTATE and constraint of the COMMIT failure, if any. */
export async function commitError(
  client: pg.Client,
  fn: () => Promise<void>,
): Promise<{ code: string | undefined; constraint: string | undefined } | undefined> {
  await client.query('BEGIN');
  await fn();
  try {
    await client.query('COMMIT');
    return undefined;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    const { code, constraint } = error as pg.DatabaseError;
    return { code, constraint };
  }
}

/** Runs one statement and returns its SQLSTATE, or undefined if it succeeded. */
export async function statementError(
  client: pg.Client,
  sql: string,
  params: unknown[] = [],
): Promise<string | undefined> {
  try {
    await client.query(sql, params);
    return undefined;
  } catch (error) {
    return (error as pg.DatabaseError).code;
  }
}
