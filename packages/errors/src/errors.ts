import { DomainError } from './domain-error.js';
import { ErrorCode } from './error-codes.js';

/** Optional fields every DomainError subclass accepts. */
export interface DomainErrorOptions {
  /** Internal message for logs. Never sent to clients. */
  readonly message?: string;
  /** Client-safe message override. */
  readonly safeMessage?: string;
  /** Underlying error, kept for logs. */
  readonly cause?: unknown;
}

/** One field-level problem in a {@link ValidationError}. Safe to send to clients. */
export interface ValidationIssue {
  /** Dotted path to the offending field, or an empty string for the whole input. */
  readonly path: string;
  /** What is wrong, without echoing the submitted value. */
  readonly message: string;
}

/** Codes a {@link ValidationError} may carry. */
export type ValidationErrorCode =
  typeof ErrorCode.VALIDATION_FAILED | typeof ErrorCode.INVALID_AMOUNT;

/** Input was malformed or out of range. HTTP 400. */
export class ValidationError extends DomainError {
  /** Field-level problems, safe to return to the client. */
  readonly issues: readonly ValidationIssue[];

  /**
   * @param options Message, code, and field-level issues.
   */
  constructor(
    options: DomainErrorOptions & {
      readonly code?: ValidationErrorCode;
      readonly issues?: readonly ValidationIssue[];
    } = {},
  ) {
    super({ ...options, code: options.code ?? ErrorCode.VALIDATION_FAILED, httpStatus: 400 });
    this.issues = options.issues ?? [];
  }
}

/** Codes an {@link AuthError} may carry. */
export type AuthErrorCode =
  | typeof ErrorCode.UNAUTHENTICATED
  | typeof ErrorCode.INVALID_CREDENTIALS
  | typeof ErrorCode.OTP_INVALID
  | typeof ErrorCode.OTP_EXPIRED
  | typeof ErrorCode.OTP_ATTEMPTS_EXCEEDED
  | typeof ErrorCode.STEP_UP_REQUIRED;

/** The caller is not authenticated, or their credentials are invalid. HTTP 401. */
export class AuthError extends DomainError {
  /** @param options Message overrides, cause, and a specific auth code. */
  constructor(options: DomainErrorOptions & { readonly code?: AuthErrorCode } = {}) {
    super({ ...options, code: options.code ?? ErrorCode.UNAUTHENTICATED, httpStatus: 401 });
  }
}

/** Codes a {@link ForbiddenError} may carry. */
export type ForbiddenErrorCode =
  | typeof ErrorCode.FORBIDDEN
  | typeof ErrorCode.CSRF_INVALID
  | typeof ErrorCode.MFA_NOT_ENROLLED
  | typeof ErrorCode.BOT_CHECK_FAILED;

/** The caller is authenticated but lacks permission, or a request check failed. HTTP 403. */
export class ForbiddenError extends DomainError {
  /** @param options Message overrides, cause, and a specific code. */
  constructor(options: DomainErrorOptions & { readonly code?: ForbiddenErrorCode } = {}) {
    super({ ...options, code: options.code ?? ErrorCode.FORBIDDEN, httpStatus: 403 });
  }
}

/** The resource does not exist or the caller may not know it exists. HTTP 404. */
export class NotFoundError extends DomainError {
  /** @param options Message overrides and cause. */
  constructor(options: DomainErrorOptions = {}) {
    super({ ...options, code: ErrorCode.NOT_FOUND, httpStatus: 404 });
  }
}

/** Codes a {@link ConflictError} may carry. */
export type ConflictErrorCode = typeof ErrorCode.CONFLICT | typeof ErrorCode.IDEMPOTENCY_CONFLICT;

/** The request conflicts with current state, such as a reused idempotency key. HTTP 409. */
export class ConflictError extends DomainError {
  /** @param options Message overrides, cause, and a specific conflict code. */
  constructor(options: DomainErrorOptions & { readonly code?: ConflictErrorCode } = {}) {
    super({ ...options, code: options.code ?? ErrorCode.CONFLICT, httpStatus: 409 });
  }
}

/** The caller exceeded a rate limit. HTTP 429. */
export class RateLimitedError extends DomainError {
  /** Seconds the client should wait before retrying, when known. */
  readonly retryAfterSeconds: number | undefined;

  /** @param options Message overrides, cause, and the retry delay. */
  constructor(options: DomainErrorOptions & { readonly retryAfterSeconds?: number } = {}) {
    super({ ...options, code: ErrorCode.RATE_LIMITED, httpStatus: 429 });
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}

/** Codes a {@link ComplianceBlockedError} may carry. */
export type ComplianceErrorCode =
  typeof ErrorCode.COMPLIANCE_BLOCKED | typeof ErrorCode.GEO_CHECK_REQUIRED;

/**
 * A compliance control (geofence, KYC, sanctions, responsible gaming) blocks the action.
 * HTTP 403. Spec §15: compliance checks fail closed.
 */
export class ComplianceBlockedError extends DomainError {
  /** @param options Message overrides, cause, and a specific compliance code. */
  constructor(options: DomainErrorOptions & { readonly code?: ComplianceErrorCode } = {}) {
    super({ ...options, code: options.code ?? ErrorCode.COMPLIANCE_BLOCKED, httpStatus: 403 });
  }
}

/** The account balance cannot cover the requested debit. HTTP 422. */
export class InsufficientFundsError extends DomainError {
  /** @param options Message overrides and cause. */
  constructor(options: DomainErrorOptions = {}) {
    super({ ...options, code: ErrorCode.INSUFFICIENT_FUNDS, httpStatus: 422 });
  }
}

/**
 * A dependency (database, price oracle, KYC vendor, chain screening) is down or returned
 * unusable data. HTTP 503. CLAUDE.md: actions that depend on it fail closed.
 */
export class DependencyUnavailableError extends DomainError {
  /** Name of the dependency that failed, for logs and metrics. */
  readonly dependency: string;

  /** @param options The failing dependency, message overrides, and cause. */
  constructor(options: DomainErrorOptions & { readonly dependency: string }) {
    super({ ...options, code: ErrorCode.DEPENDENCY_UNAVAILABLE, httpStatus: 503 });
    this.dependency = options.dependency;
  }
}

/** Process configuration is missing or invalid. Raised at startup only. HTTP 500. */
export class ConfigError extends DomainError {
  /** Each invalid variable with what is wrong. Never includes the value. */
  readonly issues: readonly ValidationIssue[];

  /** @param options The invalid variables, message overrides, and cause. */
  constructor(options: DomainErrorOptions & { readonly issues: readonly ValidationIssue[] }) {
    super({ ...options, code: ErrorCode.CONFIG_INVALID, httpStatus: 500 });
    this.issues = options.issues;
  }
}

/**
 * Stored data failed an integrity check, such as a ciphertext whose authentication tag does
 * not match. Never caused by client input. HTTP 500.
 */
export class IntegrityError extends DomainError {
  /** @param options Message overrides and cause. */
  constructor(options: DomainErrorOptions = {}) {
    super({ ...options, code: ErrorCode.INTEGRITY_VIOLATION, httpStatus: 500 });
  }
}
