import { randomUUID } from 'node:crypto';

import type { FieldEncryption } from '@reef/crypto-fields';
import { AuthError, ComplianceBlockedError, ConflictError, isDomainError } from '@reef/errors';
import type {
  PublicKeyCredentialCreationOptionsJSON,
  RegistrationResponseJSON,
} from '@simplewebauthn/server';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { AuditWriter } from '../../audit/audit-writer.js';
import {
  decideJurisdiction,
  type JurisdictionRule,
  type JurisdictionService,
} from '../../compliance/index.js';
import { isUniqueViolationOn, withTransaction } from '../../db/transaction.js';
import type { BotVerifier } from '../bot/turnstile-verifier.js';
import type { Clock } from '../../shared/clock.js';
import { assertCurrentDocumentsAccepted, recordSignupConsents } from '../../legal/index.js';
import type { OtpService } from '../otp/otp-service.js';
import type { NewPasskey } from '../passkeys/passkey-repository.js';
import type { PasskeyService } from '../passkeys/passkey-service.js';
import type { BreachedPasswordChecker } from '../password/breached-password-checker.js';
import type { PasswordHasher } from '../password/password-hasher.js';
import { assertPasswordNotBreached } from '../password/password-policy.js';
import type { IssuedTokens, SessionService } from '../sessions/session-service.js';
import type { TicketStore } from '../tickets/ticket-store.js';
import { contactIndex, type Contact } from '../users/contact.js';
import { CONTACT_UNIQUE_CONSTRAINTS, userRepository } from '../users/user-repository.js';
import { assertMinimumAge, type SignupProfile } from './signup-profile.js';

/** What a signup ticket stands for: a verified OTP challenge and the account ID to create. */
export const signupTicketSchema = z.object({
  challengeId: z.uuid(),
  userId: z.uuid(),
  webauthnChallenge: z.string().optional(),
});

/** Data behind a signup ticket. */
export type SignupTicket = z.infer<typeof signupTicketSchema>;

/** How the new account will sign in. */
export type SignupCredential =
  | { readonly type: 'password'; readonly password: string }
  | { readonly type: 'passkey'; readonly response: RegistrationResponseJSON };

/** Collaborators for {@link SignupService}. */
export interface SignupServiceDeps {
  readonly pool: Pool;
  readonly jurisdictions: JurisdictionService;
  readonly encryption: FieldEncryption;
  readonly otp: OtpService;
  readonly sessions: SessionService;
  readonly passkeys: PasskeyService;
  readonly hasher: PasswordHasher;
  readonly breachChecker: BreachedPasswordChecker;
  readonly botVerifier: BotVerifier;
  readonly tickets: TicketStore<SignupTicket>;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

const contactField = (contact: Contact) =>
  ({ table: 'users', column: contact.channel === 'email' ? 'email_enc' : 'phone_enc' }) as const;
const DOB_FIELD = { table: 'profiles', column: 'dob_enc' } as const;

/**
 * Player signup (spec §5.1): bot check, OTP to email or phone, then password or passkey and
 * profile. Starting signup with an address that already has an account looks exactly the same
 * to the caller; the owner gets a notice instead of a code.
 */
export class SignupService {
  constructor(private readonly deps: SignupServiceDeps) {}

  /**
   * @param input Contact, Turnstile token, and client IP.
   * @returns The OTP challenge to verify.
   * @throws ForbiddenError BOT_CHECK_FAILED, or DependencyUnavailableError.
   */
  async start(input: {
    contact: Contact;
    turnstileToken: string;
    ip: string | null;
  }): Promise<{ challengeId: string }> {
    await this.deps.botVerifier.verify(input.turnstileToken, input.ip);
    const bidx = contactIndex(this.deps.encryption.blindIndexer, input.contact);
    const existing = await userRepository.findByContact(
      this.deps.pool,
      input.contact.channel,
      bidx,
    );
    const challengeId = await this.deps.otp.start({
      purpose: 'signup',
      contact: input.contact,
      contactBidx: bidx,
      userId: null,
      delivery: existing === undefined ? 'code' : 'account_exists_notice',
    });
    await this.#audit('auth.signup.started', null, input.ip, {
      challengeId,
      channel: input.contact.channel,
    });
    return { challengeId };
  }

  /**
   * @param input Challenge, code, and client IP.
   * @returns A 15-minute single-use signup ticket.
   * @throws AuthError OTP_INVALID, OTP_EXPIRED, or OTP_ATTEMPTS_EXCEEDED.
   */
  async verifyCode(input: {
    challengeId: string;
    code: string;
    ip: string | null;
  }): Promise<{ signupTicket: string }> {
    try {
      await this.deps.otp.verify({
        challengeId: input.challengeId,
        code: input.code,
        purpose: 'signup',
      });
    } catch (error) {
      if (isDomainError(error)) {
        await this.#audit('auth.otp.failed', null, input.ip, {
          challengeId: input.challengeId,
          code: error.code,
        });
      }
      throw error;
    }
    await this.#audit('auth.otp.verified', null, input.ip, { challengeId: input.challengeId });
    const signupTicket = await this.deps.tickets.issue({
      challengeId: input.challengeId,
      userId: randomUUID(),
    });
    return { signupTicket };
  }

  /**
   * Passkey signup, step 1: registration options bound to the signup ticket.
   *
   * @param input Ticket and the display name shown in the passkey picker.
   * @returns Options for `navigator.credentials.create()`.
   * @throws AuthError when the ticket is unknown or expired.
   */
  async passkeyOptions(input: {
    signupTicket: string;
    displayName: string;
  }): Promise<PublicKeyCredentialCreationOptionsJSON> {
    const ticket = await this.#ticket(input.signupTicket);
    const options = await this.deps.passkeys.buildRegistrationOptions({
      userId: ticket.userId,
      userName: input.displayName,
    });
    await this.deps.tickets.replace(input.signupTicket, {
      ...ticket,
      webauthnChallenge: options.challenge,
    });
    return options;
  }

  /**
   * Creates the account and signs it in. Everything that can fail on input is checked before
   * the ticket is spent, so a rejected password does not force the player to start over.
   *
   * @param input Ticket, profile, credential, client IP, and the rule of the state the device is
   *   in (from the jurisdiction gate).
   * @returns Tokens for the new session.
   * @throws ComplianceBlockedError when the declared home state does not allow signup, or the
   *   player is under the higher of the two states' minimum ages.
   * @throws ValidationError when the password is breached.
   * @throws AuthError when the ticket is invalid or the passkey fails verification.
   * @throws ConflictError when the contact was registered concurrently.
   * @throws ValidationError when `acceptedDocumentIds` are not the legal documents in force.
   * @throws DependencyUnavailableError when a signup document has no version in force.
   */
  async complete(input: {
    signupTicket: string;
    profile: SignupProfile;
    credential: SignupCredential;
    acceptedDocumentIds: readonly string[];
    ip: string;
    locationRule: JurisdictionRule;
  }): Promise<IssuedTokens> {
    const now = this.deps.clock.now();
    // Both where the player is and where they say they live must allow signup; the stricter
    // minimum age applies.
    const homeRule = await this.deps.jurisdictions.ruleFor(input.profile.stateCode);
    if (!decideJurisdiction('signup', homeRule).isAllowed || homeRule === undefined) {
      throw new ComplianceBlockedError({ message: 'Home state does not allow signup' });
    }
    assertMinimumAge(
      input.profile.dateOfBirth,
      now,
      Math.max(input.locationRule.minAge, homeRule.minAge),
    );
    await assertCurrentDocumentsAccepted(this.deps.pool, {
      acceptedIds: input.acceptedDocumentIds,
      at: now,
    });
    const ticket = await this.#ticket(input.signupTicket);
    const verified = await this.deps.otp.loadVerified(ticket.challengeId, 'signup');

    let passwordHash: string | null = null;
    let passkey: NewPasskey | undefined;
    if (input.credential.type === 'password') {
      await assertPasswordNotBreached(input.credential.password, this.deps.breachChecker);
      passwordHash = await this.deps.hasher.hash(input.credential.password);
    } else {
      if (ticket.webauthnChallenge === undefined)
        throw new AuthError({ message: 'No passkey options issued' });
      passkey = await this.deps.passkeys.verifyRegistration(
        input.credential.response,
        ticket.webauthnChallenge,
      );
    }

    if ((await this.deps.tickets.take(input.signupTicket)) === undefined) {
      throw new AuthError({ message: 'Signup ticket already used' });
    }
    const { cipher } = this.deps.encryption;
    const contactEnc = await cipher.encrypt(verified.contact.value, contactField(verified.contact));
    const dobEnc = await cipher.encrypt(input.profile.dateOfBirth, DOB_FIELD);
    try {
      await withTransaction(this.deps.pool, async (client) => {
        await userRepository.insertPlayer(client, {
          id: ticket.userId,
          channel: verified.contact.channel,
          contactEnc,
          contactBidx: verified.contactBidx,
          passwordHash,
          displayName: input.profile.displayName,
          dobEnc,
          stateCode: input.profile.stateCode,
        });
        if (passkey !== undefined) {
          await this.deps.passkeys.savePasskey(client, ticket.userId, passkey, input.ip);
        }
        await recordSignupConsents(client, {
          userId: ticket.userId,
          acceptedIds: input.acceptedDocumentIds,
          ip: input.ip,
          at: now,
        });
        await this.#audit(
          'auth.signup.completed',
          ticket.userId,
          input.ip,
          { method: input.credential.type },
          client,
        );
      });
    } catch (error) {
      if (isUniqueViolationOn(error, CONTACT_UNIQUE_CONSTRAINTS)) {
        throw new ConflictError({ message: 'Contact registered concurrently', cause: error });
      }
      throw error;
    }
    return this.deps.sessions.start({
      userId: ticket.userId,
      amr: input.credential.type === 'password' ? ['otp', 'pwd'] : ['otp', 'hwk'],
      ip: input.ip,
    });
  }

  async #ticket(signupTicket: string): Promise<SignupTicket> {
    const ticket = await this.deps.tickets.peek(signupTicket);
    if (ticket === undefined) throw new AuthError({ message: 'Unknown or expired signup ticket' });
    return ticket;
  }

  async #audit(
    action: string,
    userId: string | null,
    ip: string | null,
    details: Record<string, string>,
    client?: Parameters<AuditWriter['record']>[1],
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actorType: 'player',
        actorId: userId,
        action,
        // Before the account exists, the OTP challenge is the only record to point at.
        ...(userId === null
          ? {
              targetType: 'otp_challenge',
              ...(details['challengeId'] === undefined ? {} : { targetId: details['challengeId'] }),
            }
          : { targetType: 'user', targetId: userId }),
        details,
        ip,
      },
      client,
    );
  }
}
