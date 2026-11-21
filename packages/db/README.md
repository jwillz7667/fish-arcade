# @reef/db

Prisma schema, migrations, and database roles for every table in spec §11 and §22.5.

|          |                                    |
| -------- | ---------------------------------- |
| Spec     | §10.2, §11, §22.5                  |
| Built in | Step 3 of `docs/BUILD_PLAYBOOK.md` |

## Roles

| Role            | Can                                                                                                                 | Used by                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `reef_migrator` | DDL; owns every object                                                                                              | `pnpm db:migrate`          |
| `reef_app`      | DML, except UPDATE/DELETE/TRUNCATE on `journals`, `ledger_entries`, `audit_logs`; no access to `_prisma_migrations` | every app (`DATABASE_URL`) |
| `reef_readonly` | SELECT                                                                                                              | analysts, reporting        |

`pnpm db:roles` creates them (superuser `DATABASE_ADMIN_URL`, dev and CI only). In staging and production, Terraform creates them (Step 30).

## Invariants enforced in SQL

Prisma cannot express these, so `prisma/migrations/*_ledger_invariants` adds them:

- **Zero-sum journals:** deferred constraint triggers on `journals` and `ledger_entries` reject, at COMMIT, any journal with fewer than two entries or a non-zero sum (constraint `journal_balanced`, SQLSTATE 23514).
- **Append-only:** `journals`, `ledger_entries`, and `audit_logs` reject UPDATE, DELETE, and TRUNCATE for every role, owner included.
- **Non-negative player money:** `balances` rows for `player` and `session` (escrow) accounts cannot go below zero. `balances.owner_type` is pinned to the account by a composite foreign key, so it cannot be relabelled to dodge the check.
- **Owners:** house and redemption accounts have no `owner_id`; all others must have one.
- Ledger entries cannot be zero.

## Encrypted columns

`*_enc` columns hold `@reef/crypto-fields` envelopes. `*_bidx` columns hold HMAC blind indexes for equality lookups (`users.email_bidx`, `users.phone_bidx`, `payout_addresses.address_bidx`). `chain_screenings.subject` stores the address blind index, never the address.

## Commands

```sh
pnpm db:roles      # create or update roles (refuses NODE_ENV=production)
pnpm db:migrate    # prisma migrate deploy as reef_migrator (MIGRATION_DATABASE_URL)
pnpm db:seed       # admin roles + fail-closed system flags (refuses NODE_ENV=production)
pnpm --filter @reef/db generate   # regenerate the client (also runs on install)
```

New migrations: edit `prisma/schema.prisma`, then create the migration against a disposable database with `prisma migrate dev --create-only`. Never edit a merged migration (CLAUDE.md). A new append-only table must also add its trigger and REVOKE in SQL.

## Env

`DATABASE_ADMIN_URL`, `REEF_MIGRATOR_PASSWORD`, `REEF_APP_PASSWORD`, `REEF_READONLY_PASSWORD`, `MIGRATION_DATABASE_URL`, `DATABASE_URL`. See `/.env.example`.

## Test

```sh
TEST_DATABASE_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/postgres pnpm test:integration
```

Each run creates `reef_it_<random>`, bootstraps roles, applies migrations with `prisma migrate deploy`, and drops the database afterwards. Roles are cluster-wide, so do not run two integration runs against the same cluster at once.
