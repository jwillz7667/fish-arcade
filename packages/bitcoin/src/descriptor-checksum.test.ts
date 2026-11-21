import { describe, expect, it } from 'vitest';

import { withDescriptorChecksum } from './descriptor-checksum.js';

describe('withDescriptorChecksum', () => {
  // Vectors from Bitcoin Core's descriptor tests and getdescriptorinfo.
  it.each([
    ['raw(deadbeef)', 'raw(deadbeef)#89f8spxm'],
    [
      'addr(mkmZxiEcEd8ZqjQWVZuC6so5dFMKEFpN2j)',
      'addr(mkmZxiEcEd8ZqjQWVZuC6so5dFMKEFpN2j)#02wpgw69',
    ],
  ])('checksums %s', (descriptor, expected) => {
    expect(withDescriptorChecksum(descriptor)).toBe(expected);
  });

  it('refuses characters outside the descriptor alphabet', () => {
    expect(() => withDescriptorChecksum('raw(é)')).toThrow(/BIP 380/);
  });
});
