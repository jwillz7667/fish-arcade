import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError } from '@reef/errors';
import { describe, expect, it } from 'vitest';

import { loadAuthKeys } from './auth-keys.js';

const ed25519Pem = (): string =>
  generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const hmac = randomBytes(32).toString('base64');

async function issuePaths(config: Parameters<typeof loadAuthKeys>[0]): Promise<string[]> {
  try {
    await loadAuthKeys(config);
    return [];
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    return error.issues.map((issue) => issue.path);
  }
}

describe('loadAuthKeys', () => {
  it('loads inline keys and derives the public key', async () => {
    const keys = await loadAuthKeys({
      AUTH_JWT_PRIVATE_KEY: ed25519Pem(),
      AUTH_JWT_KEY_ID: 'k1',
      AUTH_HMAC_KEY: hmac,
    });

    expect([keys.signingKey.type, keys.verifyKey.type, keys.keyId, keys.hmacKey.length]).toEqual([
      'private',
      'public',
      'k1',
      32,
    ]);
  });

  it('loads keys from files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'reef-auth-keys-'));
    await writeFile(join(dir, 'jwt.pem'), ed25519Pem());
    await writeFile(join(dir, 'hmac.key'), `${hmac}\n`);

    const keys = await loadAuthKeys({
      AUTH_JWT_PRIVATE_KEY_FILE: join(dir, 'jwt.pem'),
      AUTH_JWT_KEY_ID: 'k1',
      AUTH_HMAC_KEY_FILE: join(dir, 'hmac.key'),
    });

    expect(keys.signingKey.asymmetricKeyType).toBe('ed25519');
  });

  it('requires exactly one source per key', async () => {
    expect(await issuePaths({ AUTH_JWT_KEY_ID: 'k1', AUTH_HMAC_KEY: hmac })).toEqual([
      'AUTH_JWT_PRIVATE_KEY',
    ]);
    expect(
      await issuePaths({
        AUTH_JWT_PRIVATE_KEY: ed25519Pem(),
        AUTH_JWT_PRIVATE_KEY_FILE: 'x',
        AUTH_JWT_KEY_ID: 'k1',
        AUTH_HMAC_KEY: hmac,
      }),
    ).toEqual(['AUTH_JWT_PRIVATE_KEY']);
    expect(await issuePaths({ AUTH_JWT_PRIVATE_KEY: ed25519Pem(), AUTH_JWT_KEY_ID: 'k1' })).toEqual(
      ['AUTH_HMAC_KEY'],
    );
  });

  it('rejects keys of the wrong type or shape without echoing them', async () => {
    const x25519 = generateKeyPairSync('x25519')
      .privateKey.export({ type: 'pkcs8', format: 'pem' })
      .toString();

    expect(
      await issuePaths({
        AUTH_JWT_PRIVATE_KEY: x25519,
        AUTH_JWT_KEY_ID: 'k1',
        AUTH_HMAC_KEY: hmac,
      }),
    ).toEqual(['AUTH_JWT_PRIVATE_KEY']);
    expect(
      await issuePaths({
        AUTH_JWT_PRIVATE_KEY: 'not a pem',
        AUTH_JWT_KEY_ID: 'k1',
        AUTH_HMAC_KEY: hmac,
      }),
    ).toEqual(['AUTH_JWT_PRIVATE_KEY']);
    expect(
      await issuePaths({
        AUTH_JWT_PRIVATE_KEY: ed25519Pem(),
        AUTH_JWT_KEY_ID: 'k1',
        AUTH_HMAC_KEY: 'c2hvcnQ=',
      }),
    ).toEqual(['AUTH_HMAC_KEY']);
  });

  it('reports a missing key file', async () => {
    expect(
      await issuePaths({
        AUTH_JWT_PRIVATE_KEY_FILE: '/nonexistent/jwt.pem',
        AUTH_JWT_KEY_ID: 'k1',
        AUTH_HMAC_KEY: hmac,
      }),
    ).toEqual(['/nonexistent/jwt.pem']);
  });
});
