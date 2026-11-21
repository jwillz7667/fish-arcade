import type { FieldCipher } from '@reef/crypto-fields';
import { AuthError, ConflictError, ErrorCode, ForbiddenError } from '@reef/errors';
import type { Pool } from 'pg';

import type { AuditWriter } from '../../audit/audit-writer.js';
import { withTransaction } from '../../db/transaction.js';
import { AUTH_POLICY } from '../auth-policy.js';
import { addMs, type Clock } from '../clock.js';
import { mfaRepository } from './mfa-repository.js';
import { generateRecoveryCodes, hashRecoveryCode } from './recovery-codes.js';
import { generateTotpSecret, totpUri, verifyTotp } from './totp.js';

const SECRET_FIELD = { table: 'user_mfa', column: 'totp_secret_enc' } as const;
const PENDING_FIELD = { table: 'user_mfa', column: 'totp_pending_secret_enc' } as const;
const TOTP_CODE = /^\d{6}$/;

/** Which second factor a code turned out to be. */
export type SecondFactorKind = 'totp' | 'recovery_code';

/** Collaborators for {@link MfaService}. */
export interface MfaServiceDeps {
  readonly pool: Pool;
  readonly cipher: FieldCipher;
  readonly hmacKey: Buffer;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * TOTP two-factor auth and recovery codes (playbook Step 6). Secrets are field-encrypted;
 * recovery codes are stored as HMACs and each works once.
 */
export class MfaService {
  constructor(private readonly deps: MfaServiceDeps) {}

  /**
   * @param userId User to check.
   * @returns True when TOTP is enabled.
   */
  async isEnrolled(userId: string): Promise<boolean> {
    const record = await mfaRepository.find(this.deps.pool, userId);
    return record?.totpEnabledAt != null;
  }

  /**
   * Starts enrolment. Nothing changes for login until {@link confirmTotpSetup} succeeds.
   *
   * @param userId Enrolling user.
   * @returns The secret and an `otpauth://` URI for the authenticator app.
   * @throws ConflictError when TOTP is already enabled.
   */
  async beginTotpSetup(userId: string): Promise<{ secret: string; otpauthUri: string }> {
    if (await this.isEnrolled(userId)) throw new ConflictError({ message: 'TOTP already enabled' });
    const secret = generateTotpSecret();
    const pending = await this.deps.cipher.encrypt(secret, PENDING_FIELD);
    await mfaRepository.setPending(this.deps.pool, userId, pending, this.deps.clock.now());
    return { secret, otpauthUri: totpUri(secret, 'Reef account') };
  }

  /**
   * Finishes enrolment with a code from the app and issues 10 recovery codes.
   *
   * @param input User, code, and client IP.
   * @returns The recovery codes, in plaintext, for the client to show once.
   * @throws AuthError OTP_EXPIRED when setup started over 10 minutes ago or never started.
   * @throws AuthError OTP_INVALID when the code is wrong.
   */
  async confirmTotpSetup(input: {
    userId: string;
    code: string;
    ip: string | null;
  }): Promise<{ recoveryCodes: string[] }> {
    const now = this.deps.clock.now();
    const record = await mfaRepository.find(this.deps.pool, input.userId);
    const pending = record?.totpPendingSecretEnc ?? null;
    const startedAt = record?.totpPendingCreatedAt ?? null;
    if (
      pending === null ||
      startedAt === null ||
      addMs(startedAt, AUTH_POLICY.totpSetupTtlMs) <= now
    ) {
      throw new AuthError({ code: ErrorCode.OTP_EXPIRED });
    }
    const secret = await this.deps.cipher.decrypt(pending, PENDING_FIELD);
    const timeStep = await verifyTotp({ secret, code: input.code, lastTimeStep: null, now });
    if (timeStep === undefined) throw new AuthError({ code: ErrorCode.OTP_INVALID });

    const recoveryCodes = generateRecoveryCodes();
    const secretEnc = await this.deps.cipher.encrypt(secret, SECRET_FIELD);
    await withTransaction(this.deps.pool, async (client) => {
      const didEnable = await mfaRepository.enable(client, {
        userId: input.userId,
        pendingSecretEnc: pending,
        secretEnc,
        timeStep,
        at: now,
      });
      if (!didEnable) throw new ConflictError({ message: 'TOTP setup changed concurrently' });
      await mfaRepository.replaceRecoveryCodes(
        client,
        input.userId,
        recoveryCodes.map((code) => hashRecoveryCode(this.deps.hmacKey, input.userId, code)),
      );
      await this.#audit('auth.totp.enabled', input.userId, input.ip, client);
    });
    return { recoveryCodes };
  }

  /**
   * Checks a second factor: a 6-digit TOTP code or a recovery code. Spends the recovery code,
   * or records the TOTP time step so the same code cannot be used twice.
   *
   * @param input User, code, and client IP.
   * @returns Which factor matched.
   * @throws ForbiddenError MFA_NOT_ENROLLED when the user has no TOTP.
   * @throws AuthError OTP_INVALID when the code is wrong or already used.
   */
  async verifySecondFactor(input: {
    userId: string;
    code: string;
    ip: string | null;
  }): Promise<SecondFactorKind> {
    const record = await mfaRepository.find(this.deps.pool, input.userId);
    if (record?.totpSecretEnc == null || record.totpEnabledAt === null) {
      throw new ForbiddenError({ code: ErrorCode.MFA_NOT_ENROLLED });
    }
    if (TOTP_CODE.test(input.code)) {
      const secret = await this.deps.cipher.decrypt(record.totpSecretEnc, SECRET_FIELD);
      const timeStep = await verifyTotp({
        secret,
        code: input.code,
        lastTimeStep: record.totpLastTimeStep,
        now: this.deps.clock.now(),
      });
      if (
        timeStep === undefined ||
        !(await mfaRepository.advanceTimeStep(this.deps.pool, input.userId, timeStep))
      ) {
        throw new AuthError({ code: ErrorCode.OTP_INVALID });
      }
      return 'totp';
    }
    const hash = hashRecoveryCode(this.deps.hmacKey, input.userId, input.code);
    if (!(await mfaRepository.consumeRecoveryCode(this.deps.pool, input.userId, hash))) {
      throw new AuthError({ code: ErrorCode.OTP_INVALID });
    }
    await this.#audit('auth.recovery_code.used', input.userId, input.ip);
    return 'recovery_code';
  }

  /**
   * Turns TOTP off and deletes recovery codes. Callers must require step-up first.
   *
   * @param input User and client IP.
   */
  async disable(input: { userId: string; ip: string | null }): Promise<void> {
    await withTransaction(this.deps.pool, async (client) => {
      await mfaRepository.disable(client, input.userId);
      await this.#audit('auth.totp.disabled', input.userId, input.ip, client);
    });
  }

  async #audit(
    action: string,
    userId: string,
    ip: string | null,
    client?: Parameters<AuditWriter['record']>[1],
  ): Promise<void> {
    await this.deps.audit.record(
      { actorType: 'player', actorId: userId, action, targetType: 'user', targetId: userId, ip },
      client,
    );
  }
}
