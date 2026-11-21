import type { Queryable } from '../../audit/audit-writer.js';

/**
 * What a hold blocks. Matches the `AccountHoldKind` enum. `freeze` blocks everything: no
 * session can start or refresh while one is active (playbook Step 12).
 */
export type AccountHoldKind = 'redemption' | 'freeze';

/** SQL for `account_holds` and `aml_alerts`. Every value is a bound parameter. */
export const accountHoldRepository = {
  /**
   * Places a hold. Holds are released only by an admin (Step 9).
   *
   * @returns The hold's ID.
   */
  async place(
    client: Queryable,
    input: {
      userId: string;
      kind: AccountHoldKind;
      reason: string;
      sourceType: string;
      sourceId: string;
    },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO account_holds (user_id, kind, reason, source_type, source_id)
       VALUES ($1, $2::"AccountHoldKind", $3, $4, $5) RETURNING id`,
      [input.userId, input.kind, input.reason, input.sourceType, input.sourceId],
    );
    const [row] = rows;
    if (row === undefined) throw new Error('INSERT RETURNING produced no row');
    return row.id;
  },

  /** Served by the partial index on active holds. */
  async hasActive(client: Queryable, userId: string, kind: AccountHoldKind): Promise<boolean> {
    const { rows } = await client.query<{ is_held: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM account_holds
          WHERE user_id = $1 AND kind = $2::"AccountHoldKind" AND released_at IS NULL
       ) AS is_held`,
      [userId, kind],
    );
    return rows[0]?.is_held === true;
  },

  /**
   * Opens an AML alert for Compliance to work (spec §15).
   *
   * @returns The alert's ID.
   */
  async openAmlAlert(
    client: Queryable,
    input: { userId: string; rule: string; severity: 'low' | 'medium' | 'high' | 'critical' },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO aml_alerts (user_id, rule, severity) VALUES ($1, $2, $3::"AmlSeverity")
       RETURNING id`,
      [input.userId, input.rule, input.severity],
    );
    const [row] = rows;
    if (row === undefined) throw new Error('INSERT RETURNING produced no row');
    return row.id;
  },
};
