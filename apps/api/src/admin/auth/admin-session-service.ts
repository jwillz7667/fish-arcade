import { AuthError } from '@reef/errors';
import type { Pool } from 'pg';

import type { AuditWriter } from '../../audit/audit-writer.js';
import { hmacHex, randomToken, safeEqual, sha256Hex } from '../../auth/crypto/secrets.js';
import type { Clock } from '../../shared/clock.js';
import { permissionsFor, type Permission } from '../admin-permissions.js';

/** A signed-in admin, as the admin guard sees them. */
export interface AdminPrincipal {
  readonly adminId: string;
  readonly sessionId: string;
  readonly email: string;
  readonly roles: readonly string[];
  readonly permissions: ReadonlySet<Permission>;
}

/** A new admin session, for the cookies. */
export interface IssuedAdminSession {
  readonly token: string;
  readonly sessionId: string;
  readonly csrfToken: string;
  readonly expiresAt: Date;
}

/** Settings and collaborators for {@link AdminSessionService}. */
export interface AdminSessionServiceDeps {
  readonly pool: Pool;
  readonly audit: AuditWriter;
  readonly hmacKey: Buffer;
  readonly clock: Clock;
  readonly idleMinutes: number;
  readonly maxHours: number;
}

interface SessionRow {
  id: string;
  admin_user_id: string;
  email: string;
  last_seen_at: Date;
  expires_at: Date;
  roles: string[];
}

// Avoid a write per request: last_seen_at only moves once a minute.
const TOUCH_INTERVAL_MS = 60_000;

/**
 * Back office sessions (spec §13.3). The token is an opaque 256-bit value in a Strict cookie,
 * stored as a SHA-256 hash. A session ends after the idle timeout (30 minutes by default), at
 * its absolute expiry, on logout, or when the admin is disabled. Roles are read on every
 * request, so removing a role takes effect at once.
 */
export class AdminSessionService {
  constructor(private readonly deps: AdminSessionServiceDeps) {}

  /**
   * @param input The admin and their IP.
   * @returns The session token and its CSRF token.
   */
  async create(input: { adminId: string; ip: string }): Promise<IssuedAdminSession> {
    const now = this.deps.clock.now();
    const token = randomToken();
    const expiresAt = new Date(now.getTime() + this.deps.maxHours * 3_600_000);
    const { rows } = await this.deps.pool.query<{ id: string }>(
      `INSERT INTO admin_sessions (admin_user_id, token_hash, last_seen_at, expires_at, ip)
       VALUES ($1, $2, $3, $4, $5::inet) RETURNING id`,
      [input.adminId, sha256Hex(token), now, expiresAt, input.ip],
    );
    const sessionId = rows[0]?.id;
    if (sessionId === undefined) throw new Error('INSERT RETURNING produced no row');
    await this.deps.audit.record({
      actorType: 'admin',
      actorId: input.adminId,
      action: 'admin.session.started',
      targetType: 'admin_session',
      targetId: sessionId,
      ip: input.ip,
    });
    return { token, sessionId, csrfToken: this.csrfTokenFor(sessionId), expiresAt };
  }

  /**
   * @param token Value of the admin session cookie.
   * @returns The admin behind it.
   * @throws AuthError when the session is unknown, revoked, idle too long, past its expiry, or
   *   the admin is disabled.
   */
  async authenticate(token: string): Promise<AdminPrincipal> {
    const now = this.deps.clock.now();
    const { rows } = await this.deps.pool.query<SessionRow>(
      `SELECT s.id, s.admin_user_id, a.email, s.last_seen_at, s.expires_at,
              coalesce(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
         FROM admin_sessions s
         JOIN admin_users a ON a.id = s.admin_user_id AND a.status = 'active'
         LEFT JOIN admin_user_roles ar ON ar.admin_user_id = a.id
         LEFT JOIN roles r ON r.id = ar.role_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL
        GROUP BY s.id, a.email`,
      [sha256Hex(token)],
    );
    const [row] = rows;
    if (row === undefined) throw new AuthError({ message: 'Unknown admin session' });
    const idleMs = this.deps.idleMinutes * 60_000;
    if (now >= row.expires_at || now.getTime() - row.last_seen_at.getTime() > idleMs) {
      await this.revoke({
        sessionId: row.id,
        adminId: row.admin_user_id,
        reason: 'timeout',
        ip: null,
      });
      throw new AuthError({ message: 'Admin session timed out' });
    }
    if (now.getTime() - row.last_seen_at.getTime() > TOUCH_INTERVAL_MS) {
      await this.deps.pool.query('UPDATE admin_sessions SET last_seen_at = $2 WHERE id = $1', [
        row.id,
        now,
      ]);
    }
    return {
      adminId: row.admin_user_id,
      sessionId: row.id,
      email: row.email,
      roles: row.roles,
      permissions: permissionsFor(row.roles),
    };
  }

  /**
   * Ends a session. Idempotent.
   *
   * @param input Session, admin, why, and IP.
   */
  async revoke(input: {
    sessionId: string;
    adminId: string;
    reason: string;
    ip: string | null;
  }): Promise<void> {
    const result = await this.deps.pool.query(
      'UPDATE admin_sessions SET revoked_at = $2 WHERE id = $1 AND revoked_at IS NULL',
      [input.sessionId, this.deps.clock.now()],
    );
    if (result.rowCount !== 1) return;
    await this.deps.audit.record({
      actorType: 'admin',
      actorId: input.adminId,
      action: 'admin.session.ended',
      targetType: 'admin_session',
      targetId: input.sessionId,
      details: { reason: input.reason },
      ip: input.ip,
    });
  }

  /**
   * @param sessionId Admin session.
   * @returns The CSRF token for it: an HMAC, distinct from the player CSRF token.
   */
  csrfTokenFor(sessionId: string): string {
    return hmacHex(this.deps.hmacKey, 'admin-csrf', sessionId);
  }

  /**
   * @param sessionId Admin session.
   * @param header `X-CSRF-Token` value.
   * @returns True when it is this session's token. Constant time.
   */
  isValidCsrf(sessionId: string, header: string | undefined): boolean {
    return header !== undefined && header !== '' && safeEqual(header, this.csrfTokenFor(sessionId));
  }
}
