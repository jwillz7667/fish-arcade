import { defineConfig } from 'vitest/config';

const FULL_COVERAGE = { branches: 100, functions: 100, lines: 100, statements: 100 };

export default defineConfig({
  test: {
    projects: ['{apps,games,packages}/*/vitest.config.ts'],
    coverage: {
      provider: 'v8',
      // Matched relative to each project's root, so the workspace prefix is a wildcard.
      include: ['**/src/**/*.{ts,tsx}'],
      // Barrels only re-export; vitest.ts is test tooling loaded before coverage starts.
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/index.ts',
        '**/generated/**',
        'packages/config/src/vitest.ts',
        // Needs a real database; covered by `pnpm test:integration` instead.
        'packages/db/src/**',
      ],
      reporter: ['text-summary', 'html', 'json-summary'],
      thresholds: {
        // CLAUDE.md: at least 80% everywhere, 100% branches on money, ledger, and math.
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
        'packages/money/src/**': FULL_COVERAGE,
        'packages/ledger/src/**': FULL_COVERAGE,
        'packages/math/src/**': FULL_COVERAGE,
      },
    },
  },
});
