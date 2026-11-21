import type { Queryable } from '../../audit/audit-writer.js';
import type { JurisdictionMode, JurisdictionRule } from './jurisdiction-policy.js';

interface RuleRow {
  state_code: string;
  mode: JurisdictionMode;
  min_age: number;
  sc_redemption_enabled: boolean;
  fish_games_enabled: boolean;
  effective_from: Date;
}

/** A rule to schedule, with the legal memo that justifies it (spec §4.1). */
export interface NewJurisdictionRule extends JurisdictionRule {
  readonly legalMemoRef: string;
}

/** SQL for `jurisdictions`. Every value is a bound parameter. */
export const jurisdictionRepository = {
  /**
   * The row in force for a state at `at`, and when the next scheduled row takes over. Both are
   * served by the (state_code, effective_from) primary key.
   */
  async ruleAt(
    client: Queryable,
    stateCode: string,
    at: Date,
  ): Promise<{ rule: JurisdictionRule | undefined; nextChangeAt: Date | undefined }> {
    const { rows } = await client.query<RuleRow & { next_change_at: Date | null }>(
      `SELECT j.state_code, j.mode, j.min_age, j.sc_redemption_enabled, j.fish_games_enabled,
              j.effective_from,
              (SELECT min(n.effective_from) FROM jurisdictions n
                WHERE n.state_code = $1 AND n.effective_from > $2) AS next_change_at
         FROM (SELECT 1) AS one
         LEFT JOIN LATERAL (
           SELECT * FROM jurisdictions
            WHERE state_code = $1 AND effective_from <= $2
            ORDER BY effective_from DESC LIMIT 1
         ) AS j ON true`,
      [stateCode, at],
    );
    const [row] = rows;
    const nextChangeAt = row?.next_change_at ?? undefined;
    if (row?.state_code == null) return { rule: undefined, nextChangeAt };
    return {
      rule: {
        stateCode: row.state_code,
        mode: row.mode,
        minAge: row.min_age,
        scRedemptionEnabled: row.sc_redemption_enabled,
        fishGamesEnabled: row.fish_games_enabled,
        effectiveFrom: row.effective_from,
      },
      nextChangeAt,
    };
  },

  /** Every state's rule in force at `at`, one row per state. */
  async listAt(client: Queryable, at: Date): Promise<JurisdictionRule[]> {
    const { rows } = await client.query<RuleRow>(
      `SELECT DISTINCT ON (state_code) state_code, mode, min_age, sc_redemption_enabled,
              fish_games_enabled, effective_from
         FROM jurisdictions WHERE effective_from <= $1
        ORDER BY state_code, effective_from DESC`,
      [at],
    );
    return rows.map((row) => ({
      stateCode: row.state_code,
      mode: row.mode,
      minAge: row.min_age,
      scRedemptionEnabled: row.sc_redemption_enabled,
      fishGamesEnabled: row.fish_games_enabled,
      effectiveFrom: row.effective_from,
    }));
  },

  async insert(client: Queryable, rule: NewJurisdictionRule): Promise<void> {
    await client.query(
      `INSERT INTO jurisdictions
         (state_code, effective_from, mode, min_age, sc_redemption_enabled, fish_games_enabled,
          legal_memo_ref)
       VALUES ($1, $2, $3::"JurisdictionMode", $4, $5, $6, $7)`,
      [
        rule.stateCode,
        rule.effectiveFrom,
        rule.mode,
        rule.minAge,
        rule.scRedemptionEnabled,
        rule.fishGamesEnabled,
        rule.legalMemoRef,
      ],
    );
  },
};
