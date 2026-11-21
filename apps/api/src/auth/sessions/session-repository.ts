import type { Queryable } from '../../audit/audit-writer.js';

/** Account statuses that cannot hold a session. */
const BLOCKED_STATUSES: ReadonlySet<string> = new Set(['closed', 'suspended']);

// Served by the account_holds (user_id, kind) index. Expects the users row aliased as `u`.
const IS_FROZEN_SQL = `EXISTS (
  SELECT 1 FROM account_holds h
   WHERE h.user_id = u.id AND h.kind = 'freeze' AND h.released_at IS NULL
)`;

/** A refresh token joined with its session, as locked during rotation. */
export interface RefreshTokenRecord {
  readonly tokenId: string;
  readonly sessionId: string;
  readonly userId: string;
  readonly authTime: Date;
  readonly amr: readonly string[];
  readonly usedAt: Date | null;
  readonly expiresAt: Date;
  readonly sessionExpiresAt: Date;
  readonly sessionRevokedAt: Date | null;
  /** True when the account has been closed since the session started. */
  /** Closed, suspended, or under a compliance freeze: the session must end. */
  readonly isAccountBlocked: boolean;
}

interface RefreshRow {
  token_id: string;
  session_id: string;
  user_id: string;
  auth_time: Date;
  amr: string[];
  used_at: Date | null;
  expires_at: Date;
  session_expires_at: Date;
  session_revoked_at: Date | null;
  user_status: string;
  is_frozen: boolean;
}

/** SQL for `auth_sessions` and `refresh_tokens`. Every query is parameterized. */
export const sessionRepository = {
  /**
   * @returns The new session ID.
   */
  async createSession(
    client: Queryable,
    input: { userId: string; authTime: Date; amr: readonly string[]; expiresAt: Date },
  ): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO auth_sessions (user_id, auth_time, amr, expires_at)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.userId, input.authTime, input.amr, input.expiresAt],
    );
    const [row] = rows;
    if (row === undefined) throw new Error('INSERT RETURNING produced no row');
    return row.id;
  },

  /**
   * @param client Transaction client.
   * @param input Session, SHA-256 of the token, and expiry (the session's).
   */
  async insertRefreshToken(
    client: Queryable,
    input: { sessionId: string; tokenHash: string; expiresAt: Date },
  ): Promise<void> {
    await client.query(
      `INSERT INTO refresh_tokens (session_id, token_hash, expires_at) VALUES ($1, $2, $3)`,
      [input.sessionId, input.tokenHash, input.expiresAt],
    );
  },

  /**
   * Locks the user row against a concurrent status change while a session is created.
   *
   * @param client Transaction client.
   * @param userId Account.
   * @returns True when the account exists, is neither closed nor suspended, and has no active
   *   compliance freeze (playbook Step 12).
   */
  async isAccountOpen(client: Queryable, userId: string): Promise<boolean> {
    const { rows } = await client.query<{ status: string; is_frozen: boolean }>(
      `SELECT status, ${IS_FROZEN_SQL} AS is_frozen FROM users u WHERE u.id = $1 FOR SHARE`,
      [userId],
    );
    const [row] = rows;
    return row !== undefined && !BLOCKED_STATUSES.has(row.status) && !row.is_frozen;
  },

  /**
   * Locks the token and its session until the transaction ends, so concurrent rotations of
   * one family run one at a time.
   */
  async lockRefreshToken(
    client: Queryable,
    tokenHash: string,
  ): Promise<RefreshTokenRecord | undefined> {
    const { rows } = await client.query<RefreshRow>(
      `SELECT rt.id AS token_id, rt.session_id, s.user_id, s.auth_time, s.amr, rt.used_at,
              rt.expires_at, s.expires_at AS session_expires_at, s.revoked_at AS session_revoked_at,
              u.status AS user_status, ${IS_FROZEN_SQL} AS is_frozen
         FROM refresh_tokens rt
         JOIN auth_sessions s ON s.id = rt.session_id
         JOIN users u ON u.id = s.user_id
        WHERE rt.token_hash = $1
          FOR UPDATE OF s, rt`,
      [tokenHash],
    );
    const [row] = rows;
    if (row === undefined) return undefined;
    return {
      tokenId: row.token_id,
      sessionId: row.session_id,
      userId: row.user_id,
      authTime: row.auth_time,
      amr: row.amr,
      usedAt: row.used_at,
      expiresAt: row.expires_at,
      sessionExpiresAt: row.session_expires_at,
      sessionRevokedAt: row.session_revoked_at,
      isAccountBlocked: BLOCKED_STATUSES.has(row.user_status) || row.is_frozen,
    };
  },

  /**
   * @param client Pool or transaction client.
   * @param tokenHash SHA-256 of a refresh token.
   * @returns The session and user the token belongs to, or undefined.
   */
  async findSessionByRefreshToken(
    client: Queryable,
    tokenHash: string,
  ): Promise<{ sessionId: string; userId: string } | undefined> {
    const { rows } = await client.query<{ session_id: string; user_id: string }>(
      `SELECT rt.session_id, s.user_id
         FROM refresh_tokens rt JOIN auth_sessions s ON s.id = rt.session_id
        WHERE rt.token_hash = $1`,
      [tokenHash],
    );
    const [row] = rows;
    return row === undefined ? undefined : { sessionId: row.session_id, userId: row.user_id };
  },

  /**
   * Marks a token spent; presenting it again counts as reuse.
   *
   * @param client Transaction client holding the token lock.
   * @param tokenId Token.
   * @param usedAt When it was rotated.
   */
  async markRefreshTokenUsed(client: Queryable, tokenId: string, usedAt: Date): Promise<void> {
    await client.query(`UPDATE refresh_tokens SET used_at = $2 WHERE id = $1`, [tokenId, usedAt]);
  },

  /**
   * @returns True when this call revoked the session; false when it was already revoked.
   */
  async revokeSession(
    client: Queryable,
    input: { sessionId: string; reason: string; at: Date },
  ): Promise<boolean> {
    const result = await client.query(
      `UPDATE auth_sessions SET revoked_at = $2, revoke_reason = $3
        WHERE id = $1 AND revoked_at IS NULL`,
      [input.sessionId, input.at, input.reason],
    );
    return result.rowCount === 1;
  },

  /**
   * @returns IDs of the user's sessions that were still active and are now revoked.
   */
  async revokeUserSessions(
    client: Queryable,
    input: { userId: string; reason: string; at: Date; exceptSessionId?: string },
  ): Promise<string[]> {
    const { rows } = await client.query<{ id: string }>(
      `UPDATE auth_sessions SET revoked_at = $2, revoke_reason = $3
        WHERE user_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $4::uuid
        RETURNING id`,
      [input.userId, input.at, input.reason, input.exceptSessionId ?? null],
    );
    return rows.map((row) => row.id);
  },
};
