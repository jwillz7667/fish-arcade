import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { BlindIndexer } from './blind-index.js';

const indexer = new BlindIndexer(randomBytes(32));

describe('BlindIndexer', () => {
  it('normalises emails before hashing', () => {
    expect(indexer.index('  Alice@Example.COM ', 'email')).toBe(
      indexer.index('alice@example.com', 'email'),
    );
  });

  it('normalises phone formatting but keeps the + prefix meaningful', () => {
    expect(indexer.index('+1 (555) 010-0199', 'phone')).toBe(
      indexer.index('+15550100199', 'phone'),
    );
    expect(indexer.index('15550100199', 'phone')).not.toBe(indexer.index('+15550100199', 'phone'));
  });

  it('lowercases bech32 addresses and keeps base58 case', () => {
    expect(indexer.index('BC1QXY2KGDYGJRSQTZQ2N0YRF2493P83KKFJHX0WLH', 'btc_address')).toBe(
      indexer.index('bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'btc_address'),
    );
    expect(indexer.index('1BoatSLRHtKNngkdXEeobR76b53LETtpyT', 'btc_address')).not.toBe(
      indexer.index('1boatslrhtknngkdxeeobr76b53lettpyt', 'btc_address'),
    );
  });

  it('separates kinds and keys', () => {
    const other = new BlindIndexer(randomBytes(32));

    expect(
      new Set([
        indexer.index('15550100199', 'email'),
        indexer.index('15550100199', 'phone'),
        other.index('15550100199', 'phone'),
      ]).size,
    ).toBe(3);
  });

  it('returns a 64-character hex digest that does not contain the input', () => {
    const digest = indexer.index('alice@example.com', 'email');

    expect(digest).toMatch(/^[0-9a-f]{64}$/);
  });
});
