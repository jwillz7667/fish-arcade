import { defineProject, type UserWorkspaceConfig } from 'vitest/config';

/**
 * Package-export condition that resolves workspace packages to their TypeScript source, so
 * tests, typecheck, and lint never depend on a prior build.
 */
export const SOURCE_CONDITION = '@reef/source';

// Node's own conditions plus the source condition. Never add 'import' (it would also apply to
// require() inside CommonJS deps) or 'module' (bundler-only builds, such as the AWS SDK's).
const CONDITIONS = [SOURCE_CONDITION, 'node', 'development|production'];

const RESOLVE = {
  resolve: { conditions: CONDITIONS },
  ssr: { resolve: { conditions: CONDITIONS, externalConditions: [SOURCE_CONDITION] } },
};

/**
 * Vitest project for a workspace's unit tests: `src/**\/*.test.ts`, no I/O.
 *
 * @param name Project name shown in test output and used with `--project`.
 * @returns The project config to export from `vitest.config.ts`.
 */
export function createVitestProject(name: string): UserWorkspaceConfig {
  return defineProject({ ...RESOLVE, test: { name, include: ['src/**/*.test.ts'] } });
}

/**
 * Vitest project for a workspace's integration tests: `test/**\/*.test.ts`, against real
 * services prepared by `globalSetup`. Files run one at a time because they share a database.
 *
 * @param name Project name, conventionally `<workspace>-integration`.
 * @param globalSetup Path to the setup module, relative to the workspace.
 * @returns The project config to export from `vitest.integration.config.ts`.
 */
export function createIntegrationProject(name: string, globalSetup: string): UserWorkspaceConfig {
  return defineProject({
    ...RESOLVE,
    test: {
      name,
      include: ['test/**/*.test.ts'],
      globalSetup: [globalSetup],
      fileParallelism: false,
      testTimeout: 30_000,
      hookTimeout: 120_000,
    },
  });
}
