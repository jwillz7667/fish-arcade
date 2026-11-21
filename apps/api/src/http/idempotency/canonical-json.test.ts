import { describe, expect, it } from 'vitest';

import { canonicalJson } from './canonical-json.js';

describe('canonicalJson', () => {
  it('sorts keys at every depth and keeps array order', () => {
    expect(canonicalJson({ b: 1, a: { d: [3, 1], c: null } })).toBe(
      '{"a":{"c":null,"d":[3,1]},"b":1}',
    );
  });

  it('serialises equal objects identically regardless of key order', () => {
    expect(canonicalJson({ x: 1, y: { q: 2, p: 1 } })).toBe(
      canonicalJson({ y: { p: 1, q: 2 }, x: 1 }),
    );
  });
});
