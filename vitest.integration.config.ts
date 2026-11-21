import { defineConfig } from 'vitest/config';

// Integration tests need real services: see each workspace's test/global-setup.ts.
export default defineConfig({
  test: {
    projects: ['{apps,packages}/*/vitest.integration.config.ts'],
    coverage: {
      provider: 'v8',
      // Only workspaces with integration suites; other packages are measured by unit tests.
      // Globs match absolute paths, hence the leading **.
      include: ['**/packages/db/src/**/*.ts'],
      exclude: ['**/*.test.{ts,tsx}', '**/index.ts', '**/generated/**'],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage/integration',
      thresholds: { branches: 80, functions: 80, lines: 80, statements: 80 },
    },
  },
});
