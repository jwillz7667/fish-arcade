import type { BlindIndexer } from '@reef/crypto-fields';
import { z } from 'zod';

/** How we reach a player: email or SMS. Matches the `OtpChannel` enum. */
export type ContactChannel = 'email' | 'sms';

/** A validated, normalised email address or E.164 phone number. */
export interface Contact {
  readonly channel: ContactChannel;
  readonly value: string;
}

const E164 = /^\+[1-9]\d{7,14}$/;
const emailSchema = z.email().max(254);

/** Request-body schema for a contact: `{ channel, destination }`. */
export const contactSchema = z
  .object({ channel: z.enum(['email', 'sms']), destination: z.string().trim().min(1).max(254) })
  .superRefine((input, ctx) => {
    const isValid =
      input.channel === 'email'
        ? emailSchema.safeParse(input.destination).success
        : E164.test(input.destination);
    if (!isValid) {
      ctx.addIssue({
        code: 'custom',
        path: ['destination'],
        message:
          input.channel === 'email'
            ? 'must be an email address'
            : 'must be E.164, like +15551234567',
      });
    }
  })
  .transform((input): Contact => toContact(input.channel, input.destination));

/**
 * @param channel Email or SMS.
 * @param destination Validated address or number.
 * @returns The contact, with emails lowercased so storage matches the blind index.
 */
export function toContact(channel: ContactChannel, destination: string): Contact {
  const value = destination.trim();
  return { channel, value: channel === 'email' ? value.toLowerCase() : value };
}

/**
 * Reads a login identifier: an email if it contains `@`, otherwise an E.164 number.
 *
 * @param identifier What the player typed.
 * @returns The contact, or undefined when it is neither.
 */
export function parseIdentifier(identifier: string): Contact | undefined {
  const value = identifier.trim();
  if (value.includes('@')) {
    return emailSchema.safeParse(value).success ? toContact('email', value) : undefined;
  }
  return E164.test(value) ? toContact('sms', value) : undefined;
}

/**
 * @param indexer Blind indexer.
 * @param contact Contact to index.
 * @returns The `email_bidx` or `phone_bidx` value.
 */
export function contactIndex(indexer: BlindIndexer, contact: Contact): string {
  return indexer.index(contact.value, contact.channel === 'email' ? 'email' : 'phone');
}
