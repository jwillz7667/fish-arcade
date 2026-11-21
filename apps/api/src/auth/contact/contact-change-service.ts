import type { FieldEncryption } from '@reef/crypto-fields';
import { ConflictError } from '@reef/errors';
import type { Pool } from 'pg';

import type { AuditWriter } from '../../audit/audit-writer.js';
import { isUniqueViolationOn, withTransaction } from '../../db/transaction.js';
import type { OtpService } from '../otp/otp-service.js';
import type { SessionService } from '../sessions/session-service.js';
import { contactIndex, type Contact } from '../users/contact.js';
import { CONTACT_UNIQUE_CONSTRAINTS, userRepository } from '../users/user-repository.js';

/** Collaborators for {@link ContactChangeService}. */
export interface ContactChangeServiceDeps {
  readonly pool: Pool;
  readonly encryption: FieldEncryption;
  readonly otp: OtpService;
  readonly sessions: SessionService;
  readonly audit: AuditWriter;
}

/**
 * Changing a player's email or phone (playbook Step 6). The route requires step-up; the new
 * address must then be proven with an OTP. An address that already belongs to an account gets
 * no message, and its challenge can never verify, so the flow cannot be used to probe for
 * accounts.
 */
export class ContactChangeService {
  constructor(private readonly deps: ContactChangeServiceDeps) {}

  /**
   * @param input Signed-in user, new contact, and client IP.
   * @returns The OTP challenge sent to the new contact.
   * @throws DependencyUnavailableError when the message provider is down.
   */
  async start(input: {
    userId: string;
    contact: Contact;
    ip: string | null;
  }): Promise<{ challengeId: string }> {
    const bidx = contactIndex(this.deps.encryption.blindIndexer, input.contact);
    const owner = await userRepository.findByContact(this.deps.pool, input.contact.channel, bidx);
    const challengeId = await this.deps.otp.start({
      purpose: 'contact_change',
      contact: input.contact,
      contactBidx: bidx,
      userId: input.userId,
      delivery: owner === undefined ? 'code' : 'none',
    });
    await this.deps.audit.record({
      actorType: 'player',
      actorId: input.userId,
      action: 'auth.contact.change_requested',
      targetType: 'user',
      targetId: input.userId,
      details: { channel: input.contact.channel, challengeId },
      ip: input.ip,
    });
    return { challengeId };
  }

  /**
   * Applies the change once the code checks out, and signs out every other session.
   *
   * @param input User, current session, challenge, code, and client IP.
   * @throws AuthError OTP_INVALID, OTP_EXPIRED, or OTP_ATTEMPTS_EXCEEDED.
   * @throws ConflictError when another account took the address meanwhile.
   */
  async verify(input: {
    userId: string;
    sessionId: string;
    challengeId: string;
    code: string;
    ip: string | null;
  }): Promise<void> {
    const verified = await this.deps.otp.verify({
      challengeId: input.challengeId,
      code: input.code,
      purpose: 'contact_change',
      userId: input.userId,
    });
    const column = verified.contact.channel === 'email' ? 'email_enc' : 'phone_enc';
    const enc = await this.deps.encryption.cipher.encrypt(verified.contact.value, {
      table: 'users',
      column,
    });
    try {
      await withTransaction(this.deps.pool, async (client) => {
        await userRepository.updateContact(client, {
          userId: input.userId,
          channel: verified.contact.channel,
          enc,
          bidx: verified.contactBidx,
        });
        await this.deps.audit.record(
          {
            actorType: 'player',
            actorId: input.userId,
            action: 'auth.contact.changed',
            targetType: 'user',
            targetId: input.userId,
            details: { channel: verified.contact.channel },
            ip: input.ip,
          },
          client,
        );
      });
    } catch (error) {
      if (isUniqueViolationOn(error, CONTACT_UNIQUE_CONSTRAINTS)) {
        throw new ConflictError({ message: 'Contact taken concurrently', cause: error });
      }
      throw error;
    }
    await this.deps.sessions.revokeOthers({
      userId: input.userId,
      keepSessionId: input.sessionId,
      reason: 'contact_changed',
      ip: input.ip,
    });
  }
}
