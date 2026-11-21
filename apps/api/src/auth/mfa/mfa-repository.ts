import type { Queryable } from '../../audit/audit-writer.js';

/** A user's `user_mfa` row. */
export interface MfaRecord {
  readonly totpSecretEnc: string | null;
  readonly totpEnabledAt: Date | null;
  readonly totpLastTimeStep: number | null;
  readonly totpPendingSecretEnc: string | null;
  readonly totpPendingCreatedAt: Date | null;
}

interface MfaRow {
  totp_secret_enc: string | null;
  totp_enabled_at: Date | null;
  totp_last_time_step: number | null;
  totp_pending_secret_enc: string | null;
  totp_pending_created_at: Date | null;
}

/** SQL for `user_mfa` and `recovery_codes`. Every value is a bound parameter. */
export const mfaRepository = {
  /**
   * @param client Pool or transaction client.
   * @param userId Account.
   * @returns The account's TOTP state, or undefined when it never started enrolment.
   */
  async find(client: Queryable, userId: string): Promise<MfaRecord | undefined> {
    const { rows } = await client.query<MfaRow>(
      `SELECT totp_secret_enc, totp_enabled_at, totp_last_time_step, totp_pending_secret_enc,
              totp_pending_created_at
         FROM user_mfa WHERE user_id = $1`,
      [userId],
    );
    const [row] = rows;
    if (row === undefined) return undefined;
    return {
      totpSecretEnc: row.totp_secret_enc,
      totpEnabledAt: row.totp_enabled_at,
      totpLastTimeStep: row.totp_last_time_step,
      totpPendingSecretEnc: row.totp_pending_secret_enc,
      totpPendingCreatedAt: row.totp_pending_created_at,
    };
  },

  /**
   * Stores a TOTP secret awaiting confirmation, replacing any earlier pending one.
   *
   * @param client Pool or transaction client.
   * @param userId Account.
   * @param secretEnc Encrypted secret.
   * @param at When enrolment started, for its expiry.
   */
  async setPending(client: Queryable, userId: string, secretEnc: string, at: Date): Promise<void> {
    await client.query(
      `INSERT INTO user_mfa (user_id, totp_pending_secret_enc, totp_pending_created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id) DO UPDATE
         SET totp_pending_secret_enc = EXCLUDED.totp_pending_secret_enc,
             totp_pending_created_at = EXCLUDED.totp_pending_created_at`,
      [userId, secretEnc, at],
    );
  },

  /**
   * Promotes the pending secret, if it is still the one the caller verified.
   *
   * @returns True when TOTP is now enabled by this call.
   */
  async enable(
    client: Queryable,
    input: {
      userId: string;
      pendingSecretEnc: string;
      secretEnc: string;
      timeStep: number;
      at: Date;
    },
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE user_mfa
          SET totp_secret_enc = $3, totp_enabled_at = $5, totp_last_time_step = $4,
              totp_pending_secret_enc = NULL, totp_pending_created_at = NULL
        WHERE user_id = $1 AND totp_pending_secret_enc = $2 AND totp_enabled_at IS NULL`,
      [input.userId, input.pendingSecretEnc, input.secretEnc, input.timeStep, input.at],
    );
    return result.rowCount === 1;
  },

  /**
   * Records an accepted time step. The condition makes replay protection atomic: two requests
   * racing with the same code cannot both succeed.
   *
   * @returns True when the step was newer than every step accepted before.
   */
  async advanceTimeStep(client: Queryable, userId: string, timeStep: number): Promise<boolean> {
    const result = await client.query(
      `UPDATE user_mfa SET totp_last_time_step = $2
        WHERE user_id = $1 AND totp_enabled_at IS NOT NULL
          AND (totp_last_time_step IS NULL OR totp_last_time_step < $2)`,
      [userId, timeStep],
    );
    return result.rowCount === 1;
  },

  /**
   * Turns TOTP off and deletes the recovery codes.
   *
   * @param client Transaction client.
   * @param userId Account.
   */
  async disable(client: Queryable, userId: string): Promise<void> {
    await client.query(
      `UPDATE user_mfa
          SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_time_step = NULL,
              totp_pending_secret_enc = NULL, totp_pending_created_at = NULL
        WHERE user_id = $1`,
      [userId],
    );
    await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
  },

  /**
   * Replaces every recovery code, so old ones stop working.
   *
   * @param client Transaction client.
   * @param userId Account.
   * @param codeHashes Hashes of the new codes.
   */
  async replaceRecoveryCodes(
    client: Queryable,
    userId: string,
    codeHashes: readonly string[],
  ): Promise<void> {
    await client.query('DELETE FROM recovery_codes WHERE user_id = $1', [userId]);
    await client.query(
      `INSERT INTO recovery_codes (user_id, code_hash) SELECT $1, unnest($2::text[])`,
      [userId, codeHashes],
    );
  },

  /** @returns True when an unused matching code existed and is now spent. */
  async consumeRecoveryCode(client: Queryable, userId: string, codeHash: string): Promise<boolean> {
    const result = await client.query(
      `UPDATE recovery_codes SET used_at = now()
        WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL`,
      [userId, codeHash],
    );
    return result.rowCount === 1;
  },
};
