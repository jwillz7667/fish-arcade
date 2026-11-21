import type { Logger } from '@reef/logger';
import { parseSdnBitcoinAddresses } from '@reef/screening';

import type { ImportResult, OfacImporter } from './ofac-importer.js';
import type { SdnDownload } from './sdn-download.js';

/** Collaborators for {@link OfacImportJob}. */
export interface OfacImportJobDeps {
  readonly download: () => Promise<SdnDownload>;
  readonly importer: Pick<OfacImporter, 'apply'>;
  readonly logger: Logger;
}

/**
 * The daily OFAC import (playbook Step 12). A failed run keeps the list in force; three days of
 * failures make screening fail closed (`OFAC_MAX_AGE_HOURS`), and every failure logs the
 * `ofac_import.failed` metric at error level for alerting.
 */
export class OfacImportJob {
  #timer: NodeJS.Timeout | undefined;
  #inFlight: Promise<unknown> = Promise.resolve();
  #isStopped = false;

  constructor(private readonly deps: OfacImportJobDeps) {}

  /**
   * Downloads, parses, and applies the list once.
   *
   * @returns What the import did.
   * @throws Error when the download, parse, or import fails.
   */
  async runOnce(): Promise<ImportResult> {
    const { xml, sha256 } = await this.deps.download();
    const list = parseSdnBitcoinAddresses(xml);
    const result = await this.deps.importer.apply(list, sha256);
    if (result.status === 'imported') {
      this.deps.logger.info(
        {
          metric: 'ofac_import.imported',
          listVersion: result.listVersion,
          addresses: result.addressCount,
          rejectedEntries: list.rejected.length,
        },
        'OFAC list imported',
      );
    } else {
      this.deps.logger.info({ listVersion: result.listVersion }, 'OFAC list unchanged');
    }
    return result;
  }

  /**
   * Runs now, then every `intervalMs` after each run ends.
   *
   * @param intervalMs Delay between runs.
   */
  start(intervalMs: number): void {
    const loop = (): void => {
      if (this.#isStopped) return;
      this.#inFlight = this.runOnce()
        .catch((error: unknown) => {
          this.deps.logger.error(
            { err: error, metric: 'ofac_import.failed' },
            'OFAC import failed',
          );
        })
        .finally(() => {
          if (!this.#isStopped) this.#timer = setTimeout(loop, intervalMs);
        });
    };
    loop();
  }

  /** Stops scheduling and waits for a run in progress. */
  async stop(): Promise<void> {
    this.#isStopped = true;
    clearTimeout(this.#timer);
    await this.#inFlight;
  }
}
