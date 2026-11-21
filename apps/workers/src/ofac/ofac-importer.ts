import type { SdnBitcoinAddresses } from '@reef/screening';
import type { Pool, PoolClient } from 'pg';

/** What an import did. */
export type ImportResult =
  | { readonly status: 'imported'; readonly listVersion: string; readonly addressCount: number }
  | { readonly status: 'unchanged'; readonly listVersion: string };

/** Thrown when a downloaded list looks wrong enough that importing it could unblock addresses. */
export class SuspiciousListError extends Error {
  override readonly name = 'SuspiciousListError';
}

// A real delisting removes a few addresses. Losing half means a parsing or publishing fault,
// and importing it would quietly stop blocking sanctioned addresses.
const MIN_KEPT_FRACTION_PERCENT = 50;

interface CurrentImport {
  readonly list_version: string;
  readonly sha256: string;
  readonly address_count: number;
}

async function inTransaction<T>(pool: Pool, work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Writes OFAC lists into `ofac_imports` and `ofac_addresses` (playbook Step 12). Each distinct
 * publication becomes a new version; the newest is the list in force. An unchanged list only
 * moves `checked_at`, which is what keeps screening from failing closed.
 */
export class OfacImporter {
  constructor(private readonly pool: Pool) {}

  /**
   * @param list Parsed addresses.
   * @param sha256 Fingerprint of the downloaded file.
   * @param options `acceptShrink` imports a list that lost over half its addresses, after a
   *   person has confirmed the delisting on OFAC's site (`pnpm ofac:import --accept-shrink`).
   * @returns Whether a new version was imported.
   * @throws SuspiciousListError when the list is empty, much shorter than the current one
   *   without `acceptShrink`, or an older publication than the one in force.
   */
  async apply(
    list: SdnBitcoinAddresses,
    sha256: string,
    options: { acceptShrink?: boolean } = {},
  ): Promise<ImportResult> {
    return inTransaction(this.pool, async (client) => {
      // One import at a time, even with several worker instances.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended('ofac_import', 0))");
      const { rows } = await client.query<CurrentImport>(
        'SELECT list_version, sha256, address_count FROM ofac_imports ORDER BY imported_at DESC LIMIT 1',
      );
      const [current] = rows;
      if (current?.sha256 === sha256) {
        await client.query('UPDATE ofac_imports SET checked_at = now() WHERE list_version = $1', [
          current.list_version,
        ]);
        return { status: 'unchanged', listVersion: current.list_version };
      }
      const seen = await client.query('SELECT 1 FROM ofac_imports WHERE sha256 = $1', [sha256]);
      if ((seen.rowCount ?? 0) > 0) {
        throw new SuspiciousListError('OFAC is serving a publication older than the one in force');
      }
      if (list.addresses.length === 0)
        throw new SuspiciousListError('OFAC list has no Bitcoin addresses');
      if (
        options.acceptShrink !== true &&
        current !== undefined &&
        list.addresses.length * 100 < current.address_count * MIN_KEPT_FRACTION_PERCENT
      ) {
        throw new SuspiciousListError(
          `OFAC list shrank from ${String(current.address_count)} to ${String(list.addresses.length)} addresses`,
        );
      }
      const listVersion = `${list.publishDate}-${sha256.slice(0, 12)}`;
      await client.query(
        `INSERT INTO ofac_imports (list_version, publish_date, sha256, address_count)
         VALUES ($1, $2::date, $3, $4)`,
        [listVersion, list.publishDate, sha256, list.addresses.length],
      );
      await client.query(
        `INSERT INTO ofac_addresses (address, list_version)
         SELECT address, $2 FROM unnest($1::text[]) AS a(address)`,
        [list.addresses, listVersion],
      );
      return { status: 'imported', listVersion, addressCount: list.addresses.length };
    });
  }
}
