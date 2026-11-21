import { createHash, randomBytes } from 'node:crypto';

import { IntegrityError } from '@reef/errors';

import { AES_GCM_OVERHEAD, openAesGcm, sealAesGcm } from './aes-gcm.js';
import type { DataKey, DataKeyProvider } from './data-key-provider.js';
import { KEY_BYTES } from './key-material.js';

const WRAP_AAD = Buffer.from('reef:local-data-key:v1');

/**
 * Development-only {@link DataKeyProvider} that wraps data keys with a master key read from a
 * gitignored file. The production env schema rejects it.
 */
export class LocalKeyFileProvider implements DataKeyProvider {
  readonly #masterKey: Buffer;
  readonly #keyId: string;

  /** @param masterKey 32-byte master key. */
  constructor(masterKey: Buffer) {
    this.#masterKey = masterKey;
    // Identifies the master key without revealing it.
    this.#keyId = `local:${createHash('sha256').update(masterKey).digest('hex').slice(0, 16)}`;
  }

  /** @returns A new data key wrapped under the master key. */
  generateDataKey(): Promise<DataKey> {
    const plaintext = randomBytes(KEY_BYTES);
    const { iv, tag, ciphertext } = sealAesGcm(this.#masterKey, plaintext, WRAP_AAD);
    return Promise.resolve({
      keyId: this.#keyId,
      plaintext,
      wrapped: Buffer.concat([iv, tag, ciphertext]),
    });
  }

  /**
   * @param keyId Must be this provider's key ID.
   * @param wrapped A data key from {@link generateDataKey}.
   * @returns The plaintext data key.
   * @throws IntegrityError for a different master key or a corrupted wrapped key.
   */
  decryptDataKey(keyId: string, wrapped: Buffer): Promise<Buffer> {
    const { ivBytes, tagBytes } = AES_GCM_OVERHEAD;
    // Anything thrown inside the executor becomes the rejection.
    return new Promise((resolve) => {
      if (keyId !== this.#keyId) {
        throw new IntegrityError({ message: 'Data key wrapped by another master key' });
      }
      const sealed = {
        iv: wrapped.subarray(0, ivBytes),
        tag: wrapped.subarray(ivBytes, ivBytes + tagBytes),
        ciphertext: wrapped.subarray(ivBytes + tagBytes),
      };
      resolve(openAesGcm(this.#masterKey, sealed, WRAP_AAD));
    });
  }
}
