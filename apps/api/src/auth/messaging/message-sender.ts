import type { ContactChannel } from '../users/contact.js';

/** A plain-text message to one player. The body may hold a one-time code: never log it. */
export interface OutboundMessage {
  /** Email address or E.164 number, matching the sender's channel. */
  readonly to: string;
  /** Email subject; SMS senders ignore it. */
  readonly subject: string;
  readonly text: string;
}

/**
 * Delivers player messages on one channel. Implementations throw DependencyUnavailableError
 * when the provider cannot accept the message, so the action that needed it fails closed.
 */
export interface MessageSender {
  /** @param message What to send and where. */
  send(message: OutboundMessage): Promise<void>;
}

/** One sender per channel. */
export type MessageSenders = Readonly<Record<ContactChannel, MessageSender>>;

/** What a one-time code is for. Matches the `OtpPurpose` enum. */
export type OtpPurpose = 'signup' | 'contact_change';

function purposeText(purpose: OtpPurpose): string {
  switch (purpose) {
    case 'signup':
      return 'finish creating your Reef account';
    case 'contact_change':
      return 'confirm your new contact details on Reef';
  }
}

/**
 * @param purpose Why the code was sent.
 * @param code The 6-digit code.
 * @param minutes How long it stays valid.
 * @returns Subject and body for the code message.
 */
export function otpMessage(
  purpose: OtpPurpose,
  code: string,
  minutes: number,
): Omit<OutboundMessage, 'to'> {
  return {
    subject: `Your Reef code is ${code}`,
    text: `Your Reef code is ${code}. Use it to ${purposeText(purpose)}. It expires in ${String(minutes)} minutes. Reef will never ask you for this code.`,
  };
}

/**
 * Sent instead of a code when someone starts signup with an address that already has an
 * account, so the API response stays identical and the real owner learns of the attempt.
 *
 * @returns Subject and body.
 */
export function accountExistsMessage(): Omit<OutboundMessage, 'to'> {
  return {
    subject: 'Someone tried to sign up with your details',
    text: 'Someone tried to create a Reef account with these contact details, which already belong to an account. If it was you, sign in instead. If not, you can ignore this message.',
  };
}
