# Reef Build Playbook

Step-by-step instructions for an AI coding agent (Claude Code or similar) to build Reef, with a human owner reviewing each step.

Pairs with `docs/spec.md` (v0.2) and `CLAUDE.md`.

---

## 0. How to use this

1. Create an empty git repo. Put `CLAUDE.md` at the root, the spec at `docs/spec.md`, and this file at `docs/BUILD_PLAYBOOK.md`. Commit.
2. Run the steps in order. One step per agent session, or clear context between steps.
3. Start each session with the standard prompt header below, then the step's prompt.
4. Don't move on until the step's "Done when" list passes and CI is green. Merge one pull request per step.
5. Steps marked **HUMAN GATE** are yours. The agent prepares, then stops and waits.
6. At the end of each phase, run the review prompt from section R in a fresh session, so the reviewer hasn't seen the code being written. Fix what it finds before the next phase.

### Standard prompt header

Paste this before every step:

```
Read CLAUDE.md, docs/spec.md, and docs/BUILD_PLAYBOOK.md.
Implement Step <N> only. Do not start later steps.
Follow every rule in CLAUDE.md. If a rule conflicts with this step, stop and ask me.
Before writing code, list the files you will create or change and the tests you will write.
When finished, run `pnpm lint && pnpm typecheck && pnpm test` and fix every failure.
Then summarize what you built, how you tested it, and anything left unfinished.
```

### Definition of done (applies to every step)

- Lint, typecheck, and tests pass with zero warnings.
- Every exported symbol has a TSDoc comment. Business rules cite the spec section.
- New env vars are in `.env.example` and in the zod env schema.
- New sensitive fields are in the logger redaction list.
- No secrets, keys, or `.env` files in the diff.
- PR description: what, why, tests, risks.

---

## 1. Decisions locked for this build

| Decision | Default used in this playbook |
|---|---|
| Money rail | Bitcoin on-chain only. No cards, no ACH, no Lightning in v1 |
| Deposit receiving | Self-hosted BTCPay Server, watch-only, pointed at the cold multisig. No deposit keys on any server |
| Cold treasury | 2-of-3 multisig, hardware wallets from 2 vendors, keys in 3 locations |
| Payout hot wallet | Single-sig P2WPKH, key generated inside AWS KMS (secp256k1), non-exportable, float capped |
| Signer | Separate service in an isolated subnet with its own hard limits |
| Pricing | USD. 1 SC = $1 prize value. BTC amount set at invoice creation (deposits) and at send time (payouts) |
| Confirmations | GC at 1 conf. SC bonus at 3 conf. Redemptions blocked until all deposits reach 6 conf |
| Network fees on payouts | Platform pays, batched every 30 min, capped per batch |
| Compliance | KYC, geofence, AMOE, responsible gaming unchanged from the spec. Adds sanctions and risk screening on every deposit and payout address |
| Stack | TypeScript, pnpm + Turborepo, NestJS, Colyseus, Postgres + Prisma, Redis + BullMQ, PixiJS, Next.js, AWS |

### Needs your call (or counsel's) before mainnet

1. Money transmission analysis for paying prizes in BTC.
2. Treasury policy: how often deposited BTC gets converted to USD.
3. Who holds each of the three cold keys, and where.
4. Signer limits: max per payout, per address per day, per day total, hot wallet cap.
5. Who pays payout network fees (default: platform).
6. Chain analytics vendor (Chainalysis, TRM Labs, or Elliptic).

The playbook ships placeholder values for all of these in config. Nothing touches mainnet until Step 33.

---

## 2. Phase overview

| Phase | Steps | Result |
|---|---|---|
| A. Foundation | 1 to 9 | Repo, money types, database, ledger, API, auth, geo, KYC, admin auth |
| B. Bitcoin rails | 10 to 16 | Regtest stack, price oracle, screening, deposits, redemptions, signer, treasury |
| C. Game core | 17 to 22 | Math, simulator, fish paths, game server, escrow, slots and keno |
| D. Clients | 23 to 26 | Player shell, fish client, slot and keno clients, back office |
| E. Product systems | 27 to 28 | Promotions, AMOE, responsible gaming, affiliates |
| F. Hardening and launch | 29 to 33 | Observability, infrastructure, security testing, load tests, launch |

---

## Phase A: Foundation

### Step 1. Repo scaffold

**Prompt**

```
Create the monorepo layout from spec §19, plus apps/signer.
- pnpm workspaces + Turborepo. Pin Node 22 LTS in .nvmrc and package.json engines.
- TypeScript strict with noUncheckedIndexedAccess, exactOptionalPropertyTypes, noImplicitOverride.
  Shared tsconfig bases in packages/config.
- ESLint flat config with typescript-eslint strict-type-checked and eslint-plugin-security.
  Ban Math.random (no-restricted-properties) everywhere except packages/simulator.
  Ban console outside scripts/.
- Prettier, Vitest workspace config, Husky + lint-staged, commitlint (conventional commits).
- docker-compose.services.yml: Postgres 16, Redis 7, Mailpit, MinIO. Script: pnpm services:up.
- .env.example only. .gitignore covers .env*, .keys/, data folders, build output.
- GitHub Actions CI: frozen-lockfile install, lint, typecheck, test, build,
  pnpm audit (fail on high), gitleaks secret scan, CodeQL.
- Renovate config: group minor updates weekly, never automerge.
- Each app and package gets a README stating its purpose and owner module in the spec.
```

**Done when**

- A clean clone runs `pnpm i && pnpm lint && pnpm typecheck && pnpm test && pnpm build` successfully.
- CI is green on the first PR.
- A throwaway file calling `Math.random()` in `apps/api` fails lint.

---

### Step 2. Shared packages: config, logger, errors, money

**Prompt**

```
Build four packages.

packages/config
- Per-app zod env schemas. Parse at startup; on failure print which variables are
  missing or invalid (never their values) and exit non-zero.
- NODE_ENV=production must reject any dev-only flag (stub providers, local keys).

packages/logger
- pino, JSON output, request ID from AsyncLocalStorage.
- Redact: password, token, authorization, cookie, otp, secret, apiKey, ssn, dob,
  address, email, phone, xpub, descriptor, and any key ending in Secret or Key.
- Test that every redacted path is actually redacted.

packages/errors
- DomainError base class: code, httpStatus, safeMessage, optional cause.
- Error code catalog as a const object. Subclasses for validation, auth,
  forbidden, not found, conflict, rate limited, compliance blocked, insufficient funds,
  dependency unavailable.

packages/money
- Branded bigint types: Units (1 coin = 1_000_000), Cents, Sats, CentsPerBtc.
- Constructors that reject negatives where the type requires it.
- unitsToCents (round down), centsToSatsForPayout (round down),
  centsToSatsOwed (round up), satsToCents (round down).
- Display formatters. No number type anywhere in this package's public API.
- 100% branch coverage plus fast-check property tests for every conversion.
```

**Done when**

- Coverage report shows 100% branches on `packages/money`.
- Property tests prove: payout conversions never exceed the exact value, owed conversions never fall below it.

---

### Step 3. Database schema and roles

**Prompt**

```
Create the Prisma schema for every table in spec §11 and §22.5. Then add raw SQL migrations for:
- A deferred constraint trigger that rejects any journal whose entries do not sum to zero at commit.
- Triggers that block UPDATE and DELETE on ledger_entries, journals, audit_logs.
- A check that player-owned balance rows can never go negative.
- Three database roles: reef_migrator (DDL), reef_app (DML, no UPDATE/DELETE on
  append-only tables), reef_readonly (SELECT only). Apps connect as reef_app.

Field encryption helper in packages/crypto-fields:
- Envelope encryption (AES-256-GCM). Data keys from KMS in prod, a local key file in dev.
- Encrypt dob, address fields, payout addresses at rest. Store ciphertext + key ID.
- Blind index (HMAC-SHA256 with a separate key) for lookups on email and phone.

Dev seed script that refuses to run when NODE_ENV=production.
```

**Done when**

- `pnpm db:migrate` works on an empty database.
- Tests prove: an unbalanced journal fails at commit, `UPDATE ledger_entries` fails as `reef_app`, a negative player balance is rejected, encrypted fields round-trip and are unreadable in raw SQL.

---

### Step 4. Ledger and wallet module

**Prompt**

```
Build packages/ledger and the wallet module in apps/api (spec §10).

postJournal({ type, idempotencyKey, entries, ref }):
- One database transaction.
- Lock affected balance rows with SELECT ... FOR UPDATE in ascending account ID order
  so concurrent journals can't deadlock.
- Check the zero sum in code as well as in the database.
- Idempotency: if the key exists and the payload hash matches, return the existing
  journal. If the payload differs, throw a conflict error.

Also:
- Account helpers: playerAccount(userId, kind), sessionAccount(sessionId, currency), houseAccount(kind).
- SC spend order as a pure function (spec §10.2): bets draw SC_bonus first, then SC_redeemable;
  winnings always go to SC_redeemable.
- Only this module may import the ledger tables. Add a lint rule (no-restricted-imports) to enforce it.

Tests:
- fast-check: random journal sequences never make a player balance negative,
  the sum of all balances is always zero, replays are idempotent.
- Concurrency: 50 parallel transfers across the same accounts finish with correct balances.
```

**Done when**

- Property and concurrency tests pass 20 runs in a row.
- 100% branch coverage on `packages/ledger`.

---

### Step 5. API skeleton

**Prompt**

```
Set up apps/api in NestJS with:
- /v1 prefix. Health (/health) and readiness (/ready checks Postgres and Redis).
- helmet with strict defaults. CORS allowlist from env, no wildcards.
- Redis-backed rate limiting: global per IP, plus per-route limits set by decorator.
- Request ID middleware feeding the logger.
- Global zod validation pipe. Exception filter that maps DomainError to
  { error: { code, message, requestId } } and maps anything else to a generic 500.
  Never send stack traces or internal messages to clients.
- Idempotency middleware for routes marked @MoneyRoute(): requires an Idempotency-Key header,
  stores the response per user + key for 24 hours, replays it on retry.
- OpenAPI generation, served only outside production.
- Graceful shutdown that drains requests.
```

**Done when**

- End-to-end tests cover: health, readiness failure when Redis is down, validation error shape, 429 on rate limit, idempotent replay, and that a thrown generic error returns no internal detail.

---

### Step 6. Player authentication

**Prompt**

```
Build player auth (spec §5.1).
- Signup with email or phone + 6-digit OTP: hashed at rest, 10-minute expiry,
  5 attempts, 60-second resend cooldown. Email/SMS providers behind an interface;
  dev uses Mailpit.
- Passwords: argon2id, minimum 12 characters, breached-password check through the
  HIBP k-anonymity range API (toggle in config).
- Passkeys with @simplewebauthn/server.
- TOTP 2FA with otplib, plus 10 single-use recovery codes stored hashed.
- Tokens: 10-minute access JWT signed with Ed25519; opaque 256-bit refresh token stored
  hashed, rotated on every use, with reuse detection that revokes the whole token family.
- Web cookies: httpOnly, Secure, SameSite=Lax. CSRF token header required on every
  state-changing request.
- Login throttling: exponential backoff per account and per IP. Identical responses for
  unknown accounts and wrong passwords (no account enumeration).
- Step-up auth: adding a payout address, redeeming, changing email or phone, and disabling
  2FA require a fresh login within 5 minutes plus a 2FA code.
- Signup bot check: Cloudflare Turnstile verified server-side.
- Audit event for every auth action.
```

**Done when**

- Tests cover OTP expiry and attempt limits, refresh rotation and reuse detection, enumeration-safe responses, CSRF rejection, and step-up enforcement.

---

### Step 7. Geolocation and jurisdictions

**Prompt**

```
Build geolocation and the jurisdiction gate (spec §4.1, §15).
- GeoProvider interface: check(context, devicePayload, ip) returns stateCode,
  confidence, vpnDetected, result. Implementations: a vendor adapter shell and a
  DevStubProvider that reads a test header. Config validation rejects the stub in production.
- JurisdictionService reads the jurisdictions table, caches in Redis for 60 seconds,
  and busts the cache when Compliance changes a row.
- Guard decorator: @RequireJurisdiction('signup' | 'purchase' | 'play_sc' | 'redeem').
- Record every check in geo_checks.
- Fail closed: provider error or timeout blocks purchase, SC play, and redemption.
```

**Done when**

- Tests: blocked state denied, Mode S state denies SC actions, VPN detected denies, provider outage denies, stub cannot load in production.

---

### Step 8. KYC

**Prompt**

```
Build KYC (spec §5.1, §15).
- KycProvider interface: createSession(user, level), getResult(ref), verifyWebhook(req).
  Dev stub with scripted outcomes (pass, fail, review, sanctions hit).
- Light KYC at signup, full KYC (document + liveness) before first redemption.
- Webhook endpoint: verify HMAC with timingSafeEqual, reject timestamps older than
  5 minutes, dedupe by event ID, then re-fetch the result from the provider before acting.
- Store vendor reference and outcome only. Never store document images.
- Sanctions or PEP hits create an aml_alerts row and suspend redemption.
```

**Done when**

- Tests cover bad signature, replayed event, stale timestamp, and every status transition.

---

### Step 9. Back office auth, RBAC, audit, approvals

**Prompt**

```
Build the admin foundation (spec §13).
- Admin auth separate from player auth: OIDC SSO plus mandatory WebAuthn or TOTP.
  Local seeded admin login in dev only.
- RBAC with the roles in spec §13.1. @Permission('players.read') style guards.
  Every admin route requires an explicit permission; no permission means 403.
- Audit interceptor: every admin write records actor, action, target, a before/after diff
  with PII masked, and IP.
- Approvals service (four-eyes): stores the requested action and payload, requires a second
  admin with the right role who is not the requester, executes atomically on approval,
  expires after 24 hours.
- Role-based PII masking in admin serializers.
```

**Done when**

- Tests: a requester cannot approve their own request, missing permission returns 403, every admin write produces an audit row, expired approvals cannot execute.

**End of Phase A:** run review prompt R1.

---

## Phase B: Bitcoin rails

### Step 10. Bitcoin dev stack and key ceremony runbook (HUMAN GATE for production keys)

**Prompt**

```
Set up Bitcoin for development and staging only.
- docker-compose.btc.yml with official images for bitcoind (regtest), NBXplorer, and BTCPay Server.
  Follow current BTCPay Server docs for image versions and settings.
- Scripts: pnpm btc:up, btc:down, btc:reset, btc:mine <n>, btc:fund <address> <btc>.
- Bootstrap script for regtest: generate a 2-of-3 multisig from three throwaway regtest keys
  written to .keys/regtest/ (gitignored), create a BTCPay store through the Greenfield API,
  attach the watch-only descriptor, set the confirmation policy, register a webhook to the API.
- BITCOIN_NETWORK env (regtest | signet | mainnet) validated at startup. Every address parser
  uses it. Staging runs on signet.
- Write docs/runbooks/key-ceremony.md describing the human procedure below.
  Do not generate, request, or handle any production key material.
```

**Human gate: you do this, never the agent**

1. Buy three hardware wallets from two different vendors, directly from the manufacturers.
2. Generate each seed on its device, offline. Back up each seed on metal. Store the three backups in three different places.
3. Build the 2-of-3 multisig in a desktop coordinator such as Sparrow. Export the watch-only descriptor. Check the first receive address on every device's screen.
4. Give BTCPay only the watch-only descriptor.
5. The hot wallet key gets created by Terraform in KMS in Step 30. No person ever sees it.
6. Never paste a seed, xprv, or private descriptor into any AI tool, chat, ticket, email, or repo.

**Done when**

- `pnpm btc:up` starts a working regtest BTCPay.
- An end-to-end test creates an invoice, pays it from the regtest node wallet, mines blocks, and receives a verified webhook.

---

### Step 11. Price oracle

**Prompt**

```
Build the BTC/USD price oracle in apps/workers (spec §22.1).
- Poll at least two public exchange APIs every 15 seconds. Store prices as integer CentsPerBtc.
- Use the median. Mark the price unusable when fewer than two sources are under 60 seconds
  old or sources disagree by more than 1%.
- Publish the current price with timestamp to Redis. Persist one snapshot per minute.
- getRate() throws a DependencyUnavailable error when the price is unusable. Purchases and
  payouts both depend on it, so both pause (fail closed).
- Configure the BTCPay store's rate source to match, and record the rate used on every invoice.
- Emit a metric and alert when the oracle pauses.
```

**Done when**

- Tests with mocked sources cover divergence, staleness, one source down, and all sources down.

---

### Step 12. Sanctions and chain risk screening

**Prompt**

```
Build chain screening (spec §15, §22).
- ChainRiskProvider interface: screenAddress(address), screenTransaction(txid), returning
  risk level (low | medium | high | severe), categories, and sanctioned flag.
  Vendor adapter shell for Chainalysis, TRM Labs, or Elliptic.
- Always-on local OFAC check: a daily job downloads the OFAC SDN list, extracts Bitcoin
  (XBT) digital currency addresses into ofac_addresses, and versions each import.
- Policy table:
  deposit from sanctioned or severe source: freeze account, credit nothing, compliance alert
  deposit from high risk: hold SC bonus, manual review
  payout address medium or above: manual review
  payout address sanctioned: reject, freeze, compliance alert
- Cache low-risk results for 24 hours. Never cache a sanctioned result as clean.
- Fail closed: if screening is down, payouts wait and deposit SC bonuses stay held.
```

**Done when**

- Tests cover every policy branch and the OFAC parser against a fixture file.

---

### Step 13. Deposits: buying Gold Coin packages with Bitcoin

**Prompt**

```
Build the purchase flow (spec §5.3, §22.2).

POST /v1/purchases { packageId }
- Requires login, @RequireJurisdiction('purchase'), passed light KYC, and responsible gaming limits.
- Creates a BTCPay invoice through the Greenfield API: USD amount, orderId = purchase ID,
  no PII in metadata, 15-minute expiry.
- Stores invoice ID, rate, BTC due in sats, and address. Returns address, BIP21 URI,
  BTC amount, and expiry.

GET /v1/purchases/:id/events
- Server-sent events with live status for the checkout screen.

POST /v1/webhooks/btcpay
- Read the raw body. Verify the BTCPay-Sig HMAC-SHA256 header with timingSafeEqual.
- Dedupe by delivery ID.
- Re-fetch the invoice from the Greenfield API and act only on that state.

State machine:
created -> paid_unconfirmed -> confirmed -> gc_credited -> sc_released
plus expired, partial, overpaid, paid_late, invalid, frozen.

Rules:
- At 1 confirmation: screen the payment (Step 12), then credit GC to the wallet and the
  SC bonus to a pending account.
- A confirmations watcher job releases the SC bonus at 3 confirmations.
- Partial payment: credit nothing. Overpayment: credit the package and record the overage.
  Paid late: manual review queue. Invalid or reorged after credit: reverse through the ledger,
  freeze the account, alert.
- Never credit at 0 confirmations. Never reuse an address.
```

**Done when**

- Regtest end-to-end tests pass for: exact payment credited, partial not credited, overpayment flagged, expiry, late payment to review, and a reorg (use `invalidateblock` on regtest) that reverses a credit.

---

### Step 14. Payout addresses and redemption requests

**Prompt**

```
Build the address book and redemption requests (spec §5.3, §10.2, §22.3).

Address book (max 3 per player):
- Validate with bitcoinjs-lib address.toOutputScript(address, network). Accept P2WPKH,
  P2WSH, P2TR, P2SH, P2PKH. Reject anything on the wrong network.
- Adding requires step-up auth, 2FA, and clicking a signed email link (30-minute expiry).
- New addresses are unusable for 48 hours. Email the player on every add and delete.
- Screen each address on add and again within 24 hours of any payout.

POST /v1/redemptions { scAmount, addressId }
- Requires step-up auth, @RequireJurisdiction('redeem'), full KYC, 2FA enabled,
  no open AML alerts, every deposit at 6+ confirmations, amount at or above the minimum,
  within daily and weekly caps, and a W-9 on file once annual totals cross the configured threshold.
- Ledger: move the amount from SC_redeemable to redemption:pending at request time.
- Return an estimated BTC amount labeled as an estimate.

Approval rules (config driven):
- Auto-approve when: full KYC passed, geo passed, address older than 48 hours and screened low,
  amount under the auto threshold, account older than the configured age, not the player's first redemption.
- Otherwise: manual queue (Finance). Above the high threshold: Finance plus Compliance approval.
- Cancel while pending, or rejection: reverse the ledger move, record the reason.
```

**Done when**

- Tests cover every gate, the ledger lock and reversal, the 48-hour cooldown, and both approval paths.

---

### Step 15. Signer service and payout execution

**Prompt**

```
Build apps/signer (spec §22.3, §22.4). This service holds the only signing ability in the system.

Isolation:
- No inbound network. Outbound only to AWS KMS, the platform's own bitcoind RPC, and a read
  model of approved payouts through a dedicated database role with the minimum grants.

Hard limits from signer config, enforced in code, not overridable from anywhere else:
- max sats per payout, max per address per day, max total per day, minimum hot wallet reserve.

Batch loop (every 30 minutes, and only if the payouts_paused flag is off):
1. Load approved payouts. For each, re-verify: a matching redemption:pending journal exists,
   amounts match, the address is unchanged since approval, the address was screened within
   24 hours, and limits allow it. Skip and alert on any mismatch.
2. Get the rate from the oracle. Abort the batch if unusable.
3. Convert with centsToSatsForPayout (round down).
4. Build the transaction with bitcoind walletcreatefundedpsbt against a watch-only descriptor
   of the hot key: one output per payout, change back to the hot wallet, RBF enabled,
   fee rate from estimatesmartfee capped by config.
5. Sign through a Signer interface. Production: KmsSigner (key spec ECC_SECG_P256K1,
   Sign with MessageType DIGEST over the BIP143 sighash, convert DER to r/s,
   normalize to low-S, compressed public key from GetPublicKey). Dev: LocalSigner
   with a regtest key from .keys/regtest/.
6. Verify every signature locally. Finalize. Run testmempoolaccept. Broadcast.
7. Record txid and output index per payout. Ledger: pending -> broadcast; at 1 confirmation
   -> paid. Email each player the txid.

Safety:
- A payout moves to "signing" under a row lock before any work. After a crash, check the
  mempool and chain for transactions spending the reserved inputs or paying the same outputs
  before rebuilding anything. A payout with a recorded txid is never rebuilt until that
  txid is confirmed dropped.
- Stuck batch: after 6 blocks unconfirmed, bump the fee with RBF within the cap.
  A second bump needs a human approval.
- Log batch IDs and txids only. Never log key material or raw signatures.
```

**Done when**

- Regtest end-to-end: approved payouts get batched, signed, broadcast, confirmed, and marked paid in the ledger.
- Tests prove: over-limit payouts refused, kill switch stops the next batch, a crash between broadcast and the database write causes no double payment, RBF bump works, wrong-network address rejected, low-S normalization correct against known vectors.
- KmsSigner tested against a staging KMS key on signet before Phase F.

---

### Step 16. Treasury monitoring and on-chain reconciliation

**Prompt**

```
Build treasury jobs in apps/workers.
- Hot wallet balance check every 5 minutes. Below one day of expected payouts: create a
  refill_request for humans (a PSBT from the cold multisig, signed on hardware wallets per
  the runbook). Above the cap: alert and create a sweep-to-cold request.
- Daily reconciliation:
  BTCPay settled invoices vs. purchase journals
  hot wallet transaction history vs. payout_batches and payouts
  any on-chain transaction touching platform wallets with no matching record: critical alert
- Endpoints for the admin treasury page: balances, pending payouts, refill requests, history.
- docs/runbooks/hot-wallet-refill.md for the human signing procedure.
```

**Done when**

- Tests with regtest fixtures detect a missing deposit record, a missing payout record, and an unknown transaction.

**End of Phase B:** run review prompts R1 and R2.

---

## Phase C: Game core

### Step 17. Math package

**Prompt**

```
Build packages/math (spec §7). Pure TypeScript, no I/O, RNG injected through an interface.
- rng.ts: CryptoRng wrapping crypto.randomInt. Integer-only probability rolls:
  rollRational(numerator, denominator). No floating point anywhere in outcome logic.
- fish.ts: standardShot, bossShot (weighted integer table), bombShot (sum of multipliers
  at resolution, capped), weaponShot (reject targets below the minimum multiplier),
  featureShot (payout drawn from a precomputed distribution). Represent R in basis points,
  so P(kill) = R_bp / (10_000 * m) becomes rollRational(R_bp, 10_000 * m).
- jackpot.ts: must-hit-by pools. Draw the hidden hit point on reset, store SHA-256 of
  (hitPoint + random salt) as the commitment.
- slots.ts: reel strips, 243-ways and line evaluation, free spins, hold-and-spin.
- keno.ts: draw 20 of 80 with a partial Fisher-Yates using randomInt; paytable lookup.
- zod schemas for every math config. Reject R >= 100%, multipliers below R, missing tables.
Tests use a seeded deterministic RNG. Small cases verified by exhaustive enumeration.
```

**Done when**

- 100% branch coverage. Exhaustive tests confirm exact probabilities for small configs.

---

### Step 18. Simulator

**Prompt**

```
Build packages/simulator, a CLI:
pnpm sim --config B --shots 1e9 --strategy all --threads 8
- Uses the exact production math modules. May use a fast seeded PRNG (xoshiro256**);
  this is the only package allowed to skip the crypto RNG.
- worker_threads for parallel runs.
- Strategies: random target, always highest multiplier, always lowest, boss only, torpedo only.
- Output a PAR report (markdown + JSON): RTP per strategy with 99.9% confidence interval,
  per-shot standard deviation, hit frequency, largest win, jackpot frequency per tier.
- CI job: 1e7 shots per config, fail if any strategy's RTP falls outside tolerance.
```

**Done when**

- All strategies land on the configured RTP within the confidence interval.
- CI regression job runs in under 5 minutes.

---

### Step 19. Fish paths and wave scripts

**Prompt**

```
Build packages/fish-paths, shared by server and client.
- Path library as JSON control points (cubic Bezier and Catmull-Rom).
- position(pathId, t) and heading(pathId, t) with arc-length parameterization through a
  precomputed lookup table, so fish move at constant speed.
- Wave scripts as JSON validated by zod: normal flow, fish tide formations, boss entries.
  Server seeds each room's wave schedule from the crypto RNG.
- Starter content: 200 paths and 3 tide formations, generated by a script, not hand-typed.
```

**Done when**

- Snapshot tests lock positions for fixture paths. Property test: every position stays inside the field plus margin.

---

### Step 20. Fish game server

**Prompt**

```
Build apps/game-server with Colyseus (spec §9).
- One room per table. Players join with a single-use game token sent in join options
  (never in the URL), validated against the API.
- Every inbound message validated with zod schemas from packages/protocol.
  Drop malformed messages, count them, disconnect after a threshold.
- Spawn scheduler driven by wave scripts. Broadcast spawn events, not positions.
- fire and hit handling exactly per spec §9.4, including the geometry check and the
  10-second fallback resolver.
- Shot rate limit: 6/sec sustained, burst 10.
- Jackpot contributions through an atomic Redis Lua script so pools stay correct across processes.
- Clock sync ping/pong per spec §9.3.
- Prometheus metrics: shots per second, result latency, rejected hits, realized RTP per room.
- Max message size enforced at the socket.
```

**Done when**

- Integration tests with headless clients cover: fire to result, rejected false hit, rate limit, reconnect within 60 seconds keeping the seat, and jackpot hit across two rooms.

---

### Step 21. Table session escrow, checkpoints, recovery

**Prompt**

```
Wire table sessions to the ledger (spec §10.3).
- The game server never touches ledger tables. It calls internal wallet endpoints in apps/api
  over a private network with signed short-lived service tokens.
- Join: escrow journal. Leave, idle timeout, or disconnect timeout: final checkpoint and release.
- Events appended to Redis Streams with monotonic sequence numbers.
- Checkpoint worker: every 5 seconds or 500 events, one journal per range, idempotency key
  sessionId:seqEnd.
- Recovery: a new room owner loads the last checkpoint and replays the stream.
- Archive streams to object storage (MinIO in dev, S3 with Object Lock in prod) and fill
  round_archive_index.
```

**Done when**

- Chaos test: kill the game-server process mid-session with 3 players, restart, and confirm balances match the event log exactly, with no double credit from checkpoint replays.

---

### Step 22. Slots and keno endpoints

**Prompt**

```
Add stateless spin endpoints (spec §6.6, §6.7).
POST /v1/games/:slug/spin { roundId, bet, currency }
- roundId is a client-generated UUID used as the idempotency key.
- Debit and credit in a single journal. Return stop positions or drawn numbers, the win,
  and the new balance.
- Write a round log entry per spin.
Same gates as fish: jurisdiction, responsible gaming limits, currency mode.
```

**Done when**

- Tests cover replayed roundId, insufficient balance, and blocked jurisdiction.

**End of Phase C:** run review prompts R1 and R3.

---

## Phase D: Clients

### Step 23. Player web shell

**Prompt**

```
Build apps/web with Next.js App Router and Tailwind (spec §5).
Pages: signup, login, OTP, passkey, 2FA setup, lobby, game launcher, cashier
(packages, BTC invoice screen with QR code, BIP21 link, copy button, BTC amount, countdown,
live status over SSE), payout address book, redemption flow with a confirmation screen
showing USD value, estimated BTC, and a note that the final amount is set at send time,
history, responsible gaming settings, AMOE page, official rules, support.

Security:
- Nonce-based Content Security Policy, no inline scripts, SRI on any external script.
- Games load from a separate origin in an iframe with a sandbox attribute.
  postMessage bridge checks event.origin and validates every message with zod.
- frame-ancestors 'none' on shell pages. Strict referrer policy.
- CSRF header on every mutation.
Accessibility: WCAG AA. Languages: English and Spanish.
```

**Done when**

- Playwright end-to-end on regtest: sign up, buy a package, see GC credited, launch a game, request a redemption, see it appear in the admin queue.

---

### Step 24. Fish table client

**Prompt**

```
Build games/fish-table-1 with PixiJS v8 and Vite (spec §6.1 to §6.5, §18).
Modules: net (Colyseus client and clock sync), world (fish from shared paths), cannon and
input (touch, mouse, auto-fire, lock-on), bullets (local prediction with wall bounces),
effects (particles, win tiers), audio (Howler), HUD (bet controls, balance), bridge (postMessage).
- Render server results only. The client never decides an outcome or a balance.
- Placeholder art: original vector shapes drawn in code until real art arrives.
  Asset loader driven by a content-hashed manifest.
- Low-graphics mode. Budget: 60 fps on mid-range Android, under 50 draw calls, bundle under 15 MB.
```

**Done when**

- Plays a full session against the local game server. Frame-time test and bundle-size check pass in CI.

---

### Step 25. Slot and keno clients

**Prompt**

```
Build games/slot-template-a, games/slot-template-b, and games/keno in PixiJS.
Each skin is a config + asset swap on a template. Same bridge, same rules as Step 24.
Spins call the Step 22 endpoint with a fresh roundId and animate to the server's result.
```

**Done when**

- Each title plays end to end. Network failure mid-spin retries with the same roundId and shows the correct result.

---

### Step 26. Back office app

**Prompt**

```
Build apps/admin with Next.js on its own origin (spec §13, §22).
Modules from spec §13.2, plus:
- Payout queue: address, screening result, address age, player history, approve or reject with a reason.
- Deposit exceptions queue: partial, overpaid, late, flagged.
- Treasury page: hot wallet balance, pending payouts, refill requests, batch history,
  kill switch (pausing takes one admin plus a reason; resuming takes two approvers).
Same CSP and cookie rules as the player shell. SSO plus MFA required. PII masked by role.
```

**Done when**

- Playwright tests: approve a payout end to end, pause and resume payouts with two approvers, a Support role cannot see unmasked PII.

**End of Phase D:** run review prompt R1.

---

## Phase E: Product systems

### Step 27. Promotions, AMOE, responsible gaming

**Prompt**

```
Build (spec §5.4, §5.7, §15):
- Bonus engine: grants with currency, amount, playthrough multiple, expiry, eligibility, budget cap.
  Missions, daily login rewards, weekly leaderboards.
- AMOE: daily online free entry (Turnstile, per-account, per-device, per-IP limits) and the
  mail-in queue for back office data entry with dedupe. Amounts from official rules config.
- Responsible gaming: purchase limits (decreases now, increases after 24 hours), session
  reminders, time-outs, self-exclusion, enforced on purchase, play, and promotions.
  Behavior alerts to the RG queue.
```

**Done when**

- Tests prove a self-excluded player cannot purchase, play, or claim promotions, but can still redeem.

---

### Step 28. Affiliates (can defer)

**Prompt**

```
Build apps/affiliate and the affiliate API (spec §14).
Tracking links and codes, attribution, CPA and revenue-share deals, max 2 tiers,
monthly commission statements. Affiliates see aggregates only: no player PII,
no ability to create accounts, load coins, or pay anyone.
```

**Done when**

- Tests cover attribution windows, the 2-tier cap, and that affiliate endpoints never return player PII.

---

## Phase F: Hardening and launch

### Step 29. Observability and alerting

**Prompt**

```
Add OpenTelemetry tracing across api, game-server, workers, and signer. Prometheus metrics,
Grafana dashboards as code. Alerts:
price oracle paused, hot wallet low or over cap, signer refusal, payout stuck,
reconciliation mismatch, realized RTP outside band, webhook signature failure spike,
login failure spike, 5xx rate, queue backlog.
Runbook link on every alert.
```

**Done when**

- Each alert fires in a staging test.

---

### Step 30. Infrastructure

**Prompt**

```
Write Terraform for staging and production in separate AWS accounts.
- VPC: public subnets (load balancer only), private subnets (api, game-server, workers,
  admin), isolated subnet (signer, bitcoind, NBXplorer, BTCPay). BTCPay is never public;
  the player shell renders its own checkout screen.
- RDS Postgres Multi-AZ, encrypted, point-in-time recovery. ElastiCache with TLS and auth.
- ECS Fargate services. bitcoind full node on EC2 with encrypted EBS.
- KMS: one key for PII envelope encryption; one ECC_SECG_P256K1 key for the hot wallet whose
  key policy allows kms:Sign and kms:GetPublicKey to the signer task role only.
  Key administrators can manage but cannot sign.
- Secrets Manager, WAF with managed rule sets and rate rules, Shield, CloudTrail with log
  validation, GuardDuty, AWS Config, S3 Object Lock for round archives.
Scan with checkov and tfsec in CI.
```

**Done when**

- `terraform plan` is clean in staging. Scanners pass with no high findings.

---

### Step 31. Security testing

**Prompt**

```
Write docs/security/threat-model.md using STRIDE per service. Cover payout theft, ledger
manipulation, account takeover, game cheating, admin abuse, and supply chain attacks,
with the control that addresses each threat and its test.
Add to CI: semgrep, Trivy container scans, an OWASP ZAP baseline scan against staging.
List any finding you can't fix in docs/security/open-findings.md with severity.
```

**Human gate:** hire an external penetration tester for the signer, wallet, and auth paths before mainnet.

**Done when**

- Threat model reviewed by you. No open critical or high findings.

---

### Step 32. Load and chaos testing

**Prompt**

```
Add k6 scripts for the API and a headless WebSocket bot fleet for fish rooms.
Targets from spec §17: 5,000 concurrent players, 1,500 rooms, latency budgets.
Chaos scenarios in staging: kill pods, Redis failover, database failover, BTCPay down
(purchases pause cleanly), oracle down (purchases and payouts pause), signer down
(payouts queue, nothing lost).
Write results to docs/perf/.
```

**Done when**

- Latency targets met at target load. Every chaos scenario recovers with balances reconciled.

---

### Step 33. Launch checklist (HUMAN GATE)

- [ ] Counsel sign-off per state, including the BTC payout question
- [ ] Test lab certification of the math and RNG
- [ ] Key ceremony done. Small mainnet test: $10 deposit, $50 hot wallet refill, $10 payout
- [ ] Signer limits and hot wallet cap set to your numbers
- [ ] Kill switch tested on mainnet with a real queued payout
- [ ] Backup restore drill completed
- [ ] Incident response and on-call runbooks written
- [ ] Terms, privacy policy, official rules, and responsible gaming pages published
- [ ] Support staffed and trained on the admin tools
- [ ] Pen test findings closed

---

## R. Review prompts

Run these in a fresh session with no history of writing the code.

### R1. General review

```
You are reviewing code you did not write. Read CLAUDE.md and docs/spec.md first.
Review the work from Phase <X> for:
- ledger and money correctness (bigint only, idempotency, rounding direction)
- authorization on every route and socket message
- input validation at every boundary
- secrets or PII in code, logs, or errors
- swallowed errors and unsafe fallbacks
- missing tests for failure, retry, and concurrency
- comment quality and TSDoc coverage
Report findings ranked by severity with file, line, the problem, and a concrete fix.
Do not change any code.
```

### R2. Bitcoin review

```
You are reviewing Bitcoin code you did not write. Read CLAUDE.md and spec §22 first.
Check specifically:
- no private key material anywhere in the repo, logs, env files, or test fixtures beyond regtest
- every address parsed with the configured network
- webhooks verified with a timing-safe compare and re-fetched before acting
- no credit at 0 confirmations; reorg handling reverses credits
- double-payment impossible across crashes and retries
- signer limits enforced inside the signer and impossible to raise from outside
- low-S normalization and local signature verification before finalize
- fee caps and RBF behavior
- fail-closed behavior when the oracle or screening is down
Report findings ranked by severity with file, line, and a fix. Do not change any code.
```

### R3. Game integrity review

```
You are reviewing game code you did not write. Read CLAUDE.md and spec §7 and §9 first.
Check that outcomes use the crypto RNG, use integer-only probability math, return the same
RTP for every target and weapon, never trust the client for outcomes or balances, and that
the simulator imports the production math with no forked logic.
Report findings ranked by severity with file, line, and a fix. Do not change any code.
```
