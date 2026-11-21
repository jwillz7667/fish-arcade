import { describe, expect, it } from 'vitest';

import { CLEAN_RESULT_TTL_SECONDS, ScreeningCache } from './screening-cache.js';

describe('ScreeningCache', () => {
  it('stores clean verdicts for 24 hours', async () => {
    const writes: [string, string, number][] = [];
    const cache = new ScreeningCache({
      get: () => Promise.resolve(null),
      set: (key, value, _mode, seconds) => {
        writes.push([key, value, seconds]);
        return Promise.resolve('OK');
      },
    });

    await cache.putIfClean('trm_labs', 'idx', {
      riskLevel: 'low',
      categories: ['Exchange'],
      sanctioned: false,
    });

    expect(writes).toEqual([
      [
        'screening:v1:trm_labs:idx',
        '{"riskLevel":"low","sanctioned":false,"categories":["Exchange"]}',
        CLEAN_RESULT_TTL_SECONDS,
      ],
    ]);
    expect(CLEAN_RESULT_TTL_SECONDS).toBe(86_400);
  });

  it.each([
    ['a sanctioned value', '{"riskLevel":"low","sanctioned":true,"categories":[]}'],
    ['a risky value', '{"riskLevel":"high","sanctioned":false,"categories":[]}'],
    ['a value that is not JSON', 'not json'],
  ])('never reads %s as clean, even if one was written', async (_label, raw) => {
    const cache = new ScreeningCache({
      get: () => Promise.resolve(raw),
      set: () => Promise.resolve('OK'),
    });

    expect(await cache.getClean('trm_labs', 'idx')).toBeUndefined();
  });

  it('treats a Redis failure as a miss, and a failed write as harmless', async () => {
    const cache = new ScreeningCache({
      get: () => Promise.reject(new Error('ECONNREFUSED')),
      set: () => Promise.reject(new Error('ECONNREFUSED')),
    });

    expect(await cache.getClean('trm_labs', 'idx')).toBeUndefined();
    await expect(
      cache.putIfClean('trm_labs', 'idx', { riskLevel: 'low', categories: [], sanctioned: false }),
    ).resolves.toBeUndefined();
  });
});
