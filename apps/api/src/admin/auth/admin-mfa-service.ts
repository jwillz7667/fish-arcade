import type { FieldCipher } from '@reef/crypto-fields';
import { AuthError, ConflictError, ErrorCode } from '@reef/errors';
import type { Pool } from 'pg';

import { generateTotpSecret, totpUri, verifyTotp } from '../../auth/mfa/totp.js';
import type { Clock } from '../../shared/clock.js';

const SECRET_FIELD = { table: 'admin_mfa', column: 'totp_secret_enc' } as const;
const PENDING_FIELD = { table: 'admin_mfa', column: 'totp_pending_secret_enc' } as const;
const SETUP_TTL_MS = 10 * 60_000;

interface AdminMfaRow {
  totp_secret_enc: string | null;
  totp_enabled_at: Date | null;
  totp_last_time_step: number | null;
  totp_pending_secret_enc: string | null;
  totp_pending_created_at: Date | null;
}

/**
 * Mandatory TOTP for admins (playbook Step 9). Unlike players there are no recovery codes: an
 * admin who loses their device is reset by a super admin, which is audited.
 */
export class AdminMfaService {
  constructor(private readonly deps: { pool: Pool; cipher: FieldCipher; clock: Clock }) {}

  /**
   * @param adminId Admin.
   * @returns True when TOTP is set up.
   */
  async isEnrolled(adminId: string): Promise<boolean> {
    return (await this.#find(adminId))?.totp_enabled_at != null;
  }

  /**
   * @param adminId Admin enrolling.
   * @returns The secret and `otpauth://` URI.
   * @throws ConflictError when TOTP is already set up.
   */
  async beginSetup(adminId: string): Promise<{ secret: string; otpauthUri: string }> {
    if (await this.isEnrolled(adminId))
      throw new ConflictError({ message: 'Admin TOTP already enabled' });
    const secret = generateTotpSecret();
    await this.deps.pool.query(
      `INSERT INTO admin_mfa (admin_user_id, totp_pending_secret_enc, totp_pending_created_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (admin_user_id) DO UPDATE
         SET totp_pending_secret_enc = EXCLUDED.totp_pending_secret_enc,
             totp_pending_created_at = EXCLUDED.totp_pending_created_at`,
      [adminId, await this.deps.cipher.encrypt(secret, PENDING_FIELD), this.deps.clock.now()],
    );
    return { secret, otpauthUri: totpUri(secret, 'Reef back office') };
  }

  /**
   * @param adminId Admin enrolling.
   * @param code Code from the authenticator app.
   * @throws AuthError OTP_EXPIRED when setup was not started in the last 10 minutes.
   * @throws AuthError OTP_INVALID when the code is wrong.
   */
  async confirmSetup(adminId: string, code: string): Promise<void> {
    const now = this.deps.clock.now();
    const row = await this.#find(adminId);
    const pending = row?.totp_pending_secret_enc ?? null;
    const startedAt = row?.totp_pending_created_at ?? null;
    if (
      pending === null ||
      startedAt === null ||
      now.getTime() - startedAt.getTime() > SETUP_TTL_MS
    ) {
      throw new AuthError({ code: ErrorCode.OTP_EXPIRED });
    }
    const secret = await this.deps.cipher.decrypt(pending, PENDING_FIELD);
    const timeStep = await verifyTotp({ secret, code, lastTimeStep: null, now });
    if (timeStep === undefined) throw new AuthError({ code: ErrorCode.OTP_INVALID });
    const result = await this.deps.pool.query(
      `UPDATE admin_mfa
          SET totp_secret_enc = $3, totp_enabled_at = $4, totp_last_time_step = $5,
              totp_pending_secret_enc = NULL, totp_pending_created_at = NULL
        WHERE admin_user_id = $1 AND totp_pending_secret_enc = $2 AND totp_enabled_at IS NULL`,
      [adminId, pending, await this.deps.cipher.encrypt(secret, SECRET_FIELD), now, timeStep],
    );
    if (result.rowCount !== 1)
      throw new ConflictError({ message: 'Admin TOTP setup changed concurrently' });
  }

  /**
   * Checks a code and records its time step, so each code works once.
   *
   * @param adminId Admin.
   * @param code 6-digit code.
   * @throws AuthError OTP_INVALID when the code is wrong, replayed, or TOTP is not set up.
   */
  async verify(adminId: string, code: string): Promise<void> {
    const row = await this.#find(adminId);
    if (row?.totp_secret_enc == null) throw new AuthError({ code: ErrorCode.OTP_INVALID });
    const timeStep = await verifyTotp({
      secret: await this.deps.cipher.decrypt(row.totp_secret_enc, SECRET_FIELD),
      code,
      lastTimeStep: row.totp_last_time_step,
      now: this.deps.clock.now(),
    });
    const advanced =
      timeStep !== undefined &&
      (
        await this.deps.pool.query(
          `UPDATE admin_mfa SET totp_last_time_step = $2
            WHERE admin_user_id = $1 AND (totp_last_time_step IS NULL OR totp_last_time_step < $2)`,
          [adminId, timeStep],
        )
      ).rowCount === 1;
    if (!advanced) throw new AuthError({ code: ErrorCode.OTP_INVALID });
  }

  async #find(adminId: string): Promise<AdminMfaRow | undefined> {
    const { rows } = await this.deps.pool.query<AdminMfaRow>(
      `SELECT totp_secret_enc, totp_enabled_at, totp_last_time_step, totp_pending_secret_enc,
              totp_pending_created_at
         FROM admin_mfa WHERE admin_user_id = $1`,
      [adminId],
    );
    return rows[0];
  }
}
