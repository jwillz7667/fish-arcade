import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, expect, it } from 'vitest';

import { createReefConfig } from './eslint.js';

const rootDir = fileURLToPath(new URL('../../..', import.meta.url));

// The rules under test are syntactic, so type-aware linting is switched off. That lets the
// tests lint virtual files at any path without creating them on disk.
const eslint = new ESLint({
  cwd: rootDir,
  overrideConfigFile: true,
  overrideConfig: [...createReefConfig({ rootDir }), tseslint.configs.disableTypeChecked],
});

async function ruleIdsFor(code: string, filePath: string): Promise<string[]> {
  const [result] = await eslint.lintText(code, { filePath });
  return (result?.messages ?? []).map((message) => message.ruleId ?? 'fatal');
}

describe('createReefConfig', () => {
  it('rejects Math.random in apps/api', async () => {
    const ruleIds = await ruleIdsFor(
      'export const roll = Math.random();\n',
      'apps/api/src/roll.ts',
    );

    expect(ruleIds).toContain('no-restricted-properties');
  });

  it('rejects Math.random pulled out by destructuring', async () => {
    const ruleIds = await ruleIdsFor(
      'const { random } = Math;\nexport const roll = random();\n',
      'packages/math/src/roll.ts',
    );

    expect(ruleIds).toContain('no-restricted-properties');
  });

  it('allows Math.random in packages/simulator', async () => {
    const ruleIds = await ruleIdsFor(
      'export const roll = Math.random();\n',
      'packages/simulator/src/roll.ts',
    );

    expect(ruleIds).toEqual([]);
  });

  it('rejects console outside scripts folders', async () => {
    const ruleIds = await ruleIdsFor("console.log('hi');\n", 'apps/workers/src/job.ts');

    expect(ruleIds).toContain('no-console');
  });

  it('allows console inside a scripts folder', async () => {
    const ruleIds = await ruleIdsFor("console.log('hi');\n", 'scripts/seed.ts');

    expect(ruleIds).toEqual([]);
  });

  it('accepts crypto-based randomness without any findings', async () => {
    const ruleIds = await ruleIdsFor(
      "import { randomInt } from 'node:crypto';\nexport const roll = randomInt(0, 100);\n",
      'apps/api/src/roll.ts',
    );

    expect(ruleIds).toEqual([]);
  });

  it.each([
    ['raw SQL naming a ledger table', "export const q = 'UPDATE balances SET amount = 0';\n"],
    [
      'a template literal naming a ledger table',
      'export const q = `SELECT * FROM ledger_entries`;\n',
    ],
    [
      'a Prisma ledger delegate',
      'declare const prisma: { ledgerEntry: unknown };\nexport const d = prisma.ledgerEntry;\n',
    ],
    ['the ledger enums from @reef/db', "export { LedgerOwnerType } from '@reef/db';\n"],
  ])('rejects %s outside the wallet module', async (_label, code) => {
    const ruleIds = await ruleIdsFor(code, 'apps/api/src/cashier/service.ts');

    expect(
      ruleIds.some((id) => id === 'no-restricted-syntax' || id === 'no-restricted-imports'),
    ).toBe(true);
  });

  it('allows ledger SQL inside the wallet module and packages/db', async () => {
    const code = "export const q = 'UPDATE balances SET amount = 0';\n";

    expect([
      await ruleIdsFor(code, 'apps/api/src/wallet/post-journal.ts'),
      await ruleIdsFor(code, 'packages/db/src/x.ts'),
    ]).toEqual([[], []]);
  });

  it('does not flag prose that merely mentions balances', async () => {
    const ruleIds = await ruleIdsFor(
      "export const m = 'SC balances cannot cover the bet';\n",
      'packages/ledger/src/x.ts',
    );

    expect(ruleIds).toEqual([]);
  });

  it('rejects deep imports into the wallet and allows its barrel', async () => {
    const deep = await ruleIdsFor(
      "export { postJournal } from '../wallet/post-journal.js';\n",
      'apps/api/src/cashier/x.ts',
    );
    const barrel = await ruleIdsFor(
      "export { postJournal } from '../wallet/index.js';\n",
      'apps/api/src/cashier/x.ts',
    );

    expect([deep, barrel]).toEqual([['no-restricted-imports'], []]);
  });
});
