import { randomBytes } from 'node:crypto';

import { DependencyUnavailableError, ErrorCode } from '@reef/errors';
import { describe, expect, it } from 'vitest';

import type { DataKey, DataKeyProvider } from './data-key-provider.js';
import { decodeEnvelope, encodeEnvelope } from './envelope.js';
import { FieldCipher } from './field-cipher.js';
import { LocalKeyFileProvider } from './local-key-provider.js';

const DOB = { table: 'profiles', column: 'dob_enc' };
const ZIP = { table: 'profiles', column: 'zip_enc' };

/** Counts calls through to a real local provider. */
class CountingProvider implements DataKeyProvider {
  generated = 0;
  unwrapped = 0;
  failNextGenerate = false;
  readonly #inner = new LocalKeyFileProvider(randomBytes(32));

  generateDataKey(): Promise<DataKey> {
    this.generated += 1;
    if (this.failNextGenerate) {
      this.failNextGenerate = false;
      return Promise.reject(new DependencyUnavailableError({ dependency: 'kms' }));
    }
    return this.#inner.generateDataKey();
  }

  decryptDataKey(keyId: string, wrapped: Buffer): Promise<Buffer> {
    this.unwrapped += 1;
    return this.#inner.decryptDataKey(keyId, wrapped);
  }
}

const integrity = expect.objectContaining({ code: ErrorCode.INTEGRITY_VIOLATION });

describe('FieldCipher', () => {
  it('round-trips a value', async () => {
    const cipher = new FieldCipher({ provider: new CountingProvider() });

    const envelope = await cipher.encrypt('1990-04-01', DOB);

    expect(await cipher.decrypt(envelope, DOB)).toBe('1990-04-01');
  });

  it('never contains the plaintext and differs on every call', async () => {
    const cipher = new FieldCipher({ provider: new CountingProvider() });

    const [first, second] = await Promise.all([
      cipher.encrypt('alice@example.com', DOB),
      cipher.encrypt('alice@example.com', DOB),
    ]);

    expect([first.includes('alice'), first === second]).toEqual([false, false]);
  });

  it('round-trips unicode', async () => {
    const cipher = new FieldCipher({ provider: new CountingProvider() });

    expect(await cipher.decrypt(await cipher.encrypt('Peña 🐟', DOB), DOB)).toBe('Peña 🐟');
  });

  it('rejects a value moved to another column', async () => {
    const cipher = new FieldCipher({ provider: new CountingProvider() });
    const envelope = await cipher.encrypt('10001', ZIP);

    await expect(cipher.decrypt(envelope, DOB)).rejects.toThrow(integrity);
  });

  it('rejects a tampered ciphertext', async () => {
    const cipher = new FieldCipher({ provider: new CountingProvider() });
    const parts = decodeEnvelope(await cipher.encrypt('10001', ZIP));
    const flipped = Buffer.from(parts.ciphertext);
    flipped[0] = (flipped[0] ?? 0) ^ 1;

    await expect(
      cipher.decrypt(encodeEnvelope({ ...parts, ciphertext: flipped }), ZIP),
    ).rejects.toThrow(integrity);
  });

  it('reuses a data key until the use limit, then rotates', async () => {
    const provider = new CountingProvider();
    const cipher = new FieldCipher({ provider, maxUsesPerDataKey: 2 });

    for (let call = 0; call < 5; call += 1) await cipher.encrypt('x', DOB);

    expect(provider.generated).toBe(3);
  });

  it('rotates the data key when it is older than the TTL', async () => {
    const provider = new CountingProvider();
    let now = 0;
    const cipher = new FieldCipher({ provider, dataKeyTtlMs: 1_000, now: () => now });

    await cipher.encrypt('x', DOB);
    now = 999;
    await cipher.encrypt('x', DOB);
    now = 1_000;
    await cipher.encrypt('x', DOB);

    expect(provider.generated).toBe(2);
  });

  it('shares one data-key request between concurrent encryptions', async () => {
    const provider = new CountingProvider();
    const cipher = new FieldCipher({ provider });

    await Promise.all(Array.from({ length: 20 }, () => cipher.encrypt('x', DOB)));

    expect(provider.generated).toBe(1);
  });

  it('recovers after a failed data-key request', async () => {
    const provider = new CountingProvider();
    provider.failNextGenerate = true;
    const cipher = new FieldCipher({ provider });

    await expect(cipher.encrypt('x', DOB)).rejects.toThrow(DependencyUnavailableError);
    const envelope = await cipher.encrypt('x', DOB);

    expect(await cipher.decrypt(envelope, DOB)).toBe('x');
  });

  it('caches unwrapped data keys for decryption', async () => {
    const provider = new CountingProvider();
    const cipher = new FieldCipher({ provider });
    const envelope = await cipher.encrypt('x', DOB);

    await cipher.decrypt(envelope, DOB);
    await cipher.decrypt(envelope, DOB);

    expect(provider.unwrapped).toBe(1);
  });

  it('evicts the least recently used data key past the cache size', async () => {
    const provider = new CountingProvider();
    const cipher = new FieldCipher({ provider, maxUsesPerDataKey: 1, decryptCacheSize: 2 });
    const [a, b, c] = [
      await cipher.encrypt('a', DOB),
      await cipher.encrypt('b', DOB),
      await cipher.encrypt('c', DOB),
    ];

    await cipher.decrypt(a, DOB);
    await cipher.decrypt(b, DOB);
    await cipher.decrypt(a, DOB);
    await cipher.decrypt(c, DOB);
    await cipher.decrypt(a, DOB);
    await cipher.decrypt(b, DOB);

    expect(provider.unwrapped).toBe(4);
  });
});

describe('envelopes', () => {
  it.each(['', 'v2.a.b.c.d.e', 'v1.a.b.c.d', 'v1.a.b.c.d.e.f', 'plaintext'])(
    'rejects %j',
    (text) => {
      expect(() => decodeEnvelope(text)).toThrow(integrity);
    },
  );

  it('round-trips a key ID containing separators', () => {
    const envelope = {
      keyId: 'arn:aws:kms:us-east-1:123:key/abc.def',
      wrappedKey: Buffer.from([1]),
      iv: Buffer.from([2]),
      tag: Buffer.from([3]),
      ciphertext: Buffer.from([4]),
    };

    expect(decodeEnvelope(encodeEnvelope(envelope))).toEqual(envelope);
  });
});

describe('LocalKeyFileProvider', () => {
  it('rejects a data key wrapped by another master key', async () => {
    const a = new LocalKeyFileProvider(randomBytes(32));
    const b = new LocalKeyFileProvider(randomBytes(32));
    const key = await a.generateDataKey();

    await expect(b.decryptDataKey(key.keyId, key.wrapped)).rejects.toThrow(integrity);
  });

  it('rejects a corrupted wrapped key', async () => {
    const provider = new LocalKeyFileProvider(randomBytes(32));
    const key = await provider.generateDataKey();

    await expect(provider.decryptDataKey(key.keyId, key.wrapped.subarray(1))).rejects.toThrow(
      integrity,
    );
  });
});
