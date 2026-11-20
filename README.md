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
```

## Test

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

## Layout

Spec §19. `apps/` holds deployable services, `games/` holds the PixiJS game clients, `packages/` holds shared libraries, and `infra/` holds Terraform. Each workspace has a README naming its spec sections and the playbook step that builds it.
