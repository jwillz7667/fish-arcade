# @reef/errors

`DomainError` base class, its subclasses, and the stable error code catalog. Every error the platform throws on purpose is one of these (CLAUDE.md error rules).

|          |                                           |
| -------- | ----------------------------------------- |
| Spec     | CLAUDE.md code standards, §12 error shape |
| Built in | Step 2 of `docs/BUILD_PLAYBOOK.md`        |

## Usage

```ts
import { ErrorCode, ConflictError } from '@reef/errors';

throw new ConflictError({
  code: ErrorCode.IDEMPOTENCY_CONFLICT,
  message: 'journal key reused with a different payload', // internal, logs only
});
```

Clients only ever see `code` and `safeMessage`. `message` and `cause` stay in logs.

| Class                        | Code                                  | HTTP |
| ---------------------------- | ------------------------------------- | ---- |
| `ValidationError`            | `VALIDATION_FAILED`, `INVALID_AMOUNT` | 400  |
| `AuthError`                  | `UNAUTHENTICATED`                     | 401  |
| `ForbiddenError`             | `FORBIDDEN`                           | 403  |
| `NotFoundError`              | `NOT_FOUND`                           | 404  |
| `ConflictError`              | `CONFLICT`, `IDEMPOTENCY_CONFLICT`    | 409  |
| `InsufficientFundsError`     | `INSUFFICIENT_FUNDS`                  | 422  |
| `RateLimitedError`           | `RATE_LIMITED`                        | 429  |
| `ComplianceBlockedError`     | `COMPLIANCE_BLOCKED`                  | 403  |
| `DependencyUnavailableError` | `DEPENDENCY_UNAVAILABLE`              | 503  |
| `ConfigError`                | `CONFIG_INVALID`                      | 500  |

Codes are append-only. Never rename or reuse one.

## Test

```sh
pnpm vitest run --project errors
```
