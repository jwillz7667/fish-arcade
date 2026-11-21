import { DEFAULT_SAFE_MESSAGES, type ErrorCode } from './error-codes.js';

/** Constructor input for {@link DomainError}. */
export interface DomainErrorInit {
  /** Stable code from the catalog. */
  readonly code: ErrorCode;
  /** HTTP status the API boundary maps this error to. */
  readonly httpStatus: number;
  /** Internal message for logs. Never sent to clients. Defaults to the safe message. */
  readonly message?: string;
  /** Message that is safe to show a client. Defaults to the catalog message for the code. */
  readonly safeMessage?: string;
  /** Underlying error, kept for logs. */
  readonly cause?: unknown;
}

/**
 * Base class for every error the platform throws on purpose. The API boundary sends only
 * `code` and `safeMessage` to clients; `message` and `cause` stay in logs.
 */
export abstract class DomainError extends Error {
  /** Stable code from the catalog. */
  readonly code: ErrorCode;
  /** HTTP status the API boundary maps this error to. */
  readonly httpStatus: number;
  /** Message that is safe to show a client. */
  readonly safeMessage: string;

  protected constructor(init: DomainErrorInit) {
    const safeMessage = init.safeMessage ?? DEFAULT_SAFE_MESSAGES[init.code];
    super(
      init.message ?? safeMessage,
      init.cause === undefined ? undefined : { cause: init.cause },
    );
    this.name = new.target.name;
    this.code = init.code;
    this.httpStatus = init.httpStatus;
    this.safeMessage = safeMessage;
  }
}

/**
 * Type guard for {@link DomainError}.
 *
 * @param value Anything caught in a `catch` block.
 * @returns True when `value` is a DomainError.
 */
export function isDomainError(value: unknown): value is DomainError {
  return value instanceof DomainError;
}
