/**
 * Stable error codes sent to clients in `{ error: { code } }`. Clients and dashboards key off
 * these strings, so a published code is never renamed or reused for a different meaning.
 */
export const ErrorCode = {
  VALIDATION_FAILED: 'VALIDATION_FAILED',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  CONFIG_INVALID: 'CONFIG_INVALID',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  CONFLICT: 'CONFLICT',
  IDEMPOTENCY_CONFLICT: 'IDEMPOTENCY_CONFLICT',
  RATE_LIMITED: 'RATE_LIMITED',
  COMPLIANCE_BLOCKED: 'COMPLIANCE_BLOCKED',
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
  FORBIDDEN: 'You do not have permission to do this.',
  NOT_FOUND: 'The requested resource was not found.',
  CONFLICT: 'The request conflicts with the current state.',
  IDEMPOTENCY_CONFLICT: 'This idempotency key was already used with a different request.',
  RATE_LIMITED: 'Too many requests. Try again later.',
  COMPLIANCE_BLOCKED: 'This action is not available for your account or location.',
  INSUFFICIENT_FUNDS: 'Insufficient balance.',
  DEPENDENCY_UNAVAILABLE: 'The service is temporarily unavailable. Try again later.',
  INTEGRITY_VIOLATION: 'Something went wrong.',
  INTERNAL: 'Something went wrong.',
};
