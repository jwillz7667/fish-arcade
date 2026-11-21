import { readFile } from 'node:fs/promises';

import { ConfigError } from '@reef/errors';

/** Length of every symmetric key in this package. */
export const KEY_BYTES = 32;

/**
 * Decodes a base64 key and checks its length.
 *
 * @param encoded Base64 text, as written by `pnpm keys:dev` or stored in Secrets Manager.
 * @param name Variable or file name, used in the error. Never the key itself.
 * @returns The 32 key bytes.
 * @throws ConfigError when the decoded key is not 32 bytes.
 */
export function decodeKey(encoded: string, name: string): Buffer {
  const key = Buffer.from(encoded.trim(), 'base64');
  if (key.length !== KEY_BYTES) {
    throw new ConfigError({
      issues: [{ path: name, message: `must be ${String(KEY_BYTES)} bytes of base64` }],
    });
  }
  return key;
}

/**
 * Reads a base64 key file.
 *
 * @param path Path to the key file.
 * @returns The 32 key bytes.
 * @throws ConfigError when the file is missing or does not hold a 32-byte key.
 */
export async function readKeyFile(path: string): Promise<Buffer> {
  let encoded: string;
  try {
    // The path comes from validated config, not from user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    encoded = await readFile(path, 'utf8');
  } catch (error) {
    throw new ConfigError({
      issues: [{ path, message: 'key file is missing or unreadable' }],
      cause: error,
    });
  }
  return decodeKey(encoded, path);
}
