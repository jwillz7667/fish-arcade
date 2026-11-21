import { randomUUID } from 'node:crypto';

import type { FieldCipher } from '@reef/crypto-fields';
import { AuthError, ErrorCode, RateLimitedError } from '@reef/errors';
import type { Pool } from 'pg';

import { withTransaction } from '../../db/transaction.js';
import { AUTH_POLICY } from '../auth-policy.js';
import { addMs, type Clock } from '../clock.js';
import { safeEqual } from '../crypto/secrets.js';
import {
  accountExistsMessage,
  otpMessage,
  type MessageSenders,
  type OtpPurpose,
} from '../messaging/message-sender.js';
import type { Contact } from '../users/contact.js';
import { generateOtpCode, hashOtpCode } from './otp-code.js';
import { otpRepository, type OtpChallengeRecord } from './otp-repository.js';

const DESTINATION_FIELD = { table: 'otp_challenges', column: 'destination_enc' } as const;
const TTL_MINUTES = AUTH_POLICY.otp.ttlMs / 60_000;

/** What happens when a challenge is started or resent. */
export type OtpDelivery =
  /** Send a code. */
  | 'code'
  /** Send no code; tell the address it already has an account (signup only). */
  | 'account_exists_notice'
  /** Send nothing; the challenge can never verify (contact change to an address in use). */
  | 'none';

/** A verified challenge: proof that the player controls `contact`. */
export interface VerifiedOtp {
  readonly challengeId: string;
  readonly contact: Contact;
  readonly contactBidx: string;
  readonly userId: string | null;
}

/** Collaborators for {@link OtpService}. */
export interface OtpServiceDeps {
  readonly pool: Pool;
  readonly cipher: FieldCipher;
  readonly hmacKey: Buffer;
  readonly senders: MessageSenders;
  readonly clock: Clock;
}

/**
 * One-time codes by email or SMS (playbook Step 6): 6 digits, stored as an HMAC, valid for 10
 * minutes, 5 attempts per challenge, and a 60-second resend cooldown. Challenges that cannot
 * succeed behave exactly like real ones, so responses never reveal whether an account exists.
 */
export class OtpService {
  constructor(private readonly deps: OtpServiceDeps) {}

  /**
   * Creates a challenge and delivers it.
   *
   * @param input Purpose, destination, its blind index, the requesting user (contact
   *   changes), and what to deliver.
   * @returns The challenge ID the client verifies against.
   * @throws DependencyUnavailableError when the message provider is down.
   */
  async start(input: {
    purpose: OtpPurpose;
    contact: Contact;
    contactBidx: string;
    userId: string | null;
    delivery: OtpDelivery;
  }): Promise<string> {
    const id = randomUUID();
    const now = this.deps.clock.now();
    const code = input.delivery === 'code' ? generateOtpCode() : undefined;
    await otpRepository.insert(this.deps.pool, {
      id,
      purpose: input.purpose,
      channel: input.contact.channel,
      destinationEnc: await this.deps.cipher.encrypt(input.contact.value, DESTINATION_FIELD),
      destinationBidx: input.contactBidx,
      userId: input.userId,
      codeHash: code === undefined ? null : hashOtpCode(this.deps.hmacKey, id, code),
      now,
      expiresAt: addMs(now, AUTH_POLICY.otp.ttlMs),
    });
    await this.#deliver(input.purpose, input.contact, input.delivery, code);
    return id;
  }

  /**
   * Sends a new code for an existing challenge. The old code stops working; spent attempts
   * are kept, so resending never buys more guesses.
   *
   * @param challengeId Challenge to resend.
   * @param purpose Expected purpose.
   * @param userId For contact changes, the signed-in user, who must own the challenge.
   * @throws RateLimitedError within 60 seconds of the last send.
   * @throws AuthError OTP_ATTEMPTS_EXCEEDED after 5 sends or 5 failed attempts.
   * @throws AuthError OTP_INVALID for an unknown or already verified challenge.
   */
  async resend(challengeId: string, purpose: OtpPurpose, userId?: string): Promise<void> {
    const now = this.deps.clock.now();
    const plan = await withTransaction(this.deps.pool, async (client) => {
      const challenge = await otpRepository.lock(client, challengeId, purpose);
      if (
        challenge === undefined ||
        challenge.verifiedAt !== null ||
        (userId !== undefined && challenge.userId !== userId)
      ) {
        throw new AuthError({ code: ErrorCode.OTP_INVALID });
      }
      const readyAt = addMs(challenge.lastSentAt, AUTH_POLICY.otp.resendCooldownMs);
      if (readyAt > now) {
        throw new RateLimitedError({
          retryAfterSeconds: Math.ceil((readyAt.getTime() - now.getTime()) / 1000),
        });
      }
      if (
        challenge.sendCount >= AUTH_POLICY.otp.maxSends ||
        challenge.attempts >= AUTH_POLICY.otp.maxAttempts
      ) {
        throw new AuthError({ code: ErrorCode.OTP_ATTEMPTS_EXCEEDED });
      }
      const code = challenge.hasCode ? generateOtpCode() : undefined;
      await otpRepository.recordResend(client, {
        id: challengeId,
        codeHash: code === undefined ? null : hashOtpCode(this.deps.hmacKey, challengeId, code),
        now,
        expiresAt: addMs(now, AUTH_POLICY.otp.ttlMs),
      });
      return { challenge, code };
    });
    const delivery = this.#deliveryFor(plan.challenge);
    await this.#deliver(purpose, await this.#contactOf(plan.challenge), delivery, plan.code);
  }

  /**
   * Checks a code. Each call spends one attempt before comparing.
   *
   * @param input Challenge, code, purpose, and for contact changes the user who started it.
   * @returns The verified destination.
   * @throws AuthError OTP_EXPIRED, OTP_ATTEMPTS_EXCEEDED, or OTP_INVALID.
   */
  async verify(input: {
    challengeId: string;
    code: string;
    purpose: OtpPurpose;
    userId?: string;
  }): Promise<VerifiedOtp> {
    const now = this.deps.clock.now();
    const spent = await otpRepository.spendAttempt(this.deps.pool, {
      id: input.challengeId,
      purpose: input.purpose,
      now,
      maxAttempts: AUTH_POLICY.otp.maxAttempts,
    });
    if (spent === undefined) throw await this.#whyRejected(input.challengeId, input.purpose, now);

    const expected = hashOtpCode(this.deps.hmacKey, input.challengeId, input.code);
    // A challenge with no code still runs the comparison, so timing matches a wrong guess.
    const isMatch = safeEqual(expected, spent.codeHash ?? '') && spent.codeHash !== null;
    if (!isMatch) throw new AuthError({ code: ErrorCode.OTP_INVALID });

    const challenge = await otpRepository.find(this.deps.pool, input.challengeId, input.purpose);
    if (
      challenge === undefined ||
      (input.userId !== undefined && challenge.userId !== input.userId) ||
      !(await otpRepository.markVerified(this.deps.pool, input.challengeId, now))
    ) {
      throw new AuthError({ code: ErrorCode.OTP_INVALID });
    }
    return {
      challengeId: challenge.id,
      contact: await this.#contactOf(challenge),
      contactBidx: challenge.destinationBidx,
      userId: challenge.userId,
    };
  }

  /**
   * @param challengeId A challenge verified earlier, such as the one behind a signup ticket.
   * @param purpose Expected purpose.
   * @returns The verified destination.
   * @throws AuthError when the challenge is unknown or was never verified.
   */
  async loadVerified(challengeId: string, purpose: OtpPurpose): Promise<VerifiedOtp> {
    const challenge = await otpRepository.find(this.deps.pool, challengeId, purpose);
    if (challenge?.verifiedAt == null) throw new AuthError({ message: 'Challenge not verified' });
    return {
      challengeId,
      contact: await this.#contactOf(challenge),
      contactBidx: challenge.destinationBidx,
      userId: challenge.userId,
    };
  }

  async #whyRejected(challengeId: string, purpose: OtpPurpose, now: Date): Promise<AuthError> {
    const challenge = await otpRepository.find(this.deps.pool, challengeId, purpose);
    if (challenge === undefined || challenge.verifiedAt !== null) {
      return new AuthError({ code: ErrorCode.OTP_INVALID });
    }
    if (challenge.attempts >= AUTH_POLICY.otp.maxAttempts) {
      return new AuthError({ code: ErrorCode.OTP_ATTEMPTS_EXCEEDED });
    }
    return new AuthError({
      code: challenge.expiresAt <= now ? ErrorCode.OTP_EXPIRED : ErrorCode.OTP_INVALID,
    });
  }

  #deliveryFor(challenge: OtpChallengeRecord): OtpDelivery {
    if (challenge.hasCode) return 'code';
    return challenge.purpose === 'signup' ? 'account_exists_notice' : 'none';
  }

  async #contactOf(challenge: OtpChallengeRecord): Promise<Contact> {
    return {
      channel: challenge.channel,
      value: await this.deps.cipher.decrypt(challenge.destinationEnc, DESTINATION_FIELD),
    };
  }

  async #deliver(
    purpose: OtpPurpose,
    contact: Contact,
    delivery: OtpDelivery,
    code: string | undefined,
  ): Promise<void> {
    if (delivery === 'none') return;
    const body =
      delivery === 'code' && code !== undefined
        ? otpMessage(purpose, code, TTL_MINUTES)
        : accountExistsMessage();
    await this.deps.senders[contact.channel].send({ to: contact.value, ...body });
  }
}
