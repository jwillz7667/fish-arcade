# @reef/config

Shared tooling configuration and the runtime env schemas for every app (spec §19).

|          |                                           |
| -------- | ----------------------------------------- |
| Spec     | §19                                       |
| Built in | Steps 1 and 2 of `docs/BUILD_PLAYBOOK.md` |

## Env schemas

```ts
import { apiEnvSchema, loadEnv } from '@reef/config';

const env = loadEnv(apiEnvSchema); // typed; exits 1 with a list of bad variable names on failure
```

- `defineEnvSchema(shape, devOnly)` adds `NODE_ENV` and `LOG_LEVEL` to an app's variables. When `NODE_ENV=production`, any value a `devOnly` predicate matches is rejected. Use this for stub providers and local keys.
- Built in: `DATABASE_URL` must use `sslmode=require|verify-ca|verify-full`, and `REDIS_URL` must use `rediss://`, in production.
- Errors name the variable and the problem, never the value.
- Schemas so far: `apiEnvSchema`, `workersEnvSchema`, `gameServerEnvSchema`. The signer's schema lives with `apps/signer`, which needs human sign-off (CLAUDE.md).

Every variable is listed in `/.env.example`.

## Tooling exports

| Export                               | Use                                                                                                                                                                                            |
| ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@reef/config/eslint`                | `createReefConfig({ rootDir })`: typescript-eslint strict-type-checked, eslint-plugin-security, the `Math.random` ban (except `packages/simulator`), and the `console` ban (except `scripts/`) |
| `@reef/config/vitest`                | `createVitestProject(name)`: per-workspace Vitest project that resolves workspace packages to source                                                                                           |
| `@reef/config/tsconfig/base.json`    | Strict compiler options                                                                                                                                                                        |
| `@reef/config/tsconfig/node.json`    | Node services and packages                                                                                                                                                                     |
| `@reef/config/tsconfig/browser.json` | Vite browser bundles                                                                                                                                                                           |
| `@reef/config/tsconfig/react.json`   | React workspaces                                                                                                                                                                               |

Workspace packages export `"@reef/source": "./src/index.ts"` ahead of `dist`. Lint, typecheck, and tests use the source condition. Node at runtime uses the built `dist`.

## Test

```sh
pnpm vitest run --project config
```
