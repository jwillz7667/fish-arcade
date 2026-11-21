import type { AccountRef } from '@reef/ledger';
import { units, type Units } from '@reef/money';
import type { Pool } from 'pg';

/**
 * Reads current balances. Accounts that have never been posted to read as zero.
 *
 * @param pool Connection pool for reef_app.
 * @param accounts Accounts to read.
 * @returns Balance in units by account code.
 */
export async function getBalances(
  pool: Pool,
  accounts: readonly AccountRef[],
): Promise<ReadonlyMap<string, Units>> {
  const codes = accounts.map((account) => account.code);
  const { rows } = await pool.query<{ code: string; amount: string }>(
    `SELECT a.code, b.amount FROM ledger_accounts a JOIN balances b ON b.account_id = a.id
      WHERE a.code = ANY($1::text[])`,
    [codes],
  );
  const found = new Map(rows.map((row) => [row.code, BigInt(row.amount)]));
  return new Map(codes.map((code) => [code, units(found.get(code) ?? 0n)]));
}
