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
});
