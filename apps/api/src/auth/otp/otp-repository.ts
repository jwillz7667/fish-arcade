import type { Queryable } from '../../audit/audit-writer.js';
import type { OtpPurpose } from '../messaging/message-sender.js';
import type { ContactChannel } from '../users/contact.js';

/** A stored challenge, without its code hash. */
export interface OtpChallengeRecord {
  readonly id: string;
  readonly purpose: OtpPurpose;
  readonly channel: ContactChannel;
  readonly destinationEnc: string;
  readonly destinationBidx: string;
  readonly userId: string | null;
  readonly hasCode: boolean;
  readonly attempts: number;
  readonly sendCount: number;
  readonly lastSentAt: Date;
  readonly expiresAt: Date;
  readonly verifiedAt: Date | null;
}

interface ChallengeRow {
  id: string;
  purpose: OtpPurpose;
  channel: ContactChannel;
  destination_enc: string;
  destination_bidx: string;
  user_id: string | null;
  code_hash: string | null;
  attempts: number;
  send_count: number;
  last_sent_at: Date;
  expires_at: Date;
  verified_at: Date | null;
}

const COLUMNS = `id, purpose, channel, destination_enc, destination_bidx, user_id, code_hash,
  attempts, send_count, last_sent_at, expires_at, verified_at`;

const toRecord = (row: ChallengeRow): OtpChallengeRecord => ({
  id: row.id,
  purpose: row.purpose,
  channel: row.channel,
  destinationEnc: row.destination_enc,
  destinationBidx: row.destination_bidx,
  userId: row.user_id,
  hasCode: row.code_hash !== null,
  attempts: row.attempts,
  sendCount: row.send_count,
  lastSentAt: row.last_sent_at,
  expiresAt: row.expires_at,
  verifiedAt: row.verified_at,
});

/** SQL for `otp_challenges`. Every value is a bound parameter. */
export const otpRepository = {
  async insert(
    client: Queryable,
    input: {
      id: string;
      purpose: OtpPurpose;
      channel: ContactChannel;
      destinationEnc: string;
      destinationBidx: string;
      userId: string | null;
      codeHash: string | null;
      now: Date;
      expiresAt: Date;
    },
  ): Promise<void> {
    await client.query(
      `INSERT INTO otp_challenges
         (id, purpose, channel, destination_enc, destination_bidx, user_id, code_hash,
          last_sent_at, expires_at)
       VALUES ($1, $2::"OtpPurpose", $3::"OtpChannel", $4, $5, $6, $7, $8, $9)`,
      [
        input.id,
        input.purpose,
        input.channel,
        input.destinationEnc,
        input.destinationBidx,
        input.userId,
        input.codeHash,
        input.now,
        input.expiresAt,
      ],
    );
  },

  async lock(
    client: Queryable,
    id: string,
    purpose: OtpPurpose,
  ): Promise<OtpChallengeRecord | undefined> {
    const { rows } = await client.query<ChallengeRow>(
      `SELECT ${COLUMNS} FROM otp_challenges WHERE id = $1 AND purpose = $2::"OtpPurpose" FOR UPDATE`,
      [id, purpose],
    );
    const [row] = rows;
    return row === undefined ? undefined : toRecord(row);
  },

  async find(
    client: Queryable,
    id: string,
    purpose: OtpPurpose,
  ): Promise<OtpChallengeRecord | undefined> {
    const { rows } = await client.query<ChallengeRow>(
      `SELECT ${COLUMNS} FROM otp_challenges WHERE id = $1 AND purpose = $2::"OtpPurpose"`,
      [id, purpose],
    );
    const [row] = rows;
    return row === undefined ? undefined : toRecord(row);
  },

  async recordResend(
    client: Queryable,
    input: { id: string; codeHash: string | null; now: Date; expiresAt: Date },
  ): Promise<void> {
    await client.query(
      `UPDATE otp_challenges
          SET code_hash = $2, send_count = send_count + 1, last_sent_at = $3, expires_at = $4
        WHERE id = $1`,
      [input.id, input.codeHash, input.now, input.expiresAt],
    );
  },

  /**
   * Spends one attempt, atomically and before the code is compared, so concurrent guesses
   * can never exceed the limit.
   *
   * @returns The stored code hash (null when no code was sent), or undefined when the
   *   challenge cannot take another attempt.
   */
  async spendAttempt(
    client: Queryable,
    input: { id: string; purpose: OtpPurpose; now: Date; maxAttempts: number },
  ): Promise<{ codeHash: string | null } | undefined> {
    const { rows } = await client.query<{ code_hash: string | null }>(
      `UPDATE otp_challenges SET attempts = attempts + 1
        WHERE id = $1 AND purpose = $2::"OtpPurpose" AND verified_at IS NULL
          AND attempts < $4 AND expires_at > $3
        RETURNING code_hash`,
      [input.id, input.purpose, input.now, input.maxAttempts],
    );
    const [row] = rows;
    return row === undefined ? undefined : { codeHash: row.code_hash };
  },

  /** @returns True when this call verified the challenge. */
  async markVerified(client: Queryable, id: string, now: Date): Promise<boolean> {
    const result = await client.query(
      `UPDATE otp_challenges SET verified_at = $2 WHERE id = $1 AND verified_at IS NULL`,
      [id, now],
    );
    return result.rowCount === 1;
  },
};
