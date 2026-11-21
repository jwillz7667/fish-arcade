# @reef/logger

pino JSON logger. Request IDs come from `AsyncLocalStorage`, and secrets and PII are redacted by key name at any depth.

|          |                                    |
| -------- | ---------------------------------- |
| Spec     | §16, CLAUDE.md security rules      |
| Built in | Step 2 of `docs/BUILD_PLAYBOOK.md` |

## Usage

```ts
const context = new RequestContext();
const logger = createLogger({ service: 'api', level: env.LOG_LEVEL, context });

context.run({ requestId }, () => logger.info({ userId }, 'login succeeded'));
```

## Redaction

`isSensitiveKey` splits a key into words (camelCase, snake_case, kebab-case, UPPER_CASE), then decides in this order:

1. The last word is `secret` or `key`: redacted (`clientSecret`, `API_KEY`, `x-api-key`, `idempotencyKey`).
2. The last word is `id` or `ids`: kept, because record IDs are what we log (`tokenId`, `payoutAddressId`).
3. Any word is sensitive (`password`, `token`, `authorization`, `cookie`, `otp`, `secret`, `apikey`, `ssn`, `dob`, `birth`, `address`, `email`, `phone`, `xpub`, `xprv`, `descriptor`, `seed`, `mnemonic`), or the whole key is a sensitive phrase (`firstName`, `lastName`, `fullName`, `legalName`), or the key ends in `url` and names a database or Redis (`DATABASE_URL`, `DATABASE_ADMIN_URL`, `REDIS_URL`): redacted.

This applies to log payloads, root and child bindings, and fields on errors and their causes. Bigints are written as strings. **Message strings are not inspected, so never interpolate data into them.**

When you add a sensitive field, extend the lists in `src/redact.ts` and add the key to `src/redact.test.ts`.

## Test

```sh
pnpm vitest run --project logger
```
