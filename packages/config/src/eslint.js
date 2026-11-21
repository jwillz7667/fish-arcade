// @ts-check
import js from '@eslint/js';
import { defineConfig } from 'eslint/config';
import security from 'eslint-plugin-security';
import tseslint from 'typescript-eslint';

const JS_FILES = ['**/*.{js,jsx,mjs,cjs}'];
const TEST_FILES = ['**/*.test.{ts,tsx}', '**/test/**/*.{ts,tsx}'];

/**
 * Packages allowed to call `Math.random`. CLAUDE.md: randomness comes from
 * `node:crypto` everywhere except the simulator, which needs fast, seedable draws.
 */
const MATH_RANDOM_EXEMPT_FILES = ['packages/simulator/**'];

/** Folders where `console` output is the intended interface (CLAUDE.md: console banned elsewhere). */
const CONSOLE_ALLOWED_FILES = ['**/scripts/**'];

/**
 * CLAUDE.md: only the wallet module writes ledger tables, and every balance change goes through
 * postJournal. The schema owner (packages/db) and the wallet's own tests are the only other
 * places allowed to name them.
 */
const LEDGER_OWNER_FILES = ['apps/api/src/wallet/**', 'apps/api/test/wallet/**', 'packages/db/**'];

const LEDGER_TABLE_SQL = String.raw`/\b(from|join|into|update|table|truncate)\s+"?(ledger_accounts|ledger_entries|journals|balances)\b/i`;

const LEDGER_MESSAGE =
  'Ledger tables belong to the wallet module. Use postJournal and getBalances from apps/api/src/wallet.';

const LEDGER_RESTRICTED_SYNTAX = [
  { selector: `Literal[value=${LEDGER_TABLE_SQL}]`, message: LEDGER_MESSAGE },
  { selector: `TemplateElement[value.raw=${LEDGER_TABLE_SQL}]`, message: LEDGER_MESSAGE },
  {
    // Prisma delegates for the ledger models, e.g. prisma.ledgerEntry or tx.balance.
    selector:
      'MemberExpression[object.name=/^(prisma|tx|db|client)$/i][property.name=/^(ledgerAccount|ledgerEntry|journal|balance)$/]',
    message: LEDGER_MESSAGE,
  },
];

const LEDGER_RESTRICTED_IMPORTS = {
  paths: [
    {
      name: '@reef/db',
      importNames: ['LedgerOwnerType', 'LedgerAccountKind'],
      message: LEDGER_MESSAGE,
    },
  ],
  patterns: [
    {
      // Wallet internals are private; outside code imports its barrel only.
      regex: String.raw`/wallet/(?!index(\.js)?$)`,
      message: 'Import the wallet module through its index only.',
    },
  ],
};

const MATH_RANDOM_RESTRICTION = {
  object: 'Math',
  property: 'random',
  message:
    'Math.random is not cryptographically secure. Use randomInt or randomBytes from node:crypto.',
};

/**
 * Options for {@link createReefConfig}.
 *
 * @typedef {object} ReefConfigOptions
 * @property {string} rootDir Absolute path of the repository root. Used as the TypeScript
 *   project service root and as the base for every file glob in the config.
 */

/**
 * Builds the shared ESLint flat config for the Reef monorepo.
 *
 * Applies `typescript-eslint` strict-type-checked and `eslint-plugin-security` recommended
 * rules, bans `Math.random` outside the simulator, and bans `console` outside `scripts/`.
 * Type-aware rules are disabled for plain JavaScript files, which are config files only.
 *
 * @param {ReefConfigOptions} options Repository settings.
 * @returns {import('eslint').Linter.Config[]} The flat config array to export from `eslint.config.js`.
 */
export function createReefConfig({ rootDir }) {
  return defineConfig(
    {
      ignores: [
        '**/node_modules/**',
        '**/dist/**',
        '**/build/**',
        '**/out/**',
        '**/.next/**',
        '**/.turbo/**',
        '**/coverage/**',
        '.keys/**',
        '**/generated/**',
      ],
    },
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    security.configs.recommended,
    {
      languageOptions: {
        parserOptions: {
          projectService: true,
          tsconfigRootDir: rootDir,
        },
      },
      linterOptions: {
        reportUnusedDisableDirectives: 'error',
      },
      rules: {
        'no-restricted-properties': ['error', MATH_RANDOM_RESTRICTION],
        'no-console': 'error',
      },
    },
    {
      files: JS_FILES,
      extends: [tseslint.configs.disableTypeChecked],
    },
    {
      ignores: [...LEDGER_OWNER_FILES, 'packages/config/src/eslint.test.ts'],
      rules: {
        'no-restricted-syntax': ['error', ...LEDGER_RESTRICTED_SYNTAX],
        'no-restricted-imports': ['error', LEDGER_RESTRICTED_IMPORTS],
      },
    },
    {
      files: MATH_RANDOM_EXEMPT_FILES,
      rules: { 'no-restricted-properties': 'off' },
    },
    {
      files: CONSOLE_ALLOWED_FILES,
      rules: {
        'no-console': 'off',
        // Scripts build file paths from import.meta.url, never from input.
        'security/detect-non-literal-fs-filename': 'off',
      },
    },
    {
      files: TEST_FILES,
      rules: {
        // CLAUDE.md: non-null assertions are allowed in tests only.
        '@typescript-eslint/no-non-null-assertion': 'off',
        // Vitest asymmetric matchers (expect.objectContaining and friends) are typed `any`.
        '@typescript-eslint/no-unsafe-assignment': 'off',
        // Test fixtures index by literal keys and write temp files; there is no untrusted input.
        'security/detect-object-injection': 'off',
        'security/detect-non-literal-fs-filename': 'off',
        'security/detect-possible-timing-attacks': 'off',
      },
    },
  );
}
