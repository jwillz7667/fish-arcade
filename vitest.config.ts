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
        'apps/api/src/wallet/**',
        // NestJS wiring needs Postgres and Redis; covered by the API end-to-end tests.
        'apps/api/src/app/**',
        'apps/api/src/health/**',
        'apps/api/src/http/**/*.guard.ts',
        'apps/api/src/http/**/*.interceptor.ts',
        'apps/api/src/http/**/*.filter.ts',
        'apps/api/src/http/**/*-store.ts',
        'apps/api/src/http/**/redis-*.ts',
        'apps/api/src/main.ts',
        // Player auth services, stores, and routes run against Postgres and Redis; the auth
        // end-to-end tests cover them. Pure auth logic stays in unit coverage.
        'apps/api/src/audit/**',
        'apps/api/src/db/**',
        'apps/api/src/auth/auth-providers.ts',
        'apps/api/src/auth/auth-dependencies.ts',
        'apps/api/src/auth/**/*-repository.ts',
        'apps/api/src/auth/**/*.controller.ts',
        'apps/api/src/auth/**/*.guard.ts',
        'apps/api/src/auth/contact/contact-change-service.ts',
        'apps/api/src/auth/login/login-service.ts',
        'apps/api/src/auth/login/backoff-throttle.ts',
        'apps/api/src/auth/mfa/mfa-service.ts',
        'apps/api/src/auth/otp/otp-service.ts',
        'apps/api/src/auth/passkeys/passkey-service.ts',
        'apps/api/src/auth/sessions/session-service.ts',
        'apps/api/src/auth/signup/signup-service.ts',
        'apps/api/src/auth/tickets/**',
        'apps/api/src/auth/http/token-delivery.ts',
        // Geolocation and jurisdiction services, stores, guard, and route: covered by the
        // compliance end-to-end tests. The pure policy, decision, and token code stays here.
        'apps/api/src/compliance/compliance-providers.ts',
        'apps/api/src/compliance/**/*-repository.ts',
        'apps/api/src/compliance/**/*-service.ts',
        'apps/api/src/compliance/**/*.controller.ts',
        'apps/api/src/compliance/**/*.guard.ts',
        'apps/api/src/compliance/holds/**',
        'apps/api/src/compliance/kyc/dev-stub-kyc-provider.ts',
        'apps/api/src/shared/**',
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
