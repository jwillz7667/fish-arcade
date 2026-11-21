import { ErrorCode } from '@reef/errors';
import { describe, expect, it } from 'vitest';

import { DevStubChainRiskProvider } from './dev-stub.js';

function stub() {
  const store = new Map<string, string>();
  return new DevStubChainRiskProvider({
    get: (key) => Promise.resolve(store.get(key) ?? null),
    set: (key, value) => {
      store.set(key, value);
      return Promise.resolve('OK');
    },
  });
}

describe('DevStubChainRiskProvider', () => {
  it('reports every address clean until a verdict is scripted', async () => {
    const provider = stub();
    await provider.script('bcrt1qrisky', {
      riskLevel: 'high',
      categories: ['Scam'],
      sanctioned: false,
    });

    const verdicts = await provider.screenAddresses(['bcrt1qclean', 'bcrt1qrisky']);

    expect(Object.fromEntries(verdicts)).toEqual({
      bcrt1qclean: { riskLevel: 'low', categories: [], sanctioned: false },
      bcrt1qrisky: { riskLevel: 'high', categories: ['Scam'], sanctioned: false },
    });
  });

  it('simulates an outage', async () => {
    const provider = stub();
    await provider.script('bcrt1qdown', 'unavailable');

    await expect(provider.screenAddresses(['bcrt1qdown'])).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
  });
});
