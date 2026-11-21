import { timingSafeEqual } from 'node:crypto';

import {
  ConflictError,
  DependencyUnavailableError,
  ErrorCode,
  IntegrityError,
  isDomainError,
} from '@reef/errors';
import type { Pool, PoolClient } from 'pg';

import {
  isConnectionFailure,
  isRetryableTransactionFailure,
  isUniqueViolation,
} from './sql-errors.js';

/** Result of posting a journal. */
export interface PostedJournal {
  readonly journalId: string;
  /** True when the idempotency key had already been posted with the same payload. */
  readonly isReplay: boolean;
}

/** Writes a new journal inside the claimed transaction and returns its ID. */
export type JournalWrite = (client: PoolClient) => Promise<string>;

const IDEMPOTENCY_INDEX = 'journals_idempotency_key_key';
/** Deadlocks and serialization failures are retried until this many attempts in total. */
const MAX_ATTEMPTS = 3;

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

async function attempt(
  pool: Pool,
  idempotencyKey: string,
  requestHash: string,
  write: JournalWrite,
): Promise<PostedJournal> {
  const client = await pool.connect();
  let isUsable = true;
  try {
    await client.query('BEGIN');
    // Claims the key before any balance lock. A concurrent call with the same key waits here
    // until the first commits, then finds its journal and replays it. Without this it would
    // re-read the balance the first call already debited and fail with InsufficientFunds.
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [idempotencyKey]);
    const replay = await findPosted(client, idempotencyKey, requestHash);
    const result = replay ?? { journalId: await write(client), isReplay: false };
    await client.query('COMMIT');
    return result;
  } catch (error) {
    isUsable = await rollback(client);
    // The advisory lock makes this unreachable; it stays as a second line of defence.
    if (isUsable && isUniqueViolation(error, IDEMPOTENCY_INDEX)) {
      const replay = await findPosted(client, idempotencyKey, requestHash);
      if (replay !== undefined) return replay;
    }
    throw error;
  } finally {
    client.release(!isUsable);
  }
}

/**
 * Runs one journal write in its own transaction, idempotently (spec §10.2, playbook Step 4):
 * claims the key, replays an existing journal with the same key and request hash, or runs
 * `write`. Deadlocks and serialization failures are retried; the key makes that safe.
 *
 * @param pool Connection pool for reef_app.
 * @param claim The idempotency key and the hash of what the caller asked for.
 * @param write Writes the journal and returns its ID. Runs at most once per committed attempt.
 * @returns The journal ID and whether this call was a replay.
 * @throws ConflictError (IDEMPOTENCY_CONFLICT) when the key was used for a different request.
 * @throws DependencyUnavailableError when the database is unreachable or keeps aborting the
 *   transaction. Safe to retry with the same idempotency key.
 * @throws IntegrityError for any other database failure.
 * @throws DomainError raised by `write`, unchanged.
 */
export async function runJournalTransaction(
  pool: Pool,
  claim: { readonly idempotencyKey: string; readonly requestHash: string },
  write: JournalWrite,
): Promise<PostedJournal> {
  for (let attemptNumber = 1; ; attemptNumber += 1) {
    try {
      return await attempt(pool, claim.idempotencyKey, claim.requestHash, write);
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
