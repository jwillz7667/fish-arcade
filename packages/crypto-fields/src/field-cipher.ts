import { openAesGcm, sealAesGcm } from './aes-gcm.js';
import type { DataKey, DataKeyProvider } from './data-key-provider.js';
import { decodeEnvelope, encodeEnvelope } from './envelope.js';

/** Where an encrypted value lives. Bound into the ciphertext so values cannot be swapped. */
export interface FieldContext {
  readonly table: string;
  readonly column: string;
}

/** Options for {@link FieldCipher}. */
export interface FieldCipherOptions {
  /** Source of data keys. */
  readonly provider: DataKeyProvider;
  /** Encryptions per data key before a new one is requested. Default 10,000. */
  readonly maxUsesPerDataKey?: number;
  /** Milliseconds a data key is used for before rotation. Default 15 minutes. */
  readonly dataKeyTtlMs?: number;
  /** Unwrapped data keys kept for decryption. Default 1,000. */
  readonly decryptCacheSize?: number;
  /** Clock, injectable for tests. */
  readonly now?: () => number;
}

interface ActiveKey {
  readonly key: DataKey;
  readonly createdAt: number;
  uses: number;
}

function aadFor(context: FieldContext): Buffer {
  return Buffer.from(`reef:field:v1:${context.table}.${context.column}`, 'utf8');
}

/**
 * Envelope encryption for sensitive columns (playbook Step 3): AES-256-GCM under a data key,
 * with the data key wrapped by KMS or a local master key. Each envelope stores its wrapped
 * data key and key ID, so key-encryption keys can rotate without re-encrypting old rows.
 *
 * Data keys are reused for a bounded number of encryptions and a bounded time to limit KMS
 * calls; unwrapped keys are cached for decryption in a bounded LRU.
 */
export class FieldCipher {
  readonly #provider: DataKeyProvider;
  readonly #maxUses: number;
  readonly #ttlMs: number;
  readonly #cacheSize: number;
  readonly #now: () => number;
  readonly #decryptCache = new Map<string, Buffer>();
  #active: Promise<ActiveKey> | undefined;

  /** @param options Provider, rotation limits, cache size, and clock. */
  constructor(options: FieldCipherOptions) {
    this.#provider = options.provider;
    this.#maxUses = options.maxUsesPerDataKey ?? 10_000;
    this.#ttlMs = options.dataKeyTtlMs ?? 15 * 60 * 1000;
    this.#cacheSize = options.decryptCacheSize ?? 1_000;
    this.#now = options.now ?? Date.now;
  }

  /**
   * Encrypts one field value.
   *
   * @param plaintext The value.
   * @param context Table and column the value is stored in.
   * @returns A self-describing envelope string for the `*_enc` column.
   * @throws DependencyUnavailableError when a new data key is needed and the provider fails.
   */
  async encrypt(plaintext: string, context: FieldContext): Promise<string> {
    const { key } = await this.#reserveDataKey();
    const sealed = sealAesGcm(key.plaintext, Buffer.from(plaintext, 'utf8'), aadFor(context));
    return encodeEnvelope({ keyId: key.keyId, wrappedKey: key.wrapped, ...sealed });
  }

  /**
   * Decrypts one field value.
   *
   * @param envelope Value from a `*_enc` column.
   * @param context The same table and column used to encrypt.
   * @returns The plaintext.
   * @throws IntegrityError for a malformed, tampered, or misplaced envelope.
   * @throws DependencyUnavailableError when the provider cannot unwrap the data key.
   */
  async decrypt(envelope: string, context: FieldContext): Promise<string> {
    const parts = decodeEnvelope(envelope);
    const dataKey = await this.#unwrap(parts.keyId, parts.wrappedKey);
    return openAesGcm(dataKey, parts, aadFor(context)).toString('utf8');
  }

  // Under concurrency a fresh key can be shared by a few more callers than maxUsesPerDataKey;
  // the limit bounds KMS cost, it is not a security boundary.
  async #reserveDataKey(): Promise<ActiveKey> {
    const pending = this.#active;
    if (pending !== undefined) {
      const active = await this.#settle(pending);
      if (this.#isUsable(active)) {
        active.uses += 1;
        return active;
      }
      if (this.#active === pending) this.#active = undefined;
    }
    // Concurrent callers share one in-flight request for the next data key.
    this.#active ??= this.#provider
      .generateDataKey()
      .then((key) => ({ key, createdAt: this.#now(), uses: 0 }));
    const fresh = await this.#settle(this.#active);
    fresh.uses += 1;
    return fresh;
  }

  async #settle(pending: Promise<ActiveKey>): Promise<ActiveKey> {
    try {
      return await pending;
    } catch (error) {
      // A failed request must not poison later encryptions.
      if (this.#active === pending) this.#active = undefined;
      throw error;
    }
  }

  #isUsable(active: ActiveKey): boolean {
    return active.uses < this.#maxUses && this.#now() - active.createdAt < this.#ttlMs;
  }

  async #unwrap(keyId: string, wrapped: Buffer): Promise<Buffer> {
    const cacheKey = `${keyId}\u0000${wrapped.toString('base64')}`;
    const cached = this.#decryptCache.get(cacheKey);
    if (cached !== undefined) {
      // Re-insert to mark as most recently used.
      this.#decryptCache.delete(cacheKey);
      this.#decryptCache.set(cacheKey, cached);
      return cached;
    }
    const dataKey = await this.#provider.decryptDataKey(keyId, wrapped);
    this.#decryptCache.set(cacheKey, dataKey);
    if (this.#decryptCache.size > this.#cacheSize) {
      const oldest = this.#decryptCache.keys().next();
      if (oldest.done !== true) this.#decryptCache.delete(oldest.value);
    }
    return dataKey;
  }
}
