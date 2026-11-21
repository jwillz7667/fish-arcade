import { DependencyUnavailableError } from '@reef/errors';

import type { Queryable } from '../queryable.js';

/** Collaborators for {@link OfacList}. */
export interface OfacListDeps {
  readonly db: Queryable;
  readonly now: () => Date;
  /** A list not confirmed current within this long counts as unavailable. */
  readonly maxAgeMs: number;
}

interface CurrentListRow {
  readonly list_version: string;
  readonly checked_at: Date;
  readonly address: string | null;
}

function unavailable(message: string): DependencyUnavailableError {
  return new DependencyUnavailableError({ dependency: 'ofac_sdn', message });
}

/**
 * The local copy of OFAC's sanctioned Bitcoin addresses (playbook Step 12), imported daily by
 * apps/workers into `ofac_imports` and `ofac_addresses`. Only the latest import counts, so an
 * address OFAC delists stops matching after the next import.
 */
export class OfacList {
  constructor(private readonly deps: OfacListDeps) {}

  /**
   * @param addresses Canonical mainnet addresses.
   * @returns The ones on the current list.
   * @throws DependencyUnavailableError when nothing has been imported, the list has not been
   *   confirmed current within the maximum age, or the database fails.
   */
  async listed(addresses: readonly string[]): Promise<ReadonlySet<string>> {
    let rows: CurrentListRow[];
    try {
      // The left join keeps the import row when no address matches.
      ({ rows } = await this.deps.db.query<CurrentListRow>(
        `WITH current AS (
           SELECT list_version, checked_at FROM ofac_imports ORDER BY imported_at DESC LIMIT 1
         )
         SELECT c.list_version, c.checked_at, a.address
           FROM current c
           LEFT JOIN ofac_addresses a
             ON a.list_version = c.list_version AND a.address = ANY($1::text[])`,
        [addresses],
      ));
    } catch (error) {
      throw new DependencyUnavailableError({
        dependency: 'ofac_sdn',
        message: 'OFAC list could not be read',
        cause: error,
      });
    }
    const [first] = rows;
    if (first === undefined) throw unavailable('No OFAC list has been imported');
    if (this.deps.now().getTime() - first.checked_at.getTime() > this.deps.maxAgeMs) {
      throw unavailable(`OFAC list ${first.list_version} has not been confirmed current`);
    }
    return new Set(rows.flatMap((row) => (row.address === null ? [] : [row.address])));
  }
}
