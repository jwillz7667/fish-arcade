import { DatabaseError } from 'pg';
import { describe, expect, it } from 'vitest';

import {
  isConnectionFailure,
  isRetryableTransactionFailure,
  isUniqueViolation,
} from './sql-errors.js';

function sqlError(code: string, constraint?: string): DatabaseError {
  const error = new DatabaseError('test', 0, 'error');
  error.code = code;
  if (constraint !== undefined) error.constraint = constraint;
  return error;
}

function systemError(code: string): Error {
  return Object.assign(new Error(`connect ${code}`), { code });
}

describe('SQL error classification', () => {
  it('matches unique violations by constraint', () => {
    expect([
      isUniqueViolation(sqlError('23505', 'a_key'), 'a_key'),
      isUniqueViolation(sqlError('23505', 'b_key'), 'a_key'),
      isUniqueViolation(new Error('x'), 'a_key'),
    ]).toEqual([true, false, false]);
  });

  it('retries deadlocks and serialization failures only', () => {
    expect(
      ['40P01', '40001', '23505', '42P01'].map((code) =>
        isRetryableTransactionFailure(sqlError(code)),
      ),
    ).toEqual([true, true, false, false]);
    expect(isRetryableTransactionFailure(new Error('x'))).toBe(false);
  });

  it('recognises connection failures', () => {
    expect([
      isConnectionFailure(sqlError('08006')),
      isConnectionFailure(sqlError('57P01')),
      isConnectionFailure(systemError('ECONNREFUSED')),
      isConnectionFailure(new Error('Connection terminated unexpectedly')),
    ]).toEqual([true, true, true, true]);
  });

  it('does not mistake statement errors or bugs for connection failures', () => {
    expect([
      isConnectionFailure(sqlError('23505')),
      isConnectionFailure(new TypeError('x is undefined')),
      isConnectionFailure('ECONNREFUSED'),
    ]).toEqual([false, false, false]);
  });
});
