import { randomBytes } from 'node:crypto';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ErrorCode } from '@reef/errors';
import { beforeAll, describe, expect, it } from 'vitest';

import { createFieldEncryption } from './create-field-encryption.js';
import { decodeKey } from './key-material.js';

const config = expect.objectContaining({ code: ErrorCode.CONFIG_INVALID });
let masterFile = '';
let indexFile = '';
let badFile = '';

beforeAll(async () => {
  const dir = await mkdtemp(join(tmpdir(), 'reef-keys-'));
  masterFile = join(dir, 'master.key');
  indexFile = join(dir, 'index.key');
  badFile = join(dir, 'bad.key');
  await writeFile(masterFile, randomBytes(32).toString('base64'));
  await writeFile(indexFile, randomBytes(32).toString('base64'));
  await writeFile(badFile, randomBytes(16).toString('base64'));
});

describe('createFieldEncryption', () => {
  it('builds working services from local key files', async () => {
    const { cipher, blindIndexer } = await createFieldEncryption({
      FIELD_ENCRYPTION_PROVIDER: 'local',
      FIELD_ENCRYPTION_LOCAL_KEY_FILE: masterFile,
      BLIND_INDEX_KEY_FILE: indexFile,
    });
    const context = { table: 'users', column: 'email_enc' };

    expect(await cipher.decrypt(await cipher.encrypt('a@b.c', context), context)).toBe('a@b.c');
    expect(blindIndexer.index('a@b.c', 'email')).toHaveLength(64);
  });

  it('uses KMS with an inline blind index key', async () => {
    let created = 0;

    await createFieldEncryption(
      {
        FIELD_ENCRYPTION_PROVIDER: 'kms',
        FIELD_ENCRYPTION_KMS_KEY_ID: 'alias/reef-fields',
        BLIND_INDEX_KEY: randomBytes(32).toString('base64'),
      },
      () => {
        created += 1;
        return { send: () => Promise.reject(new Error('unused')) };
      },
    );

    expect(created).toBe(1);
  });

  it.each([
    [{ FIELD_ENCRYPTION_PROVIDER: 'kms', BLIND_INDEX_KEY_FILE: '' }],
    [{ FIELD_ENCRYPTION_PROVIDER: 'local' }],
  ] as const)('rejects a missing key setting', async (partial) => {
    await expect(
      createFieldEncryption({ ...partial, BLIND_INDEX_KEY_FILE: indexFile }),
    ).rejects.toThrow(config);
  });

  it('requires exactly one blind index key source', async () => {
    const base = {
      FIELD_ENCRYPTION_PROVIDER: 'local',
      FIELD_ENCRYPTION_LOCAL_KEY_FILE: masterFile,
    } as const;

    await expect(createFieldEncryption(base)).rejects.toThrow(config);
    await expect(
      createFieldEncryption({ ...base, BLIND_INDEX_KEY_FILE: indexFile, BLIND_INDEX_KEY: 'x' }),
    ).rejects.toThrow(config);
  });

  it('rejects short and missing key files', async () => {
    const base = { FIELD_ENCRYPTION_PROVIDER: 'local', BLIND_INDEX_KEY_FILE: indexFile } as const;

    await expect(
      createFieldEncryption({ ...base, FIELD_ENCRYPTION_LOCAL_KEY_FILE: badFile }),
    ).rejects.toThrow(config);
    await expect(
      createFieldEncryption({ ...base, FIELD_ENCRYPTION_LOCAL_KEY_FILE: `${badFile}.missing` }),
    ).rejects.toThrow(config);
  });

  it('names the setting, never the key, when a key is malformed', () => {
    const secret = randomBytes(8).toString('base64');

    expect(() => decodeKey(secret, 'BLIND_INDEX_KEY')).toThrow(
      expect.objectContaining({
        issues: [{ path: 'BLIND_INDEX_KEY', message: expect.not.stringContaining(secret) }],
      }),
    );
  });
});
