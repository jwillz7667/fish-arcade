import { readFileSync } from 'node:fs';

import { BlindIndexer } from '@reef/crypto-fields';
import {
  ChainScreener,
  DevStubChainRiskProvider,
  OfacList,
  parseSdnBitcoinAddresses,
  ScreeningCache,
  ScreeningRecorder,
} from '@reef/screening';
import { Redis } from 'ioredis';
import pg from 'pg';
import { afterAll, beforeEach, describe, expect, inject, it } from 'vitest';

import { OfacImporter, SuspiciousListError } from '../src/ofac/index.js';

const FIXTURE = readFileSync(
  new URL('../../../packages/screening/test/fixtures/sdn-sample.xml', import.meta.url),
  'utf8',
);
const SANCTIONED = '12QtD5BFwRsdNsAZY76UVE1xyCGNTojH9h';
const CLEAN = 'bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq';
const HOUR = 3_600_000;

const pool = new pg.Pool({ connectionString: inject('workersDatabaseUrls').reef_app, max: 4 });
const admin = new pg.Pool({
  connectionString: inject('workersDatabaseUrls').reef_migrator,
  max: 1,
});
const redis = new Redis(inject('workersRedisUrl'));
const importer = new OfacImporter(pool);
const fixture = parseSdnBitcoinAddresses(FIXTURE);
const sha = (seed: string) => seed.repeat(64).slice(0, 64);

afterAll(async () => {
  await Promise.all([pool.end(), admin.end(), redis.quit()]);
});

beforeEach(async () => {
  // Each test starts with no list; only the migrator may clear these append-only tables.
  await admin.query('TRUNCATE ofac_addresses, ofac_imports, chain_screenings');
});

const list = (at = new Date()) => new OfacList({ db: pool, now: () => at, maxAgeMs: 72 * HOUR });

describe('OFAC import (playbook Step 12)', () => {
  it('imports a list that OfacList then matches', async () => {
    const result = await importer.apply(fixture, sha('a'));

    expect(result).toEqual({
      status: 'imported',
      listVersion: `2026-11-20-${'a'.repeat(12)}`,
      addressCount: 4,
    });
    expect(await list().listed([SANCTIONED, CLEAN])).toEqual(new Set([SANCTIONED]));
  });

  it('only moves checked_at when the same file arrives again', async () => {
    await importer.apply(fixture, sha('a'));
    await admin.query("UPDATE ofac_imports SET checked_at = now() - interval '80 hours'");
    await expect(list().listed([CLEAN])).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE' });

    expect(await importer.apply(fixture, sha('a'))).toMatchObject({ status: 'unchanged' });
    await expect(list().listed([CLEAN])).resolves.toEqual(new Set());
    const { rows } = await pool.query<{ count: string }>('SELECT count(*) FROM ofac_imports');
    expect(rows[0]?.count).toBe('1');
  });

  it('stops matching an address once a newer list drops it', async () => {
    await importer.apply(fixture, sha('a'));
    const delisted = {
      ...fixture,
      publishDate: '2026-11-27',
      addresses: fixture.addresses.filter((a) => a !== SANCTIONED),
    };

    await importer.apply(delisted, sha('b'));

    expect(await list().listed([SANCTIONED])).toEqual(new Set());
  });

  it.each([
    ['an empty list', { ...fixture, addresses: [] }],
    [
      'a list that lost over half its addresses',
      { ...fixture, addresses: fixture.addresses.slice(0, 1) },
    ],
  ])('refuses %s and keeps the list in force', async (_label, next) => {
    await importer.apply(fixture, sha('a'));

    await expect(importer.apply(next, sha('c'))).rejects.toBeInstanceOf(SuspiciousListError);
    expect(await list().listed([SANCTIONED])).toEqual(new Set([SANCTIONED]));
  });

  it('imports a shrunken list once a person accepts it', async () => {
    await importer.apply(fixture, sha('a'));

    const result = await importer.apply({ ...fixture, addresses: [CLEAN] }, sha('c'), {
      acceptShrink: true,
    });

    expect(result).toMatchObject({ status: 'imported', addressCount: 1 });
  });

  it('refuses an older publication than the one in force', async () => {
    await importer.apply(fixture, sha('a'));
    await importer.apply({ ...fixture, publishDate: '2026-11-27' }, sha('b'));

    await expect(importer.apply(fixture, sha('a'))).rejects.toBeInstanceOf(SuspiciousListError);
  });

  it('imports once when two workers run at the same time', async () => {
    const results = await Promise.all([
      importer.apply(fixture, sha('a')),
      importer.apply(fixture, sha('a')),
    ]);

    expect(results.map((result) => result.status).sort()).toEqual(['imported', 'unchanged']);
  });

  it('keeps lists and screenings append-only for the app role', async () => {
    await importer.apply(fixture, sha('a'));

    await expect(pool.query('DELETE FROM ofac_addresses')).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('UPDATE ofac_imports SET sha256 = sha256')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('ChainScreener against the imported list', () => {
  it('flags a sanctioned address from OFAC alone and records it by blind index', async () => {
    await importer.apply(fixture, sha('a'));
    const indexer = new BlindIndexer(Buffer.alloc(32, 7));
    const screener = new ChainScreener({
      provider: new DevStubChainRiskProvider(redis),
      ofac: list(),
      cache: new ScreeningCache(redis),
      recorder: new ScreeningRecorder(pool),
      indexAddress: (address) => indexer.index(address, 'btc_address'),
    });

    const [hit, clean] = [
      await screener.screenAddress(SANCTIONED),
      await screener.screenAddress(CLEAN),
    ];

    expect(hit).toMatchObject({
      status: 'screened',
      verdict: { sanctioned: true, provider: 'ofac_sdn' },
    });
    expect(clean).toMatchObject({
      status: 'screened',
      verdict: { riskLevel: 'low', provider: 'dev_stub' },
    });
    const { rows } = await pool.query<{ subject: string; provider: string; sanctioned: boolean }>(
      'SELECT subject, provider, sanctioned FROM chain_screenings ORDER BY screened_at',
    );
    expect(rows).toEqual([
      { subject: indexer.index(SANCTIONED, 'btc_address'), provider: 'ofac_sdn', sanctioned: true },
      { subject: indexer.index(CLEAN, 'btc_address'), provider: 'dev_stub', sanctioned: false },
    ]);
    expect(rows.some((row) => row.subject.includes(SANCTIONED))).toBe(false);
  });
});
