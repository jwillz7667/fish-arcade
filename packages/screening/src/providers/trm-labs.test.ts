import { ErrorCode } from '@reef/errors';
import { describe, expect, it, vi } from 'vitest';

import { TrmLabsProvider } from './trm-labs.js';

const ADDRESS = 'bc1qw4cxpe6sxa5dg6sdwxjph959cw6yztrzl4r54s';
const OTHER = '1Kuf2Rd8mDyAViwBozGTNYnvWL8uYFrkVo';

const reply = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(() => Promise.resolve(new Response(JSON.stringify(body), { status })));

const entry = (address: string, extra: Record<string, unknown> = {}) => ({
  address,
  chain: 'bitcoin',
  addressRiskIndicators: [],
  entities: [],
  ...extra,
});

const provider = (fetchFn: typeof fetch) =>
  new TrmLabsProvider({
    apiKey: 'trm-test-key',
    baseUrl: 'https://api.trmlabs.test',
    timeoutMs: 5000,
    fetchFn,
  });

describe('TrmLabsProvider', () => {
  it('posts every address as a bitcoin screening with the key as Basic credentials', async () => {
    const fetchFn = reply([entry(ADDRESS), entry(OTHER)]);

    await provider(fetchFn).screenAddresses([ADDRESS, OTHER]);

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(url instanceof URL ? url.href : undefined).toBe(
      'https://api.trmlabs.test/public/v2/screening/addresses',
    );
    expect(init?.method).toBe('POST');
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('trm-test-key:trm-test-key').toString('base64')}`,
    );
    expect(JSON.parse(typeof init?.body === 'string' ? init.body : '')).toEqual([
      { address: ADDRESS, chain: 'bitcoin' },
      { address: OTHER, chain: 'bitcoin' },
    ]);
  });

  it('scores an address by its riskiest indicator or entity', async () => {
    const fetchFn = reply([
      entry(ADDRESS, {
        addressRiskIndicators: [
          {
            category: 'Gambling',
            categoryRiskScoreLevelLabel: 'Medium',
            riskType: 'COUNTERPARTY',
            totalVolumeUsd: '120.5',
          },
          { category: 'Scam', categoryRiskScoreLevelLabel: 'High', riskType: 'COUNTERPARTY' },
        ],
        entities: [{ category: 'Exchange', riskScoreLevelLabel: 'Low', entity: 'Some Exchange' }],
      }),
      entry(OTHER),
    ]);

    const verdicts = await provider(fetchFn).screenAddresses([ADDRESS, OTHER]);

    expect(verdicts.get(ADDRESS)).toEqual({
      riskLevel: 'high',
      categories: ['Exchange', 'Gambling', 'Scam'],
      sanctioned: false,
    });
    expect(verdicts.get(OTHER)).toEqual({ riskLevel: 'low', categories: [], sanctioned: false });
  });

  it.each([
    [
      'owns the address',
      {
        addressRiskIndicators: [
          { category: 'Sanctions', categoryRiskScoreLevelLabel: 'Severe', riskType: 'OWNERSHIP' },
        ],
      },
    ],
    [
      'is the entity behind it',
      { entities: [{ category: 'Sanctions', riskScoreLevelLabel: 'Severe' }] },
    ],
  ])('calls an address sanctioned when a sanctioned party %s', async (_label, extra) => {
    const verdicts = await provider(reply([entry(ADDRESS, extra)])).screenAddresses([ADDRESS]);

    expect(verdicts.get(ADDRESS)).toMatchObject({ sanctioned: true, riskLevel: 'severe' });
  });

  it('scores sanctions exposure by its level without calling the address sanctioned', async () => {
    const fetchFn = reply([
      entry(ADDRESS, {
        addressRiskIndicators: [
          {
            category: 'Sanctions',
            categoryRiskScoreLevelLabel: 'Severe',
            riskType: 'COUNTERPARTY',
          },
        ],
      }),
    ]);

    expect((await provider(fetchFn).screenAddresses([ADDRESS])).get(ADDRESS)).toMatchObject({
      sanctioned: false,
      riskLevel: 'severe',
    });
  });

  it('matches a bech32 address echoed in another case', async () => {
    const verdicts = await provider(reply([entry(ADDRESS.toUpperCase())])).screenAddresses([
      ADDRESS,
    ]);

    expect(verdicts.has(ADDRESS)).toBe(true);
  });

  it.each([
    ['an error status', reply({ message: 'unauthorized' }, 401)],
    ['an unrecognised body', reply({ results: [] })],
    [
      'an unknown risk label',
      reply([
        entry(ADDRESS, { entities: [{ category: 'Mixer', riskScoreLevelLabel: 'Critical' }] }),
      ]),
    ],
    ['an answer that skips the address', reply([entry(OTHER)])],
    ['a network failure', vi.fn<typeof fetch>(() => Promise.reject(new Error('ECONNRESET')))],
  ])('fails closed on %s', async (_label, fetchFn) => {
    await expect(provider(fetchFn).screenAddresses([ADDRESS])).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
  });

  it('refuses a batch larger than one call allows', async () => {
    const addresses = Array.from({ length: 21 }, () => ADDRESS);

    await expect(provider(reply([])).screenAddresses(addresses)).rejects.toMatchObject({
      code: ErrorCode.DEPENDENCY_UNAVAILABLE,
    });
  });
});
