import { createPrivateKey, createPublicKey, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { decodeKey, readKeyFile } from '@reef/crypto-fields';
import { ConfigError } from '@reef/errors';

/** Key material for player auth. Loaded once at startup. */
export interface AuthKeys {
  /** Ed25519 private key that signs access tokens. */
  readonly signingKey: KeyObject;
  /** Matching public key that verifies them. */
  readonly verifyKey: KeyObject;
  /** `kid` header, so verifiers can tell keys apart during rotation. */
  readonly keyId: string;
  /** HMAC key for OTP codes, recovery codes, and CSRF tokens. */
  readonly hmacKey: Buffer;
}

/** The auth key settings from the API env. */
export interface AuthKeyConfig {
  readonly AUTH_JWT_PRIVATE_KEY?: string | undefined;
  readonly AUTH_JWT_PRIVATE_KEY_FILE?: string | undefined;
  readonly AUTH_JWT_KEY_ID: string;
  readonly AUTH_HMAC_KEY?: string | undefined;
  readonly AUTH_HMAC_KEY_FILE?: string | undefined;
}

function configError(path: string, message: string, cause?: unknown): ConfigError {
  return new ConfigError({ issues: [{ path, message }], cause });
}

function exactlyOne(inline: string | undefined, file: string | undefined, name: string): void {
  if ((inline === undefined) === (file === undefined)) {
    throw configError(name, `set exactly one of ${name} or ${name}_FILE`);
  }
}

async function readPem(path: string): Promise<string> {
  try {
    // The path comes from validated config, not from user input.
    // eslint-disable-next-line security/detect-non-literal-fs-filename
    return await readFile(path, 'utf8');
  } catch (error) {
    throw configError(path, 'key file is missing or unreadable', error);
  }
}

function parseSigningKey(pem: string): KeyObject {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: 'pem' });
  } catch (error) {
    throw configError('AUTH_JWT_PRIVATE_KEY', 'must be a PKCS#8 PEM private key', error);
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw configError('AUTH_JWT_PRIVATE_KEY', 'must be an Ed25519 key');
  }
  return key;
}

/**
 * Loads the access-token signing key and the auth HMAC key, each from an inline value
 * (Secrets Manager) or a file (`pnpm keys:dev`).
 *
 * @param config Parsed API env.
 * @returns The keys.
 * @throws ConfigError when a key is missing, set twice, unreadable, or the wrong type.
 */
export async function loadAuthKeys(config: AuthKeyConfig): Promise<AuthKeys> {
  exactlyOne(config.AUTH_JWT_PRIVATE_KEY, config.AUTH_JWT_PRIVATE_KEY_FILE, 'AUTH_JWT_PRIVATE_KEY');
  exactlyOne(config.AUTH_HMAC_KEY, config.AUTH_HMAC_KEY_FILE, 'AUTH_HMAC_KEY');

  const pem =
    config.AUTH_JWT_PRIVATE_KEY ?? (await readPem(String(config.AUTH_JWT_PRIVATE_KEY_FILE)));
  const signingKey = parseSigningKey(pem);
  const hmacKey =
    config.AUTH_HMAC_KEY === undefined
      ? await readKeyFile(String(config.AUTH_HMAC_KEY_FILE))
      : decodeKey(config.AUTH_HMAC_KEY, 'AUTH_HMAC_KEY');

  return {
    signingKey,
    verifyKey: createPublicKey(signingKey),
    keyId: config.AUTH_JWT_KEY_ID,
    hmacKey,
  };
}
