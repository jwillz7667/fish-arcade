import {
  DEFAULT_SAFE_MESSAGES,
  ErrorCode,
  isDomainError,
  RateLimitedError,
  ValidationError,
  type ValidationIssue,
} from '@reef/errors';

/** Body of every error response (playbook Step 5). */
export interface ErrorBody {
  readonly error: {
    readonly code: ErrorCode;
    readonly message: string;
    readonly requestId: string;
    /** Field-level problems, for validation errors only. Never echoes submitted values. */
    readonly issues?: readonly ValidationIssue[];
  };
}

/** What the HTTP layer sends for a thrown value. */
export interface ErrorResponse {
  readonly status: number;
  readonly body: ErrorBody;
  readonly headers: Readonly<Record<string, string>>;
  /** True for 5xx responses, which are logged with the error. */
  readonly isServerError: boolean;
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const value: unknown = Reflect.get(error, 'statusCode') ?? Reflect.get(error, 'status');
  return typeof value === 'number' && value >= 400 && value < 600 ? value : undefined;
}

function frameworkError(status: number): { code: ErrorCode; message: string } {
  if (status === 404 || status === 405) {
    return { code: ErrorCode.NOT_FOUND, message: DEFAULT_SAFE_MESSAGES.NOT_FOUND };
  }
  if (status === 429)
    return { code: ErrorCode.RATE_LIMITED, message: DEFAULT_SAFE_MESSAGES.RATE_LIMITED };
  return { code: ErrorCode.VALIDATION_FAILED, message: DEFAULT_SAFE_MESSAGES.VALIDATION_FAILED };
}

/**
 * Maps anything thrown during a request to a client-safe response. DomainErrors keep their
 * code, status, and safe message. Framework 4xx errors (unknown route, bad JSON, body too
 * large) get a catalog code and its default message. Everything else is a generic 500 with no
 * internal detail: never a stack trace, never `error.message`.
 *
 * @param error The thrown value.
 * @param requestId Correlates the response with logs.
 * @returns Status, body, and extra headers to send.
 */
export function toErrorResponse(error: unknown, requestId: string): ErrorResponse {
  if (isDomainError(error)) {
    const headers: Record<string, string> = {};
    if (error instanceof RateLimitedError && error.retryAfterSeconds !== undefined) {
      headers['retry-after'] = String(error.retryAfterSeconds);
    }
    return {
      status: error.httpStatus,
      body: {
        error: {
          code: error.code,
          message: error.safeMessage,
          requestId,
          ...(error instanceof ValidationError ? { issues: error.issues } : {}),
        },
      },
      headers,
      isServerError: error.httpStatus >= 500,
    };
  }
  const status = statusOf(error);
  if (status !== undefined && status < 500) {
    const { code, message } = frameworkError(status);
    return {
      status,
      body: { error: { code, message, requestId } },
      headers: {},
      isServerError: false,
    };
  }
  return {
    status: 500,
    body: {
      error: { code: ErrorCode.INTERNAL, message: DEFAULT_SAFE_MESSAGES.INTERNAL, requestId },
    },
    headers: {},
    isServerError: true,
  };
}
