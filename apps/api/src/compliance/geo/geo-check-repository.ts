import type { Queryable } from '../../audit/audit-writer.js';
import type { GatedContext } from '../jurisdictions/jurisdiction-policy.js';

/** One row of `geo_checks`. */
export interface GeoCheckRecord {
  readonly userId: string | null;
  readonly context: GatedContext;
  readonly ip: string;
  readonly stateCode: string | null;
  readonly vpnDetected: boolean;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly result: 'allowed' | 'blocked' | 'error';
}

/** SQL for `geo_checks`. Every value is a bound parameter. */
export const geoCheckRepository = {
  /** @returns The new row's ID, as a decimal string (it is a BIGINT). */
  async insert(client: Queryable, record: GeoCheckRecord): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO geo_checks (user_id, context, ip, lat, lng, state_code, vpn_flag, result)
       VALUES ($1, $2::"GeoContext", $3::inet, $4, $5, $6, $7, $8::"GeoResult")
       RETURNING id::text`,
      [
        record.userId,
        record.context,
        record.ip,
        record.lat,
        record.lng,
        record.stateCode,
        record.vpnDetected,
        record.result,
      ],
    );
    const [row] = rows;
    if (row === undefined) throw new Error('INSERT RETURNING produced no row');
    return row.id;
  },
};
