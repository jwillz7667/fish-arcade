import type { FieldEncryption } from '@reef/crypto-fields';
import { NotFoundError } from '@reef/errors';
import type { Pool } from 'pg';

import { MASKED_DATE, maskEmail, maskPhone } from './pii-mask.js';

/** A player as the back office sees them. PII is masked unless the admin has PII access. */
export interface AdminPlayerView {
  readonly id: string;
  readonly status: string;
  readonly createdAt: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly displayName: string | null;
  readonly dateOfBirth: string | null;
  readonly stateCode: string | null;
  readonly isPiiMasked: boolean;
  readonly kyc: readonly { level: string; status: string; updatedAt: string }[];
  readonly activeHolds: readonly { id: string; kind: string; reason: string; createdAt: string }[];
}

interface PlayerRow {
  id: string;
  status: string;
  created_at: Date;
  email_enc: string | null;
  phone_enc: string | null;
  display_name: string | null;
  dob_enc: string | null;
  state_code: string | null;
}

/** Reads players for the back office (spec §13.2) and applies role-based PII masking. */
export class AdminPlayerService {
  constructor(private readonly deps: { pool: Pool; encryption: FieldEncryption }) {}

  /**
   * @param playerId Player.
   * @param canSeePii Whether the admin holds `players.read_pii`.
   * @returns The player, masked for roles without PII access (spec §13.1: support sees PII
   *   masked).
   * @throws NotFoundError when there is no such player.
   */
  async get(playerId: string, canSeePii: boolean): Promise<AdminPlayerView> {
    const { pool } = this.deps;
    const { rows } = await pool.query<PlayerRow>(
      `SELECT u.id, u.status, u.created_at, u.email_enc, u.phone_enc, p.display_name, p.dob_enc,
              p.state_code
         FROM users u LEFT JOIN profiles p ON p.user_id = u.id WHERE u.id = $1`,
      [playerId],
    );
    const [player] = rows;
    if (player === undefined) throw new NotFoundError();
    const [kyc, holds] = await Promise.all([
      pool.query<{ level: string; status: string; updated_at: Date }>(
        `SELECT DISTINCT ON (level) level, status, updated_at FROM kyc_checks
          WHERE user_id = $1 ORDER BY level, created_at DESC`,
        [player.id],
      ),
      pool.query<{ id: string; kind: string; reason: string; created_at: Date }>(
        `SELECT id, kind, reason, created_at FROM account_holds
          WHERE user_id = $1 AND released_at IS NULL ORDER BY created_at`,
        [player.id],
      ),
    ]);
    const reveal = async (
      envelope: string | null,
      field: { table: string; column: string },
      mask: (plain: string) => string,
    ): Promise<string | null> => {
      if (envelope === null) return null;
      const plain = await this.deps.encryption.cipher.decrypt(envelope, field);
      return canSeePii ? plain : mask(plain);
    };
    return {
      id: player.id,
      status: player.status,
      createdAt: player.created_at.toISOString(),
      email: await reveal(player.email_enc, { table: 'users', column: 'email_enc' }, maskEmail),
      phone: await reveal(player.phone_enc, { table: 'users', column: 'phone_enc' }, maskPhone),
      displayName: player.display_name,
      dateOfBirth: await reveal(
        player.dob_enc,
        { table: 'profiles', column: 'dob_enc' },
        () => MASKED_DATE,
      ),
      stateCode: player.state_code,
      isPiiMasked: !canSeePii,
      kyc: kyc.rows.map((row) => ({
        level: row.level,
        status: row.status,
        updatedAt: row.updated_at.toISOString(),
      })),
      activeHolds: holds.rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        reason: row.reason,
        createdAt: row.created_at.toISOString(),
      })),
    };
  }
}
