import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { IntegrityError } from '@reef/errors';

const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Output of {@link sealAesGcm}. */
export interface Sealed {
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/**
 * AES-256-GCM encryption with a fresh random 96-bit IV.
 *
 * @param key 32-byte key.
 * @param plaintext Data to encrypt.
 * @param aad Additional authenticated data, bound to the ciphertext but not encrypted.
 * @returns IV, auth tag, and ciphertext.
 */
export function sealAesGcm(key: Buffer, plaintext: Buffer, aad: Buffer): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

/**
 * Reverses {@link sealAesGcm}.
 *
 * @param key 32-byte key.
 * @param sealed IV, auth tag, and ciphertext.
 * @param aad The same additional authenticated data used to seal.
 * @returns The plaintext.
 * @throws IntegrityError when the key, AAD, or any byte of the input is wrong.
 */
export function openAesGcm(key: Buffer, sealed: Sealed, aad: Buffer): Buffer {
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(aad);
    decipher.setAuthTag(sealed.tag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch (error) {
    throw new IntegrityError({ message: 'AES-GCM authentication failed', cause: error });
  }
}

/** Byte length of the IV and tag, for callers that pack them into one buffer. */
export const AES_GCM_OVERHEAD = { ivBytes: IV_BYTES, tagBytes: TAG_BYTES } as const;
