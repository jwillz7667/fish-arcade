import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { KEY_BYTES } from '@reef/crypto-fields';

// CLAUDE.md: dev keys are generated at runtime into gitignored folders, never in production.
if (process.env['NODE_ENV'] === 'production') {
  console.error('Refusing to generate dev keys with NODE_ENV=production.');
  process.exit(1);
}

const keyDir = fileURLToPath(new URL('../../../.keys/dev/', import.meta.url));
const { privateKey } = generateKeyPairSync('ed25519');
const files = [
  {
    name: 'auth-jwt.pem',
    contents: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  },
  { name: 'auth-hmac.key', contents: `${randomBytes(KEY_BYTES).toString('base64')}\n` },
];

await mkdir(keyDir, { recursive: true, mode: 0o700 });
for (const { name, contents } of files) {
  try {
    // 'wx' fails atomically if the file exists. Never overwrite: replacing the HMAC key would
    // invalidate stored OTP and recovery-code hashes.
    await writeFile(`${keyDir}${name}`, contents, { mode: 0o600, flag: 'wx' });
    console.log(`Wrote .keys/dev/${name}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    console.log(`Kept existing .keys/dev/${name}`);
  }
}
