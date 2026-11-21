/**
 * Player auth limits (playbook Step 6, spec §5.1). Kept in one place so reviews and tests read
 * the same numbers.
 */
export const AUTH_POLICY = {
  otp: {
    digits: 6,
    ttlMs: 10 * 60_000,
    maxAttempts: 5,
    resendCooldownMs: 60_000,
    // Sends per challenge, first send included; after that the player starts again.
    maxSends: 5,
  },
  password: { minLength: 12, maxLength: 128 },
  accessTokenTtlMs: 10 * 60_000,
  // Step-up: a fresh login within 5 minutes plus a 2FA code.
  stepUpMaxAuthAgeMs: 5 * 60_000,
  signupTicketTtlSeconds: 15 * 60,
  mfaTicket: { ttlSeconds: 5 * 60, maxAttempts: 5 },
  webauthnChallengeTtlSeconds: 5 * 60,
  totpSetupTtlMs: 10 * 60_000,
  recoveryCodeCount: 10,
  minimumAgeYears: 18,
} as const;

/** Exponential backoff after repeated failures, per subject (account, IP, or user). */
export interface BackoffPolicy {
  /** Failures allowed before any delay. */
  readonly freeFailures: number;
  /** Delay after the first counted failure; doubles with each one after. */
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  /** Failures are forgotten this long after the last one. */
  readonly windowMs: number;
}

/** Login throttling per account identifier. Unknown identifiers are throttled the same way. */
export const ACCOUNT_BACKOFF: BackoffPolicy = {
  freeFailures: 5,
  baseDelayMs: 1_000,
  maxDelayMs: 15 * 60_000,
  windowMs: 60 * 60_000,
};

/** Login throttling per client IP. Looser than per account: many players can share an IP. */
export const IP_BACKOFF: BackoffPolicy = {
  freeFailures: 20,
  baseDelayMs: 1_000,
  maxDelayMs: 15 * 60_000,
  windowMs: 60 * 60_000,
};

/**
 * @param failures Failures so far in the window, including the one just recorded.
 * @param policy Backoff policy.
 * @returns How long the subject must wait before the next attempt, in ms (0 for no wait).
 */
export function backoffDelayMs(failures: number, policy: BackoffPolicy): number {
  const counted = failures - policy.freeFailures;
  if (counted <= 0) return 0;
  // Cap the exponent so the shift never overflows before the max-delay clamp.
  const exponent = Math.min(counted - 1, 30);
  return Math.min(policy.baseDelayMs * 2 ** exponent, policy.maxDelayMs);
}
