import { DependencyUnavailableError, ErrorCode } from '@reef/errors';
import { describe, expect, it, vi } from 'vitest';

import type { ChainRiskProvider, ProviderVerdict } from './chain-risk-provider.js';
import { ChainScreener } from './chain-screener.js';
import { ScreeningCache } from './screening-cache.js';
import type { ScreeningRecord } from './screening-recorder.js';

const OFAC_VERDICT = {
  riskLevel: 'severe',
  categories: ['OFAC SDN'],
  sanctioned: true,
  provider: 'ofac_sdn',
};
const CLEAN: ProviderVerdict = { riskLevel: 'low', categories: [], sanctioned: false };
const down = (dependency: string) =>
  new DependencyUnavailableError({ dependency, message: `${dependency} down` });

function setup(
  options: {
    listed?: string[];
    ofacDown?: boolean;
    verdicts?: Record<string, ProviderVerdict>;
  } = {},
) {
  const store = new Map<string, string>();
  const records: ScreeningRecord[] = [];
  const screenAddresses = vi.fn<ChainRiskProvider['screenAddresses']>((addresses) =>
    Promise.resolve(
      new Map(addresses.map((address) => [address, options.verdicts?.[address] ?? CLEAN])),
    ),
  );
  const listed = vi.fn((addresses: readonly string[]) =>
    options.ofacDown === true
      ? Promise.reject(down('ofac_sdn'))
      : Promise.resolve(new Set(addresses.filter((address) => options.listed?.includes(address)))),
  );
  const screener = new ChainScreener({
    provider: { name: 'trm_labs', screenAddresses },
    ofac: { listed },
    cache: new ScreeningCache({
      get: (key) => Promise.resolve(store.get(key) ?? null),
      set: (key, value) => {
        store.set(key, value);
        return Promise.resolve('OK');
      },
    }),
    recorder: {
      record: (rows) => {
        records.push(...rows);
        return Promise.resolve();
      },
    },
    indexAddress: (address) => `bidx(${address})`,
  });
  return { screener, screenAddresses, listed, records, store };
}

describe('ChainScreener', () => {
  it('stops at an OFAC hit without asking the vendor, and records it', async () => {
    const { screener, screenAddresses, records } = setup({ listed: ['bc1sanctioned'] });

    const outcome = await screener.screenAddress('bc1sanctioned');

    expect(outcome).toEqual({ status: 'screened', verdict: OFAC_VERDICT });
    expect(screenAddresses).not.toHaveBeenCalled();
    expect(records).toEqual([
      { subjectType: 'address', subject: 'bidx(bc1sanctioned)', verdict: OFAC_VERDICT },
    ]);
  });

  it('reuses a clean verdict for 24 hours, but still checks OFAC every time', async () => {
    const { screener, screenAddresses, listed, store } = setup();

    await screener.screenAddress('bc1clean');
    const second = await screener.screenAddress('bc1clean');

    expect(second).toMatchObject({ status: 'screened', verdict: { riskLevel: 'low' } });
    expect(screenAddresses).toHaveBeenCalledTimes(1);
    expect(listed).toHaveBeenCalledTimes(2);
    expect([...store.keys()]).toEqual(['screening:v1:trm_labs:bidx(bc1clean)']);
  });

  it('never caches a risky or sanctioned verdict', async () => {
    const { screener, screenAddresses, store } = setup({
      verdicts: {
        bc1risky: { riskLevel: 'high', categories: ['Scam'], sanctioned: false },
        bc1vendorhit: { riskLevel: 'severe', categories: ['Sanctions'], sanctioned: true },
      },
    });

    await screener.screenAddress('bc1risky');
    await screener.screenAddress('bc1risky');
    await screener.screenAddress('bc1vendorhit');

    expect(screenAddresses).toHaveBeenCalledTimes(3);
    expect(store.size).toBe(0);
  });

  it('is unavailable when the vendor is down, noting that OFAC was clean', async () => {
    const { screener, screenAddresses } = setup();
    screenAddresses.mockRejectedValue(down('trm_labs'));

    expect(await screener.screenAddress('bc1x')).toEqual({
      status: 'unavailable',
      reason: 'trm_labs down',
      sanctionsChecked: true,
    });
  });

  it('is unavailable when OFAC is down, though the vendor checked sanctions', async () => {
    const { screener } = setup({ ofacDown: true });

    expect(await screener.screenAddress('bc1x')).toEqual({
      status: 'unavailable',
      reason: 'ofac_sdn down',
      sanctionsChecked: true,
    });
  });

  it('reports no sanctions check when both are down', async () => {
    const { screener, screenAddresses } = setup({ ofacDown: true });
    screenAddresses.mockRejectedValue(down('trm_labs'));

    expect(await screener.screenAddress('bc1x')).toMatchObject({
      status: 'unavailable',
      sanctionsChecked: false,
    });
  });

  it('acts on a vendor sanctions hit even while OFAC is down', async () => {
    const { screener } = setup({
      ofacDown: true,
      verdicts: { bc1hit: { riskLevel: 'severe', categories: ['Sanctions'], sanctioned: true } },
    });

    expect(await screener.screenAddress('bc1hit')).toMatchObject({
      status: 'screened',
      verdict: { sanctioned: true, provider: 'trm_labs' },
    });
  });

  it('screens a deposit by all its sources, in vendor-sized batches, and records the tx', async () => {
    const sources = Array.from({ length: 45 }, (_, index) => `bc1source${String(index)}`);
    const { screener, screenAddresses, records } = setup({
      verdicts: { bc1source30: { riskLevel: 'high', categories: ['Gambling'], sanctioned: false } },
    });

    const outcome = await screener.screenDepositSources({
      txid: 'ab'.repeat(32),
      sourceAddresses: [...sources, sources[0] ?? ''],
    });

    expect(outcome).toEqual({
      status: 'screened',
      verdict: {
        riskLevel: 'high',
        categories: ['Gambling'],
        sanctioned: false,
        provider: 'trm_labs',
      },
    });
    expect(screenAddresses.mock.calls.map(([batch]) => batch.length)).toEqual([20, 20, 5]);
    expect(records.filter((record) => record.subjectType === 'address')).toHaveLength(45);
    expect(records.at(-1)).toMatchObject({ subjectType: 'tx', subject: 'ab'.repeat(32) });
  });

  it('records and acts on what the vendor answered before it failed', async () => {
    const sources = Array.from({ length: 25 }, (_, index) => `bc1s${String(index)}`);
    const { screener, screenAddresses, records } = setup();
    screenAddresses
      .mockResolvedValueOnce(new Map(sources.slice(0, 20).map((address) => [address, CLEAN])))
      .mockRejectedValueOnce(down('trm_labs'));

    const outcome = await screener.screenDepositSources({
      txid: 'cd'.repeat(32),
      sourceAddresses: sources,
    });

    expect(outcome).toMatchObject({ status: 'unavailable', sanctionsChecked: true });
    expect(records).toHaveLength(20);
  });

  it('treats a vendor answer that skips an address as unavailable', async () => {
    const { screener, screenAddresses } = setup();
    screenAddresses.mockResolvedValue(new Map());

    expect(await screener.screenAddress('bc1x')).toMatchObject({ status: 'unavailable' });
  });

  it('refuses an empty or oversized address set', async () => {
    const { screener } = setup();

    await expect(
      screener.screenDepositSources({ txid: 'ef'.repeat(32), sourceAddresses: [] }),
    ).rejects.toMatchObject({
      code: ErrorCode.VALIDATION_FAILED,
    });
    await expect(
      screener.screenDepositSources({
        txid: 'ef'.repeat(32),
        sourceAddresses: Array.from({ length: 251 }, (_, index) => `bc1${String(index)}`),
      }),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_FAILED });
  });

  it('lets unexpected errors through instead of calling them an outage', async () => {
    const { screener, screenAddresses } = setup();
    screenAddresses.mockRejectedValue(new TypeError('bug'));

    await expect(screener.screenAddress('bc1x')).rejects.toThrow(TypeError);
  });
});
