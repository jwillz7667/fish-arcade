import { ConflictError, ForbiddenError, NotFoundError } from '@reef/errors';
import type { Pool } from 'pg';

import type { AuditWriter } from '../../audit/audit-writer.js';
import { withTransaction } from '../../db/transaction.js';
import { MAX_SUPER_ADMINS, type AdminRole } from '../admin-permissions.js';
import { auditDiff } from '../http/audit-diff.js';

/** Serialises role changes so the super admin cap cannot be raced past. */
const ROLES_LOCK_KEY = 72_017;

/**
 * Admin role assignment (spec §13.1). Only `roles.manage` may call it; nobody may change their
 * own roles, and at most two admins hold Super Admin.
 */
export class AdminRolesService {
  constructor(private readonly deps: { pool: Pool; audit: AuditWriter }) {}

  /**
   * Replaces an admin's roles.
   *
   * @param input Acting admin, target admin, new roles, and IP.
   * @returns The roles now held.
   * @throws ForbiddenError when the actor targets themselves.
   * @throws NotFoundError when the target admin does not exist.
   * @throws ConflictError when the change would exceed two super admins.
   */
  async setRoles(input: {
    actorId: string;
    targetId: string;
    roles: readonly AdminRole[];
    ip: string;
  }): Promise<AdminRole[]> {
    if (input.actorId === input.targetId) {
      throw new ForbiddenError({ message: 'Admins cannot change their own roles' });
    }
    const roles = [...new Set(input.roles)].sort();
    return withTransaction(this.deps.pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1)', [ROLES_LOCK_KEY]);
      const exists = await client.query('SELECT 1 FROM admin_users WHERE id = $1', [
        input.targetId,
      ]);
      if (exists.rowCount !== 1) throw new NotFoundError();
      const { rows: current } = await client.query<{ name: AdminRole }>(
        `SELECT r.name FROM admin_user_roles ar JOIN roles r ON r.id = ar.role_id
          WHERE ar.admin_user_id = $1 ORDER BY r.name`,
        [input.targetId],
      );
      if (roles.includes('super_admin')) {
        const { rows } = await client.query<{ count: string }>(
          `SELECT count(*) FROM admin_user_roles ar JOIN roles r ON r.id = ar.role_id
            WHERE r.name = 'super_admin' AND ar.admin_user_id <> $1`,
          [input.targetId],
        );
        if (Number.parseInt(rows[0]?.count ?? '0', 10) >= MAX_SUPER_ADMINS) {
          throw new ConflictError({ message: 'At most two admins may hold super_admin' });
        }
      }
      await client.query('DELETE FROM admin_user_roles WHERE admin_user_id = $1', [input.targetId]);
      await client.query(
        `INSERT INTO admin_user_roles (admin_user_id, role_id)
         SELECT $1, id FROM roles WHERE name = ANY($2::text[])`,
        [input.targetId, roles],
      );
      await this.deps.audit.record(
        {
          actorType: 'admin',
          actorId: input.actorId,
          action: 'admin.roles.changed',
          targetType: 'admin_user',
          targetId: input.targetId,
          diff: auditDiff({ roles: current.map((row) => row.name) }, { roles }),
          ip: input.ip,
        },
        client,
      );
      return roles;
    });
  }
}
