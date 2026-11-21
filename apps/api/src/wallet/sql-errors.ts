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
