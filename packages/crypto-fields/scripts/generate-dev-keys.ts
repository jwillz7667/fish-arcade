import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { KEY_BYTES } from '../src/key-material.js';

// CLAUDE.md: dev keys are generated at runtime into gitignored folders, never in production.
if (process.env['NODE_ENV'] === 'production') {
  console.error('Refusing to generate dev keys with NODE_ENV=production.');
  process.exit(1);
}

const keyDir = fileURLToPath(new URL('../../../.keys/dev/', import.meta.url));
const files = ['field-master.key', 'blind-index.key'];

await mkdir(keyDir, { recursive: true, mode: 0o700 });
for (const name of files) {
  const path = `${keyDir}${name}`;
  try {
    // 'wx' fails atomically if the file exists. Never overwrite: existing ciphertexts and
    // indexes depend on these keys.
    await writeFile(path, `${randomBytes(KEY_BYTES).toString('base64')}\n`, {
      mode: 0o600,
      flag: 'wx',
    });
    console.log(`Wrote .keys/dev/${name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    console.log(`Kept existing .keys/dev/${name}`);
  }
}
