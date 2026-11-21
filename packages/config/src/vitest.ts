import { defineProject, type UserWorkspaceConfig } from 'vitest/config';

/**
 * Package-export condition that resolves workspace packages to their TypeScript source, so
 * tests, typecheck, and lint never depend on a prior build.
 */
export const SOURCE_CONDITION = '@reef/source';

/**
 * Builds the Vitest project config shared by every workspace.
 *
 * @param name Project name shown in test output and used with `--project`.
 * @returns The project config to export from `vitest.config.ts`.
 */
export function createVitestProject(name: string): UserWorkspaceConfig {
  const conditions = [SOURCE_CONDITION, 'node', 'import', 'default'];
  return defineProject({
    resolve: { conditions },
    ssr: { resolve: { conditions, externalConditions: [SOURCE_CONDITION] } },
    test: {
      name,
      include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    },
  });
}
