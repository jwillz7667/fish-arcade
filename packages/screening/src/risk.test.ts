import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { highestRisk, isAtLeast, RISK_LEVELS } from './risk.js';

describe('risk levels', () => {
  it('orders low < medium < high < severe', () => {
    expect(isAtLeast('severe', 'high')).toBe(true);
    expect(isAtLeast('medium', 'medium')).toBe(true);
    expect(isAtLeast('low', 'medium')).toBe(false);
  });

  it('takes the riskiest level, low when there is none', () => {
    expect(highestRisk([])).toBe('low');
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...RISK_LEVELS), { minLength: 1 }), (levels) => {
        const highest = highestRisk(levels);
        expect(levels).toContain(highest);
        expect(levels.every((level) => isAtLeast(highest, level))).toBe(true);
      }),
    );
  });
});
