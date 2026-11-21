import type { Queryable } from './queryable.js';
import type { ScreeningVerdict } from './verdict.js';

/** One row for `chain_screenings`. */
export interface ScreeningRecord {
  readonly subjectType: 'address' | 'tx';
  /** The address's blind index, never the address; or a txid. */
  readonly subject: string;
  readonly verdict: ScreeningVerdict;
}

/** Writes screening history to `chain_screenings` (spec §22.5). */
export class ScreeningRecorder {
  constructor(private readonly db: Queryable) {}

  /**
   * @param records Rows to insert in one statement.
   * @throws Error when Postgres rejects the insert.
   */
  async record(records: readonly ScreeningRecord[]): Promise<void> {
    if (records.length === 0) return;
    await this.db.query(
      `INSERT INTO chain_screenings (subject_type, subject, provider, risk_level, categories, sanctioned)
       SELECT r.subject_type::"ScreeningSubjectType", r.subject, r.provider, r.risk_level::"RiskLevel",
              ARRAY(SELECT jsonb_array_elements_text(r.categories)), r.sanctioned
         FROM unnest($1::text[], $2::text[], $3::text[], $4::text[], $5::jsonb[], $6::boolean[])
           AS r(subject_type, subject, provider, risk_level, categories, sanctioned)`,
      [
        records.map((record) => record.subjectType),
        records.map((record) => record.subject),
        records.map((record) => record.verdict.provider),
        records.map((record) => record.verdict.riskLevel),
        records.map((record) => JSON.stringify(record.verdict.categories)),
        records.map((record) => record.verdict.sanctioned),
      ],
    );
  }
}
