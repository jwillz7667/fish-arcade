import { DecryptCommand, GenerateDataKeyCommand, type KMSClient } from '@aws-sdk/client-kms';
import { DependencyUnavailableError, IntegrityError } from '@reef/errors';

import type { DataKey, DataKeyProvider } from './data-key-provider.js';

/** The part of `KMSClient` this provider uses. Lets tests pass a double. */
export type KmsSender = Pick<KMSClient, 'send'>;

function isAccessOrCiphertextError(error: unknown): boolean {
  return (
    error instanceof Error &&
    ['InvalidCiphertextException', 'IncorrectKeyException'].includes(error.name)
  );
}

/** {@link DataKeyProvider} backed by an AWS KMS symmetric key. Production default. */
export class KmsDataKeyProvider implements DataKeyProvider {
  readonly #client: KmsSender;
  readonly #keyId: string;

  /**
   * @param client KMS client (or test double).
   * @param keyId Key ID or ARN of the key-encryption key.
   */
  constructor(client: KmsSender, keyId: string) {
    this.#client = client;
    this.#keyId = keyId;
  }

  /**
   * @returns A data key from KMS GenerateDataKey (AES_256).
   * @throws DependencyUnavailableError when KMS fails or returns an incomplete key.
   */
  async generateDataKey(): Promise<DataKey> {
    let response;
    try {
      response = await this.#client.send(
        new GenerateDataKeyCommand({ KeyId: this.#keyId, KeySpec: 'AES_256' }),
      );
    } catch (error) {
      throw new DependencyUnavailableError({ dependency: 'kms', cause: error });
    }
    const { KeyId, Plaintext, CiphertextBlob } = response;
    if (KeyId === undefined || Plaintext === undefined || CiphertextBlob === undefined) {
      throw new DependencyUnavailableError({
        dependency: 'kms',
        message: 'KMS returned an incomplete data key',
      });
    }
    return {
      keyId: KeyId,
      plaintext: Buffer.from(Plaintext),
      wrapped: Buffer.from(CiphertextBlob),
    };
  }

  /**
   * @param keyId Key ARN recorded with the ciphertext. KMS is told to use exactly this key.
   * @param wrapped Wrapped data key.
   * @returns The plaintext data key.
   * @throws IntegrityError when KMS rejects the ciphertext or key.
   * @throws DependencyUnavailableError for any other KMS failure.
   */
  async decryptDataKey(keyId: string, wrapped: Buffer): Promise<Buffer> {
    let plaintext: Uint8Array | undefined;
    try {
      ({ Plaintext: plaintext } = await this.#client.send(
        new DecryptCommand({ KeyId: keyId, CiphertextBlob: wrapped }),
      ));
    } catch (error) {
      if (isAccessOrCiphertextError(error)) {
        throw new IntegrityError({ message: 'KMS rejected the wrapped data key', cause: error });
      }
      throw new DependencyUnavailableError({ dependency: 'kms', cause: error });
    }
    if (plaintext === undefined) {
      throw new DependencyUnavailableError({
        dependency: 'kms',
        message: 'KMS returned no plaintext',
      });
    }
    return Buffer.from(plaintext);
  }
}
