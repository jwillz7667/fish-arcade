# @reef/config

Shared tooling configuration for every workspace (spec §19).

|          |                                    |
| -------- | ---------------------------------- |
| Spec     | §19                                |
| Built in | Step 1 of `docs/BUILD_PLAYBOOK.md` |

## Contents

| Export                               | Use                                                                                                                                                                                                             |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@reef/config/eslint`                | `createReefConfig({ rootDir })`: flat config with typescript-eslint strict-type-checked, eslint-plugin-security, the `Math.random` ban (except `packages/simulator`), and the `console` ban (except `scripts/`) |
| `@reef/config/tsconfig/base.json`    | Strict compiler options shared by everything                                                                                                                                                                    |
| `@reef/config/tsconfig/node.json`    | Node services and packages (NodeNext modules, Node types)                                                                                                                                                       |
| `@reef/config/tsconfig/browser.json` | Browser bundles built with Vite (Bundler resolution, DOM lib)                                                                                                                                                   |
| `@reef/config/tsconfig/react.json`   | React workspaces (`browser.json` plus `react-jsx`)                                                                                                                                                              |

## Test

```sh
pnpm vitest run --project config
```
