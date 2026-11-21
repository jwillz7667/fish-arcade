import { readFileSync } from 'node:fs';

import { createLogger, RequestContext } from '@reef/logger';
import type { SdnBitcoinAddresses } from '@reef/screening';
import { describe, expect, it, vi } from 'vitest';

import { OfacImportJob } from './ofac-import-job.js';
import type { ImportResult } from './ofac-importer.js';

const FIXTURE = readFileSync(
  new URL('../../../../packages/screening/test/fixtures/sdn-sample.xml', import.meta.url),
  'utf8',
);

function setup(result: ImportResult | Error) {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger({
    service: 'test',
    level: 'info',
    context: new RequestContext(),
    destination: {
      write: (line: string) => lines.push(JSON.parse(line) as Record<string, unknown>),
    },
  });
  const apply = vi.fn<(list: SdnBitcoinAddresses, sha256: string) => Promise<ImportResult>>(() =>
    result instanceof Error ? Promise.reject(result) : Promise.resolve(result),
  );
  const job = new OfacImportJob({
    download: () => Promise.resolve({ xml: FIXTURE, sha256: 'f'.repeat(64) }),
    importer: { apply },
    logger,
  });
  return { job, apply, lines };
}

describe('OfacImportJob', () => {
  it('parses the download and hands the addresses and fingerprint to the importer', async () => {
    const { job, apply, lines } = setup({
      status: 'imported',
      listVersion: '2026-11-20-ffff',
      addressCount: 4,
    });

    await job.runOnce();

    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        publishDate: '2026-11-20',
        addresses: expect.arrayContaining(['12QtD5BFwRsdNsAZY76UVE1xyCGNTojH9h']),
      }),
      'f'.repeat(64),
    );
    expect(lines.at(-1)).toMatchObject({
      metric: 'ofac_import.imported',
      addresses: 4,
      rejectedEntries: 1,
    });
  });

  it('logs the failure metric and keeps scheduling when a run fails', async () => {
    vi.useFakeTimers();
    try {
      const { job, apply, lines } = setup(new Error('shrank'));

      job.start(60_000);
      await vi.advanceTimersByTimeAsync(60_001);
      await job.stop();

      expect(apply).toHaveBeenCalledTimes(2);
      expect(lines.filter((line) => line['metric'] === 'ofac_import.failed')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs an unchanged list without the import metric', async () => {
    const { job, lines } = setup({ status: 'unchanged', listVersion: '2026-11-20-ffff' });

    expect(await job.runOnce()).toEqual({ status: 'unchanged', listVersion: '2026-11-20-ffff' });
    expect(lines.some((line) => line['metric'] === 'ofac_import.imported')).toBe(false);
  });
});
