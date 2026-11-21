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

## Player auth (`src/auth`, Step 6, spec §5.1)

Every route needs a valid access token unless it is marked `@Public()`: the global `AuthGuard` denies by default.

| Endpoint (`/v1/auth/…`)                            | Auth                                  | What it does                                                                                    |
| -------------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `POST signup`                                      | public, Turnstile                     | Sends a 6-digit code to an email or E.164 phone. Same response whether or not an account exists |
| `POST otp/verify`, `POST otp/resend`               | public                                | Checks the code and returns a 15-minute signup ticket; resends after 60 s                       |
| `POST signup/passkey-options`                      | public, ticket                        | WebAuthn registration options bound to the ticket                                               |
| `POST signup/complete`                             | public, ticket                        | Profile (18+) plus password or passkey; creates the account and signs it in                     |
| `POST login`, `POST login/mfa`                     | public                                | Password, then a TOTP or recovery code when 2FA is on                                           |
| `POST passkey/options`, `passkey/login`            | public                                | Discoverable-credential passkey login (no account named, so nothing to enumerate)               |
| `POST refresh`, `POST logout`                      | public, refresh token                 | Rotate the refresh token; end the session                                                       |
| `GET session`                                      | token                                 | The current session: user, login time, methods, whether 2FA is on                               |
| `POST 2fa/totp/setup`, `…/confirm`                 | token, recent login                   | Enrol TOTP; confirm returns 10 recovery codes once                                              |
| `POST 2fa/totp/disable`                            | token, step-up                        | Turn 2FA off and sign out other sessions                                                        |
| `POST passkeys/options`, `POST passkeys`           | token, recent login (+2FA code if on) | Add a passkey                                                                                   |
| `POST contact`, `contact/verify`, `contact/resend` | token, step-up (start only)           | Change email or phone, proven by a code to the new address; signs out other sessions            |

**Tokens.** Access tokens are 10-minute Ed25519 JWTs (`typ: at+jwt`, `kid` for rotation) carrying `sub`, `sid`, `auth_time`, and `amr`. Refresh tokens are opaque 256-bit values stored as SHA-256 hashes, single-use, and rotated on every refresh. Presenting a spent refresh token revokes its whole session (token family), and revoked sessions are cached in Redis so their access tokens stop working at once. Sessions end 30 days after login (`AUTH_REFRESH_TTL_DAYS`); refresh never moves `auth_time`.

**Browsers and native apps.** Browsers get `__Host-reef_at` (access), `__Secure-reef_rt` (refresh, path `/v1/auth`), and a readable `__Host-reef_csrf`, all `Secure; SameSite=Lax`, the first two `HttpOnly`; tokens never appear in the body. Cookie-authenticated writes, refresh, and logout must send the CSRF token in `X-CSRF-Token`: an HMAC of the session ID, so it cannot be forged or planted from a sibling subdomain. Native apps send `X-Reef-Client: mobile`, get tokens in the body, and use `Authorization: Bearer`, which needs no CSRF token.

**Codes and passwords.** OTPs are HMAC-hashed with a per-challenge binding, valid 10 minutes, 5 attempts (spent atomically before comparing), 60 s resend cooldown, 5 sends per challenge. Passwords are 12–128 characters, argon2id (OWASP baseline, upgraded on login when parameters change), and checked against HIBP's k-anonymity range API (`HIBP_ENABLED`; fails closed when HIBP is down). TOTP secrets are field-encrypted; accepted time steps are recorded so a code works once. Recovery codes are HMACs and single-use.

**Enumeration and throttling.** Unknown accounts and wrong passwords return the same status, body, and timing (a dummy argon2 verification runs). Failures back off exponentially per identifier (5 free, then 1 s doubling to 15 min) and per IP (20 free), whether or not the account exists. Second-factor failures share a per-user backoff.

**Step-up.** `@RequireStepUp()` needs a login under 5 minutes old plus a 2FA code in `X-Step-Up-Code`; players without 2FA get `MFA_NOT_ENROLLED`. Use it on adding a payout address and redeeming (Steps 14 and 15), changing contact details, and disabling 2FA. `@RequireRecentAuth()` guards adding a factor: a recent login, plus a code if 2FA is already on.

**Providers.** Email and SMS go through `MessageSender`; Mailpit is the only implementation and is dev-only, so the API refuses to start with `NODE_ENV=production` until a vendor adapter exists. Turnstile is verified server-side with Cloudflare's siteverify; its test secrets are rejected in production. Every auth action writes an `audit_logs` row with IDs only.

**Keys.** `pnpm keys:dev` writes `.keys/dev/auth-jwt.pem` and `.keys/dev/auth-hmac.key` (gitignored, never overwritten). Production sets `AUTH_JWT_PRIVATE_KEY` and `AUTH_HMAC_KEY` inline from Secrets Manager.

## Geolocation and jurisdictions (`src/compliance`, Step 7, spec §4.1, §15)

The client checks location for an action, then sends the result with the gated request:

1. `POST /v1/geo/check` with `{ context, devicePayload }`, where `context` is `signup`, `purchase`, `play_sc`, or `redeem`. Signup checks are anonymous; the others need a signed-in player.
2. The provider places the device. VPN or proxy, confidence below `GEO_MIN_CONFIDENCE`, or no US state blocks. A provider error or a timeout (`GEO_PROVIDER_TIMEOUT_MS`) is answered with 503. Every check, including failures, is a `geo_checks` row.
3. The state's jurisdiction rule decides: X blocks everything; S allows signup and Gold Coin purchases; P allows everything, with redemption only when `sc_redemption_enabled`. A state with no row is blocked.
4. An allowed check returns a `geoToken`: an HMAC-signed claim bound to the action, the player (or none, for signup), the client IP, and a 10-minute expiry (spec §15 rechecks SC play every 10 minutes).

`@RequireJurisdiction('purchase')` on a route verifies `X-Geo-Token` and re-reads the state's rule, so a scheduled change applies even to tokens issued before it. Signup start and completion are gated. At completion, the declared home state must also allow signup, and the higher of the two states' `min_age` applies (never below 18).

`JurisdictionService` reads the table through Redis: entries live 60 seconds, or until the next scheduled row takes effect if that is sooner. `schedule()` adds a future-dated row, audits it, and busts the cache; the Compliance-only admin route for it arrives in Step 9.

**Providers.** `GEO_PROVIDER=dev_stub` is the only option, and config rejects it in production. The stub reads `X-Reef-Dev-Geo`: `NV`, `NV;vpn`, `NV;confidence=0.5`, `abroad`, `error`, or `timeout`. A missing header is an error, so it fails closed.

**Dev data.** `pnpm db:seed` (refused in production) adds one row per state: spec §4.3's likely-blocked states as X and the rest as S. No state is P until counsel and Compliance set production rows.

## KYC (`src/compliance/kyc`, Step 8, spec §5.1, §15)

- **Sessions.** `POST /v1/kyc/session` with `{ level: 'light' | 'full' }` starts a vendor check and returns the token for the vendor's SDK. Documents and selfies go straight to the vendor; Reef stores only the vendor reference and the outcome (`kyc_checks`).
- **Webhooks.** `POST /v1/webhooks/kyc` is public and authenticated by signature:
  1. Verify the HMAC over the exact raw body with `timingSafeEqual`, and reject timestamps more than 5 minutes off (401).
  2. Re-fetch the verdict from the vendor; the body only names which check changed. If the vendor can't confirm, answer 503 so it retries.
  3. In one transaction, record the event ID in `processed_webhooks` (replays and retries answer `duplicate`), then lock the check and apply the change.
- **Transitions.** `pending` → `passed`, `failed`, `review`, or `sanctions_hit`; `review` → `passed`, `failed`, or `sanctions_hit`; `passed` → `sanctions_hit` (list updates). `failed` and `sanctions_hit` are final until an admin acts (Step 9). Anything else is rejected and audited.
- **Sanctions or PEP hit.** Opens a critical `aml_alerts` row (`kyc_sanctions_pep`) and places a redemption hold (`account_holds`), in the same transaction.
- **Guards.** `@RequireKyc('light' | 'full')` needs a passed check at that level (full satisfies light) and no sanctions hit. `@RequireRedemptionEligibility()`, for the redemption and payout routes of Steps 14 and 15, needs full KYC and no redemption hold (`REDEMPTION_SUSPENDED`).
- **Provider.** `KYC_PROVIDER=dev_stub` is the only option, and config rejects it in production. The stub keeps scripted outcomes (`passed`, `failed`, `review`, `sanctions_hit`) in Redis and signs webhooks with `KYC_WEBHOOK_SECRET` (`X-Reef-Kyc-Signature: t=…,v1=…`).

## Test

```sh
TEST_DATABASE_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres \
TEST_REDIS_URL=redis://127.0.0.1:6379/15 pnpm test:integration
```

`TEST_REDIS_URL` must point at a disposable Redis database: the end-to-end suite flushes it.

The integration tests cover success, failure, retry, and concurrency: the same key sent 10 times at once, 50 parallel transfers in both directions, and 20 racing debits against one balance. fast-check generates random journal sequences and checks the invariants against the real database: player balances are never negative, all balances sum to zero, each balance equals the sum of its entries, and replays are idempotent.
