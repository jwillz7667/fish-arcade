# @reef/api

NestJS API: auth, accounts, lobby, cashier, promotions, compliance, admin API, and the wallet/ledger module.

|          |                                                  |
| -------- | ------------------------------------------------ |
| Spec     | §5, §8.2, §10, §12, §13, §15, §22                |
| Built in | Steps 4 to 9, 13, 14 of `docs/BUILD_PLAYBOOK.md` |

## Run

```sh
pnpm --filter @reef/api dev      # tsx watch against workspace sources
pnpm --filter @reef/api build && pnpm --filter @reef/api start
```

Env: everything in `apiEnvSchema` (`/.env.example`). Startup prints which variables are missing or invalid and exits 1.

## HTTP skeleton (Step 5)

| Concern          | Where                                      | Behaviour                                                                                                                                                                                                                                                                                                                                           |
| ---------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Prefix           | `createApp`                                | Every route lives under `/v1`                                                                                                                                                                                                                                                                                                                       |
| Probes           | `health/`                                  | `/v1/health` is liveness. `/v1/ready` checks Postgres and Redis, each with a 1 s timeout, and returns 503 if either fails. Neither is rate limited                                                                                                                                                                                                  |
| Security headers | `@fastify/helmet`                          | CSP `default-src 'none'`, HSTS 2 years with preload, `no-referrer`, same-site CORP                                                                                                                                                                                                                                                                  |
| CORS             | `enableCors`                               | Exact origins from `CORS_ORIGINS`. Wildcards are rejected at boot, and plain http is rejected in production                                                                                                                                                                                                                                         |
| Request IDs      | Fastify `genReqId` + `onRequest` hook      | Reuses a well-formed upstream `x-request-id`, otherwise mints a UUID. Echoed in the response and attached to every log line through AsyncLocalStorage                                                                                                                                                                                               |
| Validation       | `StandardSchemaValidationPipe` (global)    | Routes declare `@Body({ schema })` or `@Query({ schema })` with zod; failures become `ValidationError` with field issues                                                                                                                                                                                                                            |
| Errors           | `DomainExceptionFilter`                    | Every error is `{ error: { code, message, requestId, issues? } }`. Unknown errors are a generic 500 with no internal detail; they are logged once, here                                                                                                                                                                                             |
| Rate limits      | `RateLimitGuard` (global)                  | Redis fixed window: `RATE_LIMIT_PER_MINUTE` per IP on every route, plus `@RateLimit({ limit, windowSeconds, by })` per route. Returns 429 with `Retry-After`, and 503 if Redis is down (fail closed)                                                                                                                                                |
| Client IP        | `TRUST_PROXY_HOPS`                         | Trusts exactly that many proxies, so `X-Forwarded-For` cannot be spoofed past the load balancer                                                                                                                                                                                                                                                     |
| Idempotency      | `@MoneyRoute()` + `IdempotencyInterceptor` | Requires `Idempotency-Key` (8–128 of `A-Za-z0-9_:-`) and an authenticated caller. The first request claims the key with `SET NX`; a concurrent duplicate gets 409; a retry within 24 h replays the stored body with `Idempotent-Replayed: true`; the same key with a different request is `IDEMPOTENCY_CONFLICT`. A failed request releases the key |
| OpenAPI          | `createApp`                                | `/v1/openapi.json` outside production only                                                                                                                                                                                                                                                                                                          |
| Shutdown         | `main.ts`                                  | SIGTERM/SIGINT drain in-flight requests (new connections get 503, keep-alive sockets close after their response), then close the pool and Redis. Forced exit after `SHUTDOWN_TIMEOUT_MS`                                                                                                                                                            |

Handlers behind `@MoneyRoute()` must still pass an idempotency key into `postJournal`. The HTTP store is a fast path, and the ledger is the guarantee.

## Wallet (`src/wallet`, spec §10)

The only code that writes ledger tables. Lint enforces this: outside `src/wallet`, `test/wallet`, and `packages/db`, it is an error to name a ledger table in SQL, to touch `prisma.ledgerEntry` and the other ledger delegates, or to deep-import wallet internals.

`postJournal(pool, journal)` runs as one transaction:

1. Validate. Zero-sum is checked per currency; the database checks it again at commit.
2. If the idempotency key exists with the same payload hash (compared with `timingSafeEqual`), return the existing journal with `isReplay: true`. If it exists with a different payload, throw `ConflictError(IDEMPOTENCY_CONFLICT)`.
3. Create any missing accounts and balance rows, and verify that existing ones match the reference.
4. `SELECT … FOR UPDATE` the affected balances in ascending account ID order, so concurrent journals queue instead of deadlocking.
5. Reject any change that would make a player or session balance negative (`InsufficientFundsError`).
6. Insert the journal and its entries, then update the balances.

If a concurrent call with the same key commits first, the unique-index violation is answered as a replay.

`getBalances(pool, accounts)` reads current balances, with zero for accounts never posted to.

## Test

```sh
TEST_DATABASE_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
TEST_REDIS_URL=redis://127.0.0.1:6379/15 pnpm test:integration
```

`TEST_REDIS_URL` must point at a disposable Redis database: the end-to-end suite flushes it.

```

```

The integration tests cover success, failure, retry, and concurrency: the same key sent 10 times at once, 50 parallel transfers in both directions, and 20 racing debits against one balance. fast-check generates random journal sequences and checks the invariants against the real database: player balances are never negative, all balances sum to zero, each balance equals the sum of its entries, and replays are idempotent.
