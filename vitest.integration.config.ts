import { SOURCE_RESOLVE } from '@reef/config/vitest';
import { defineConfig } from 'vitest/config';

// Integration tests need real services: see each workspace's test/global-setup.ts.
export default defineConfig({
  // globalSetup files run under this root config, not their project's, so they need it too.
  ...SOURCE_RESOLVE,
  test: {
    projects: ['{apps,packages}/*/vitest.integration.config.ts'],
    coverage: {
      provider: 'v8',
      // Only workspaces with integration suites; other packages are measured by unit tests.
      // Globs match absolute paths, hence the leading **.
      include: ['**/packages/db/src/**/*.ts', '**/apps/api/src/**/*.ts'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/index.ts',
        '**/generated/**',
        '**/testing/**',
        '**/apps/api/src/main.ts',
      ],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage/integration',
      thresholds: { branches: 80, functions: 80, lines: 80, statements: 80 },
    },
  },
});
