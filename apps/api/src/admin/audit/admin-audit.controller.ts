import { Get, Inject, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { z } from 'zod';

import { PG_POOL } from '../../app/tokens.js';
import { AdminController, RequirePermission } from '../http/admin-decorators.js';

const auditQuery = z.object({
  actorId: z.string().max(64).optional(),
  action: z.string().max(128).optional(),
  targetType: z.string().max(64).optional(),
  targetId: z.string().max(64).optional(),
  // Cursor: the smallest `id` from the previous page.
  before: z.coerce.bigint().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** One audit row. Diffs were masked when written. */
export interface AuditEntry {
  readonly id: string;
  readonly actorType: string;
  readonly actorId: string | null;
  readonly action: string;
  readonly targetType: string | null;
  readonly targetId: string | null;
  readonly before: unknown;
  readonly after: unknown;
  readonly ip: string | null;
  readonly createdAt: string;
}

/** Audit log viewer (spec §13.2): filter by actor, action, and target. */
@AdminController('audit')
export class AdminAuditController {
  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  /** Newest first, cursor-paginated by ID. */
  @Get()
  @RequirePermission('audit.read')
  async list(
    @Query({ schema: auditQuery }) query: z.infer<typeof auditQuery>,
  ): Promise<AuditEntry[]> {
    const { rows } = await this.pool.query<{
      id: string;
      actor_type: string;
      actor_id: string | null;
      action: string;
      target_type: string | null;
      target_id: string | null;
      before: unknown;
      after: unknown;
      ip: string | null;
      created_at: Date;
    }>(
      `SELECT id::text, actor_type, actor_id, action, target_type, target_id, before, after,
              host(ip) AS ip, created_at
         FROM audit_logs
        WHERE ($1::text IS NULL OR actor_id = $1)
          AND ($2::text IS NULL OR action = $2)
          AND ($3::text IS NULL OR target_type = $3)
          AND ($4::text IS NULL OR target_id = $4)
          AND ($5::bigint IS NULL OR id < $5)
        ORDER BY id DESC LIMIT $6`,
      [
        query.actorId ?? null,
        query.action ?? null,
        query.targetType ?? null,
        query.targetId ?? null,
        query.before?.toString() ?? null,
        query.limit,
      ],
    );
    return rows.map((row) => ({
      id: row.id,
      actorType: row.actor_type,
      actorId: row.actor_id,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      before: row.before,
      after: row.after,
      ip: row.ip,
      createdAt: row.created_at.toISOString(),
    }));
  }
}
