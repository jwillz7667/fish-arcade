# Reef

Fish arcade gaming platform: multiplayer fish tables, slots, keno, a dual-currency wallet (Gold Coins and Sweeps Coins), Bitcoin purchases and payouts, and a back office.

- Spec: [`docs/spec.md`](docs/spec.md)
- Build order: [`docs/BUILD_PLAYBOOK.md`](docs/BUILD_PLAYBOOK.md)
- Rules for coding agents: [`CLAUDE.md`](CLAUDE.md)

## Requirements

- Node 22.23.5 (`nvm use` reads `.nvmrc`)
- pnpm 11.28.11 (pinned in `package.json` `packageManager`)
- Docker, for local services

## Run

```sh
pnpm i
cp .env.example .env   # then replace the placeholder passwords
pnpm services:up       # Postgres 16, Redis 7, Mailpit, MinIO on 127.0.0.1
pnpm keys:dev          # dev field-encryption keys into .keys/dev (gitignored)
pnpm db:roles          # reef_migrator, reef_app, reef_readonly (dev and CI only)
pnpm db:migrate        # prisma migrate deploy as reef_migrator
pnpm db:seed           # admin roles and fail-closed system flags; refuses production
```

## Test

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build

# Integration tests create and drop their own database on any Postgres 16 superuser connection
TEST_DATABASE_ADMIN_URL=postgresql://reef:change-me@127.0.0.1:5432/postgres \
  TEST_REDIS_URL=redis://:change-me@127.0.0.1:6379/15 pnpm test:integration
```

## Layout

Spec §19. `apps/` holds deployable services, `games/` holds the PixiJS game clients, `packages/` holds shared libraries, and `infra/` holds Terraform. Each workspace has a README naming its spec sections and the playbook step that builds it.
