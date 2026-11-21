import type { Queryable } from '../../audit/audit-writer.js';
import type { KycLevel, KycStatus } from './kyc-status.js';

/** A `kyc_checks` row, locked for a status change. */
export interface KycCheckRecord {
  readonly id: string;
  readonly userId: string;
  readonly level: KycLevel;
  readonly status: KycStatus;
}

/** SQL for `kyc_checks` and `processed_webhooks`. Every value is a bound parameter. */
export const kycRepository = {
  /** @returns The new check's ID. */
  async insertCheck(
    client: Queryable,
    input: { userId: string; level: KycLevel; vendor: string; vendorRef: string },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO kyc_checks (user_id, level, vendor, vendor_ref)
       VALUES ($1, $2::"KycLevel", $3, $4) RETURNING id`,
      [input.userId, input.level, input.vendor, input.vendorRef],
    );
    const [row] = rows;
    if (row === undefined) throw new Error('INSERT RETURNING produced no row');
    return row.id;
  },

  async lockByVendorRef(
    client: Queryable,
    vendor: string,
    vendorRef: string,
  ): Promise<KycCheckRecord | undefined> {
    const { rows } = await client.query<{
      id: string;
      user_id: string;
      level: KycLevel;
      status: KycStatus;
    }>(
      `SELECT id, user_id, level, status FROM kyc_checks
        WHERE vendor = $1 AND vendor_ref = $2 FOR UPDATE`,
      [vendor, vendorRef],
    );
    const [row] = rows;
    return row === undefined
      ? undefined
      : { id: row.id, userId: row.user_id, level: row.level, status: row.status };
  },

  async updateStatus(
    client: Queryable,
    input: { id: string; status: KycStatus; reasons: readonly string[] },
  ): Promise<void> {
    await client.query(
      `UPDATE kyc_checks SET status = $2::"KycStatus", reasons = $3, updated_at = now() WHERE id = $1`,
      [input.id, input.status, input.reasons],
    );
  },

  /**
   * Whether the user has a passed check at one of `levels` and no sanctions hit on any check.
   * Served by the (user_id, created_at) index.
   */
  async isVerified(
    client: Queryable,
    userId: string,
    levels: readonly KycLevel[],
  ): Promise<boolean> {
    const { rows } = await client.query<{ is_verified: boolean }>(
      `SELECT bool_or(status = 'passed' AND level = ANY($2::"KycLevel"[]))
              AND NOT bool_or(status = 'sanctions_hit') AS is_verified
         FROM kyc_checks WHERE user_id = $1`,
      [userId, levels],
    );
    return rows[0]?.is_verified === true;
  },

  /**
   * Records a webhook event as processed, in the caller's transaction.
   *
   * @returns False when the event was processed before (a vendor retry or a replay).
   */
  async claimWebhookEvent(client: Queryable, provider: string, eventId: string): Promise<boolean> {
    const result = await client.query(
      `INSERT INTO processed_webhooks (provider, event_id) VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [provider, eventId],
    );
    return result.rowCount === 1;
  },
};
