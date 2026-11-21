import { fileURLToPath } from 'node:url';

import { SOURCE_RESOLVE } from '@reef/config/vitest';
import { defineConfig } from 'vitest/config';

// Regtest end-to-end tests. They need `pnpm btc:up` first and run with `pnpm test:btc`.
export default defineConfig({
  ...SOURCE_RESOLVE,
  root: fileURLToPath(new URL('.', import.meta.url)),
  test: {
    name: 'bitcoin-regtest',
    include: ['test/**/*.e2e.test.ts'],
    testTimeout: 180_000,
    hookTimeout: 60_000,
  },
});
