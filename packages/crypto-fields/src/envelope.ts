import { IntegrityError } from '@reef/errors';

const VERSION = 'v1';

/** The parts of a stored field envelope. */
export interface Envelope {
  /** Key-encryption key that wrapped `wrappedKey`. */
  readonly keyId: string;
  readonly wrappedKey: Buffer;
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
}

/**
 * Serialises an envelope as `v1.<keyId>.<wrappedKey>.<iv>.<tag>.<ciphertext>`, each part
 * base64url. The key ID is encoded too, because KMS ARNs contain `:` and `/`.
 *
 * @param envelope Parts to serialise.
 * @returns Text safe to store in a single column.
 */
export function encodeEnvelope(envelope: Envelope): string {
  return [
    VERSION,
    Buffer.from(envelope.keyId, 'utf8').toString('base64url'),
    envelope.wrappedKey.toString('base64url'),
    envelope.iv.toString('base64url'),
    envelope.tag.toString('base64url'),
    envelope.ciphertext.toString('base64url'),
  ].join('.');
}

/**
 * Parses {@link encodeEnvelope} output.
 *
 * @param text Stored envelope.
 * @returns Its parts.
 * @throws IntegrityError when the text is not a v1 envelope.
 */
export function decodeEnvelope(text: string): Envelope {
  const [version, keyId, wrappedKey, iv, tag, ciphertext, ...extra] = text.split('.');
  if (
    version !== VERSION ||
    keyId === undefined ||
    wrappedKey === undefined ||
    iv === undefined ||
    tag === undefined ||
    ciphertext === undefined ||
    extra.length > 0
  ) {
    throw new IntegrityError({ message: 'Value is not a v1 field envelope' });
  }
  return {
    keyId: Buffer.from(keyId, 'base64url').toString('utf8'),
    wrappedKey: Buffer.from(wrappedKey, 'base64url'),
    iv: Buffer.from(iv, 'base64url'),
    tag: Buffer.from(tag, 'base64url'),
    ciphertext: Buffer.from(ciphertext, 'base64url'),
  };
}
