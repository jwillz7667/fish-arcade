import type { BlindIndexer } from '@reef/crypto-fields';
import { AuthError, ErrorCode, isDomainError } from '@reef/errors';
import type { AuthenticationResponseJSON } from '@simplewebauthn/server';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { AuditWriter } from '../../audit/audit-writer.js';
import { AUTH_POLICY } from '../auth-policy.js';
import type { MfaService } from '../mfa/mfa-service.js';
import type { PasskeyService } from '../passkeys/passkey-service.js';
import type { PasswordHasher } from '../password/password-hasher.js';
import type { IssuedTokens, SessionService } from '../sessions/session-service.js';
import type { TicketStore } from '../tickets/ticket-store.js';
import { contactIndex, parseIdentifier } from '../users/contact.js';
import { userRepository } from '../users/user-repository.js';
import {
  accountSubject,
  ipSubject,
  secondFactorSubject,
  type BackoffThrottle,
  type ThrottleSubject,
} from './backoff-throttle.js';

/** What an MFA ticket stands for: a user who passed the password step. */
export const mfaTicketSchema = z.object({ userId: z.uuid(), throttleKey: z.string() });

/** Data behind an MFA ticket. */
export type MfaTicket = z.infer<typeof mfaTicketSchema>;

/** Outcome of the password step. */
export type PasswordLoginResult =
  | { readonly status: 'authenticated'; readonly tokens: IssuedTokens }
  | { readonly status: 'mfa_required'; readonly mfaTicket: string };

/** Collaborators for {@link LoginService}. */
export interface LoginServiceDeps {
  readonly pool: Pool;
  readonly blindIndexer: BlindIndexer;
  readonly hasher: PasswordHasher;
  readonly throttle: BackoffThrottle;
  readonly mfa: MfaService;
  readonly passkeys: PasskeyService;
  readonly sessions: SessionService;
  readonly mfaTickets: TicketStore<MfaTicket>;
  readonly audit: AuditWriter;
}

// A malformed identifier still gets throttled and hashed like a real one.
const UNPARSEABLE_IDENTIFIER_KEY = 'unparseable';

/**
 * Player login (playbook Step 6). Unknown accounts and wrong passwords produce the same status,
 * body, and timing (a dummy argon2 verification runs), and both count toward the same
 * per-identifier backoff, so responses never reveal whether an account exists.
 */
export class LoginService {
  constructor(private readonly deps: LoginServiceDeps) {}

  /**
   * @param input Email or phone as typed, password, and client IP.
   * @returns Tokens, or an MFA ticket when TOTP is enabled.
   * @throws RateLimitedError while the identifier or IP is backing off.
   * @throws AuthError INVALID_CREDENTIALS for an unknown account or wrong password.
   */
  async loginWithPassword(input: {
    identifier: string;
    password: string;
    ip: string;
  }): Promise<PasswordLoginResult> {
    const contact = parseIdentifier(input.identifier);
    const bidx =
      contact === undefined
        ? UNPARSEABLE_IDENTIFIER_KEY
        : contactIndex(this.deps.blindIndexer, contact);
    const subjects = [accountSubject(bidx), ipSubject(input.ip)];
    await this.#assertAllowed(subjects, input.ip);

    const user =
      contact === undefined
        ? undefined
        : await userRepository.findByContact(this.deps.pool, contact.channel, bidx);
    const usable =
      user !== undefined && user.status !== 'closed' && user.passwordHash !== null
        ? user
        : undefined;
    const check =
      usable?.passwordHash == null
        ? { isValid: await this.deps.hasher.verifyAgainstDummy(input.password), needsRehash: false }
        : await this.deps.hasher.verify(usable.passwordHash, input.password);

    if (usable === undefined || !check.isValid) {
      await this.deps.throttle.recordFailure(subjects);
      // Unauthenticated, so no actor; the targeted account (if any) is recorded for forensics.
      await this.#audit('auth.login.failed', null, input.ip, usable?.id);
      throw new AuthError({ code: ErrorCode.INVALID_CREDENTIALS });
    }
    await this.deps.throttle.reset(accountSubject(bidx));
    if (check.needsRehash) {
      await userRepository.updatePasswordHash(
        this.deps.pool,
        usable.id,
        await this.deps.hasher.hash(input.password),
      );
    }

    if (await this.deps.mfa.isEnrolled(usable.id)) {
      const mfaTicket = await this.deps.mfaTickets.issue({ userId: usable.id, throttleKey: bidx });
      await this.#audit('auth.login.mfa_required', usable.id, input.ip);
      return { status: 'mfa_required', mfaTicket };
    }
    await this.#audit('auth.login.succeeded', usable.id, input.ip);
    return {
      status: 'authenticated',
      tokens: await this.deps.sessions.start({ userId: usable.id, amr: ['pwd'], ip: input.ip }),
    };
  }

  /**
   * Second step for accounts with TOTP: a 6-digit code or a recovery code.
   *
   * @param input MFA ticket, code, and client IP.
   * @returns Tokens for the new session.
   * @throws AuthError when the ticket is unknown or expired, OTP_INVALID for a wrong code, or
   *   OTP_ATTEMPTS_EXCEEDED after 5 wrong codes on one ticket.
   * @throws RateLimitedError while the account is backing off.
   */
  async completeMfa(input: { mfaTicket: string; code: string; ip: string }): Promise<IssuedTokens> {
    const ticket = await this.deps.mfaTickets.peek(input.mfaTicket);
    if (ticket === undefined) throw new AuthError({ message: 'Unknown or expired MFA ticket' });
    const subjects = [
      accountSubject(ticket.throttleKey),
      secondFactorSubject(ticket.userId),
      ipSubject(input.ip),
    ];
    await this.#assertAllowed(subjects, input.ip);
    if (
      (await this.deps.mfaTickets.countAttempt(input.mfaTicket)) > AUTH_POLICY.mfaTicket.maxAttempts
    ) {
      await this.deps.mfaTickets.revoke(input.mfaTicket);
      throw new AuthError({ code: ErrorCode.OTP_ATTEMPTS_EXCEEDED });
    }

    let factor: Awaited<ReturnType<MfaService['verifySecondFactor']>>;
    try {
      factor = await this.deps.mfa.verifySecondFactor({
        userId: ticket.userId,
        code: input.code,
        ip: input.ip,
      });
    } catch (error) {
      if (isDomainError(error) && error.code === ErrorCode.OTP_INVALID) {
        await this.deps.throttle.recordFailure(subjects);
        await this.#audit('auth.login.mfa_failed', null, input.ip, ticket.userId);
      }
      throw error;
    }
    if ((await this.deps.mfaTickets.take(input.mfaTicket)) === undefined) {
      throw new AuthError({ message: 'MFA ticket already used' });
    }
    await this.deps.throttle.reset(secondFactorSubject(ticket.userId));
    await this.#audit('auth.login.succeeded', ticket.userId, input.ip);
    return this.deps.sessions.start({
      userId: ticket.userId,
      amr: factor === 'totp' ? ['pwd', 'otp', 'mfa'] : ['pwd', 'mfa'],
      ip: input.ip,
    });
  }

  /**
   * Passkey login. User verification is required, so this counts as multi-factor.
   *
   * @param input Challenge ID, browser response, and client IP.
   * @returns Tokens for the new session.
   * @throws AuthError INVALID_CREDENTIALS when the passkey does not verify.
   * @throws RateLimitedError while the IP is backing off.
   */
  async loginWithPasskey(input: {
    challengeId: string;
    response: AuthenticationResponseJSON;
    ip: string;
  }): Promise<IssuedTokens> {
    const subjects = [ipSubject(input.ip)];
    await this.#assertAllowed(subjects, input.ip);
    let userId: string;
    try {
      ({ userId } = await this.deps.passkeys.finishLogin(input));
    } catch (error) {
      if (isDomainError(error) && error.code === ErrorCode.INVALID_CREDENTIALS) {
        await this.deps.throttle.recordFailure(subjects);
        await this.#audit('auth.login.failed', null, input.ip);
      }
      throw error;
    }
    await this.#audit('auth.login.succeeded', userId, input.ip);
    return this.deps.sessions.start({ userId, amr: ['hwk', 'mfa'], ip: input.ip });
  }

  async #assertAllowed(subjects: readonly ThrottleSubject[], ip: string): Promise<void> {
    try {
      await this.deps.throttle.assertAllowed(subjects);
    } catch (error) {
      if (isDomainError(error) && error.code === ErrorCode.RATE_LIMITED) {
        await this.#audit('auth.login.throttled', null, ip);
      }
      throw error;
    }
  }

  async #audit(
    action: string,
    actorId: string | null,
    ip: string,
    targetUserId: string | undefined = actorId ?? undefined,
  ): Promise<void> {
    await this.deps.audit.record({
      actorType: 'player',
      actorId,
      action,
      ...(targetUserId === undefined ? {} : { targetType: 'user', targetId: targetUserId }),
      ip,
    });
  }
}
