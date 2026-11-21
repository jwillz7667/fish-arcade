import { DatabaseError } from 'pg';

/**
 * True when `error` is a Postgres unique violation on `constraint`.
 *
 * @param error Anything thrown by a query.
 * @param constraint Constraint or unique index name.
 * @returns Whether it is that unique violation.
 */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  return (
    error instanceof DatabaseError && error.code === '23505' && error.constraint === constraint
  );
}

/**
 * True for a deadlock (40P01) or serialization failure (40001). Postgres aborted the whole
 * transaction, and running it again can succeed.
 *
 * @param error Anything thrown by a query.
 * @returns Whether a retry of the whole transaction can succeed.
 */
export function isRetryableTransactionFailure(error: unknown): boolean {
  return error instanceof DatabaseError && (error.code === '40P01' || error.code === '40001');
}

/**
 * True when reaching the database failed, rather than a statement: SQLSTATE class 08
 * (connection exception) or 57P01-57P03 (server shutting down or not yet up), a socket error
 * (ECONNREFUSED, ECONNRESET, ...), or pg's own "Connection terminated" error.
 *
 * @param error Anything thrown by `pool.connect()` or a query.
 * @returns Whether the failure was in the connection.
 */
export function isConnectionFailure(error: unknown): boolean {
  if (error instanceof DatabaseError) {
    const code = error.code ?? '';
    return code.startsWith('08') || ['57P01', '57P02', '57P03'].includes(code);
  }
  if (!(error instanceof Error)) return false;
  const code: unknown = Reflect.get(error, 'code');
  return (
    (typeof code === 'string' && /^E[A-Z]+$/.test(code)) ||
    error.message.startsWith('Connection terminated')
  );
}
