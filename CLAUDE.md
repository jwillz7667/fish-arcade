# CLAUDE.md

Rules for any AI coding agent working in this repo. Read this file, `docs/spec.md`, and `docs/BUILD_PLAYBOOK.md` before every task.

## Project

Reef is a fish arcade gaming platform: multiplayer fish shooting tables, slots, keno, a lobby, a dual-currency wallet (Gold Coins and Sweeps Coins), Bitcoin purchases and payouts, and a back office.

- Spec: `docs/spec.md` (v0.2). Section numbers in code comments refer to this file.
- Build order: `docs/BUILD_PLAYBOOK.md`. Work on one step at a time. Do not start the next step unless told to.

## Commands

| Command | What it does |
|---|---|
| `pnpm i` | Install (always with the committed lockfile) |
| `pnpm dev` | Start all apps against local Docker services |
| `pnpm lint` | ESLint, zero warnings allowed |
| `pnpm typecheck` | `tsc --noEmit` across the workspace |
| `pnpm test` | Vitest, all packages |
| `pnpm build` | Production build of every app |
| `pnpm db:migrate` | Apply Prisma and raw SQL migrations |
| `pnpm services:up` | Postgres, Redis, Mailpit, MinIO via Docker |
| `pnpm btc:up` | Regtest bitcoind, NBXplorer, BTCPay Server |
| `pnpm btc:mine <n>` | Mine n regtest blocks |
| `pnpm sim` | Run the math simulator |

Every task ends with `pnpm lint && pnpm typecheck && pnpm test` passing.

## Code standards

- TypeScript strict mode everywhere. No `any`; use `unknown` and narrow it. No non-null assertions (`!`) outside tests.
- Every exported function, class, and type gets a TSDoc block: what it does, parameters, return value, and what it throws.
- Comments explain why, not what. Business rules cite the spec, for example `// Spec §7.2: P(kill) = R / m`.
- Keep files under roughly 300 lines and functions focused on one job. Split when they grow.
- Naming: `camelCase` for variables and functions, `PascalCase` for types and classes, `SCREAMING_SNAKE_CASE` for constants, `kebab-case` for file names.
- Errors: throw `DomainError` subclasses from `packages/errors` with a stable error code. Never swallow an error. Never return `null` to signal failure in a money path.
- No dead code, no commented-out code, no `TODO` without an issue reference.
- Prettier formats everything. Do not hand-format against it.
- Ask before adding any dependency. Prefer widely used, actively maintained packages. Pin exact versions.

## Money rules (non-negotiable)

- All amounts use the branded `bigint` types from `packages/money`: `Units` (1 coin = 1,000,000 units), `Cents`, `Sats`. Never `number`, never floats, never `parseFloat`, never `Number()` on an amount.
- Exchange rates are integer cents per BTC.
- Rounding: BTC owed by a player rounds up to the satoshi. BTC paid to a player rounds down to the satoshi. Coin display rounds down.
- Only the wallet module writes ledger tables. Every balance change goes through `postJournal`.
- Every money-moving operation carries an idempotency key. Retrying it must never move money twice.
- Every money path has tests for success, failure, retry, and concurrent calls.

## Security rules

- Validate every external input with zod at the boundary: HTTP bodies, query strings, headers, WebSocket messages, webhooks, queue jobs, environment variables.
- Parameterized queries only (Prisma or tagged `sql`). Never build SQL from strings.
- Authorization is checked server-side on every route and every WebSocket message. Deny by default.
- Never log secrets, tokens, passwords, OTPs, session cookies, or PII. Log record IDs, not emails, names, or payout addresses. The logger's redaction list must cover new sensitive fields when you add them.
- Never commit secrets. Only `.env.example` with placeholder values goes in git.
- Never disable TLS verification, in any environment.
- Randomness comes from `node:crypto` (`randomInt`, `randomBytes`). `Math.random` is banned by lint everywhere except `packages/simulator`.
- Compare signatures, tokens, and hashes with `crypto.timingSafeEqual`.
- Fail closed. If geolocation, KYC, the price oracle, chain screening, or the jurisdiction table is unavailable, block the action that depends on it.
- Client code is a renderer. Balances, outcomes, and payouts are decided on the server only.

## Bitcoin rules

- Never generate, request, store, print, or log production private keys, seed phrases, or xprvs. If a task seems to need one, stop and ask.
- Dev and regtest keys are generated at runtime by scripts into gitignored folders. Nothing in the repo holds key material.
- Parse every address with the configured network (`regtest`, `signet`, `mainnet`) and reject mismatches.
- Never trust a webhook body. Verify the signature, then re-fetch the invoice from BTCPay before acting.
- Never credit a payment with zero confirmations.
- Signer limits live in signer config and are enforced inside `apps/signer`. No API call, admin action, or database value can raise them.
- Every signature produced by the signer is verified locally before a transaction is finalized.

## Stop and ask the human before

- Changing the ledger schema, `postJournal`, or the SC spend-order logic
- Any change inside `apps/signer`, KMS key policies, or payout limits
- Jurisdiction logic, KYC thresholds, AML rules, or responsible gaming rules
- Adding or upgrading a dependency
- Editing or deleting a migration that has been merged
- Any playbook step marked HUMAN GATE

## Testing

- Vitest. Unit tests sit next to the code as `*.test.ts`. Integration and end-to-end tests live in each app's `test/` folder.
- Branch coverage: 100% for `packages/money`, `packages/ledger`, `packages/math`. At least 80% elsewhere.
- Unit tests make no network calls. External services sit behind interfaces with test doubles.
- Bitcoin integration tests run against regtest only.
- Property-based tests (fast-check) for money conversions, ledger invariants, and math.

## Git

- Conventional commits (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`).
- One pull request per playbook step. The PR description covers what changed, why, how it was tested, and known risks.
- Never commit generated keys, `.env` files, or local data folders.
