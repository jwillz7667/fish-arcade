/** A fresh data key: the plaintext for encrypting, and the wrapped copy to store. */
export interface DataKey {
  /** Identifies the key-encryption key that wrapped this data key. */
  readonly keyId: string;
  /** 32-byte AES-256 key. Keep in memory only. */
  readonly plaintext: Buffer;
  /** The data key encrypted under `keyId`. Stored alongside each ciphertext. */
  readonly wrapped: Buffer;
}

/**
 * Source of data keys for envelope encryption. Production uses AWS KMS; development uses a
 * local key file (playbook Step 3).
 */
export interface DataKeyProvider {
  /**
   * @returns A new random data key and its wrapped form.
   * @throws DependencyUnavailableError when the key service fails.
   */
  generateDataKey(): Promise<DataKey>;

  /**
   * Unwraps a stored data key.
   *
   * @param keyId The key-encryption key recorded with the ciphertext.
   * @param wrapped The wrapped data key recorded with the ciphertext.
   * @returns The 32-byte plaintext data key.
   * @throws IntegrityError when the wrapped key does not belong to `keyId` or fails to decrypt.
   * @throws DependencyUnavailableError when the key service fails.
   */
  decryptDataKey(keyId: string, wrapped: Buffer): Promise<Buffer>;
}
