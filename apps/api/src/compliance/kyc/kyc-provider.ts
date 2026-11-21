import type { KycLevel, KycStatus } from './kyc-status.js';

/** A vendor verification session the client SDK completes. */
export interface KycSession {
  /** Vendor's ID for the check; the only vendor data Reef stores, with the outcome. */
  readonly vendorRef: string;
  /** Short-lived token the client passes to the vendor SDK. */
  readonly sdkToken: string;
  readonly expiresAt: Date;
}

/** The vendor's current verdict on a check. */
export interface KycResult {
  readonly status: KycStatus;
  /** Vendor reason codes, such as `document_expired`. Never PII. */
  readonly reasons: readonly string[];
}

/** A webhook event whose signature and timestamp have been verified. */
export interface KycWebhookEvent {
  readonly eventId: string;
  readonly vendorRef: string;
}

/** A raw inbound webhook. */
export interface KycWebhookRequest {
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly rawBody: Buffer;
  readonly now: Date;
}

/**
 * A KYC vendor (spec §15: Persona, Sumsub, Veriff, Jumio, Socure). Documents and selfies go to
 * the vendor through its SDK; Reef never receives or stores them.
 */
export interface KycProvider {
  /** Stored in `kyc_checks.vendor` and used to scope webhook dedupe. */
  readonly name: string;

  /**
   * @param input The account and the level of check.
   * @returns A session for the client SDK.
   * @throws DependencyUnavailableError when the vendor is unreachable.
   */
  createSession(input: { userId: string; level: KycLevel }): Promise<KycSession>;

  /**
   * Fetches the verdict from the vendor. Webhook bodies are never trusted for the outcome.
   *
   * @param vendorRef The check.
   * @returns The current verdict.
   * @throws DependencyUnavailableError when the vendor is unreachable or does not know the check.
   */
  getResult(vendorRef: string): Promise<KycResult>;

  /**
   * @param request Headers, exact raw body, and the current time.
   * @returns The verified event.
   * @throws AuthError when the signature is missing, wrong, or older than 5 minutes.
   */
  verifyWebhook(request: KycWebhookRequest): KycWebhookEvent;
}
