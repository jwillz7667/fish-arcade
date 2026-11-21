/**
 * Stable error codes sent to clients in `{ error: { code } }`. Clients and dashboards key off
 * these strings, so a published code is never renamed or reused for a different meaning.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  CONFIG_INVALID: 'CONFIG_INVALID',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_CREDENTIALS: 'INVALID_CREDENTIALS',
  OTP_INVALID: 'OTP_INVALID',
  OTP_EXPIRED: 'OTP_EXPIRED',
  OTP_ATTEMPTS_EXCEEDED: 'OTP_ATTEMPTS_EXCEEDED',
  STEP_UP_REQUIRED: 'STEP_UP_REQUIRED',
  FORBIDDEN: 'FORBIDDEN',
  CSRF_INVALID: 'CSRF_INVALID',
  MFA_NOT_ENROLLED: 'MFA_NOT_ENROLLED',
  BOT_CHECK_FAILED: 'BOT_CHECK_FAILED',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  COMPLIANCE_BLOCKED: 'COMPLIANCE_BLOCKED',
  GEO_CHECK_REQUIRED: 'GEO_CHECK_REQUIRED',
  KYC_REQUIRED: 'KYC_REQUIRED',
  REDEMPTION_SUSPENDED: 'REDEMPTION_SUSPENDED',
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  DEPENDENCY_UNAVAILABLE: 'DEPENDENCY_UNAVAILABLE',
  INTEGRITY_VIOLATION: 'INTEGRITY_VIOLATION',
  INTERNAL: 'INTERNAL',
} as const;

/** Union of every value in {@link ErrorCode}. */
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

/** Client-safe default message for each code. Never includes internal detail. */
export const DEFAULT_SAFE_MESSAGES: Readonly<Record<ErrorCode, string>> = {
  VALIDATION_FAILED: 'The request is invalid.',
  INVALID_AMOUNT: 'The amount is invalid.',
  CONFIG_INVALID: 'The service is misconfigured.',
  UNAUTHENTICATED: 'Authentication is required.',
  INVALID_CREDENTIALS: 'The sign-in details are incorrect.',
  OTP_INVALID: 'The code is incorrect.',
  OTP_EXPIRED: 'The code has expired. Request a new one.',
  OTP_ATTEMPTS_EXCEEDED: 'Too many incorrect codes. Request a new one.',
  STEP_UP_REQUIRED: 'Sign in again and enter your two-factor code to continue.',
  FORBIDDEN: 'You do not have permission to do this.',
  CSRF_INVALID: 'The request could not be verified. Reload and try again.',
  MFA_NOT_ENROLLED: 'Turn on two-factor authentication to continue.',
  BOT_CHECK_FAILED: 'The bot check failed. Try again.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'The request conflicts with the current state.',
  IDEMPOTENCY_CONFLICT: 'This idempotency key was already used with a different request.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  COMPLIANCE_BLOCKED: 'This action is not available for your account or location.',
  GEO_CHECK_REQUIRED: 'Confirm your location to continue.',
  KYC_REQUIRED: 'Verify your identity to continue.',
  REDEMPTION_SUSPENDED: 'Redemptions are on hold for this account. Contact support.',
  INSUFFICIENT_FUNDS: 'Insufficient balance.',
  DEPENDENCY_UNAVAILABLE: 'The service is temporarily unavailable. Try again later.',
  INTEGRITY_VIOLATION: 'Something went wrong.',
  INTERNAL: 'Something went wrong.',
};
