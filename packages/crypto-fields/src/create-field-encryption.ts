import { KMSClient } from '@aws-sdk/client-kms';
import { ConfigError } from '@reef/errors';

import { BlindIndexer } from './blind-index.js';
import type { DataKeyProvider } from './data-key-provider.js';
import { FieldCipher } from './field-cipher.js';
import { decodeKey, readKeyFile } from './key-material.js';
import { KmsDataKeyProvider, type KmsSender } from './kms-provider.js';
import { LocalKeyFileProvider } from './local-key-provider.js';

/** Field-encryption settings, as parsed from env by `@reef/config`. */
export interface FieldEncryptionConfig {
  readonly FIELD_ENCRYPTION_PROVIDER: 'kms' | 'local';
  readonly FIELD_ENCRYPTION_KMS_KEY_ID?: string | undefined;
  readonly FIELD_ENCRYPTION_LOCAL_KEY_FILE?: string | undefined;
  readonly BLIND_INDEX_KEY?: string | undefined;
  readonly BLIND_INDEX_KEY_FILE?: string | undefined;
}

/** Ready-to-use encryption services. */
export interface FieldEncryption {
  readonly cipher: FieldCipher;
  readonly blindIndexer: BlindIndexer;
}

function missing(path: string, message: string): ConfigError {
  return new ConfigError({ issues: [{ path, message }] });
}

async function createProvider(
  config: FieldEncryptionConfig,
  createKmsClient: () => KmsSender,
): Promise<DataKeyProvider> {
  if (config.FIELD_ENCRYPTION_PROVIDER === 'kms') {
    const keyId = config.FIELD_ENCRYPTION_KMS_KEY_ID;
    if (keyId === undefined)
      throw missing('FIELD_ENCRYPTION_KMS_KEY_ID', 'required when provider is kms');
    return new KmsDataKeyProvider(createKmsClient(), keyId);
  }
  const file = config.FIELD_ENCRYPTION_LOCAL_KEY_FILE;
  if (file === undefined)
    throw missing('FIELD_ENCRYPTION_LOCAL_KEY_FILE', 'required when provider is local');
  return new LocalKeyFileProvider(await readKeyFile(file));
}

async function loadBlindIndexKey(config: FieldEncryptionConfig): Promise<Buffer> {
  const { BLIND_INDEX_KEY: inline, BLIND_INDEX_KEY_FILE: file } = config;
  if ((inline === undefined) === (file === undefined)) {
    throw missing('BLIND_INDEX_KEY', 'set exactly one of BLIND_INDEX_KEY or BLIND_INDEX_KEY_FILE');
  }
  return inline === undefined ? readKeyFile(String(file)) : decodeKey(inline, 'BLIND_INDEX_KEY');
}

/**
 * Builds the field cipher and blind indexer from config. Call once at startup.
 *
 * @param config Parsed env.
 * @param createKmsClient KMS client factory, injectable for tests.
 * @returns The cipher and blind indexer.
 * @throws ConfigError when a required key setting is missing or a key is malformed.
 */
export async function createFieldEncryption(
  config: FieldEncryptionConfig,
  createKmsClient: () => KmsSender = () => new KMSClient({}),
): Promise<FieldEncryption> {
  const [provider, blindIndexKey] = await Promise.all([
    createProvider(config, createKmsClient),
    loadBlindIndexKey(config),
  ]);
  return { cipher: new FieldCipher({ provider }), blindIndexer: new BlindIndexer(blindIndexKey) };
}
