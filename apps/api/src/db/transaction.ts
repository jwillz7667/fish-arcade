import { DatabaseError, type Pool, type PoolClient } from 'pg';

/**
 * Runs `work` in a READ COMMITTED transaction on one pooled client. Commits when it resolves;
 * rolls back and rethrows when it throws.
 *
 * @param pool The reef_app pool.
 * @param work Queries to run; receives the transaction client.
 * @returns What `work` returns.
 */
export async function withTransaction<T>(
  pool: Pool,
  work: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * @param error Anything thrown by a query.
 * @param constraints Unique constraint or index names that count.
 * @returns True when `error` is a Postgres unique violation on one of them.
 */
export function isUniqueViolationOn(error: unknown, constraints: readonly string[]): boolean {
  return (
    error instanceof DatabaseError &&
    error.code === '23505' &&
    error.constraint !== undefined &&
    constraints.includes(error.constraint)
  );
}
