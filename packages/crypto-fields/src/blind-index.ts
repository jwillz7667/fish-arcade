import { createHmac } from 'node:crypto';

/** What kind of value is indexed. Each kind is normalised differently and hashed apart. */
export type BlindIndexKind = 'email' | 'phone' | 'btc_address';

const BECH32_PREFIX = /^(bc1|tb1|bcrt1)/i;

function normalize(value: string, kind: BlindIndexKind): string {
  const trimmed = value.normalize('NFKC').trim();
  switch (kind) {
    case 'email':
      return trimmed.toLowerCase();
    case 'phone':
      // E.164: keep a leading + and the digits only.
      return `${trimmed.startsWith('+') ? '+' : ''}${trimmed.replace(/\D/g, '')}`;
    case 'btc_address':
      // Bech32 is case-insensitive; base58 addresses are case-sensitive and kept as is.
      return BECH32_PREFIX.test(trimmed) ? trimmed.toLowerCase() : trimmed;
  }
}

/**
 * HMAC-SHA256 blind index for equality lookups on encrypted values (playbook Step 3). The key
 * is separate from the encryption keys, so a leaked index cannot help decrypt anything.
 */
export class BlindIndexer {
  readonly #key: Buffer;

  /** @param key 32-byte HMAC key, distinct from every encryption key. */
  constructor(key: Buffer) {
    this.#key = key;
  }

  /**
   * @param value Raw value, such as an email as typed.
   * @param kind How to normalise it.
   * @returns Lowercase hex digest for the `*_bidx` column.
   */
  index(value: string, kind: BlindIndexKind): string {
    return createHmac('sha256', this.#key)
      .update(`${kind}\u0000${normalize(value, kind)}`, 'utf8')
      .digest('hex');
  }
}
