import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@reef/errors';
import type { Pool } from 'pg';

import type { AuditWriter } from '../../audit/audit-writer.js';
import { withTransaction } from '../../db/transaction.js';
import type { Clock } from '../../shared/clock.js';
import type { AdminPrincipal } from '../auth/admin-session-service.js';
import type { ApprovalAction } from './approval-actions.js';

/** Playbook Step 9: approvals expire after 24 hours. */
export const APPROVAL_TTL_MS = 24 * 3_600_000;

/** An approval as the back office sees it. */
export interface ApprovalView {
  readonly id: string;
  readonly action: string;
  readonly payload: unknown;
  readonly status: 'pending' | 'approved' | 'rejected' | 'expired' | 'executed';
  readonly requestedBy: string;
  readonly approvedBy: string | null;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly decidedAt: Date | null;
}

interface ApprovalRow {
  id: string;
  action: string;
  payload: unknown;
  status: ApprovalView['status'];
  requested_by: string;
  approved_by: string | null;
  created_at: Date;
  expires_at: Date;
  decided_at: Date | null;
}

const toView = (row: ApprovalRow): ApprovalView => ({
  id: row.id,
  action: row.action,
  payload: row.payload,
  status: row.status,
  requestedBy: row.requested_by,
  approvedBy: row.approved_by,
  createdAt: row.created_at,
  expiresAt: row.expires_at,
  decidedAt: row.decided_at,
});

type Decision = { kind: 'executed'; view: ApprovalView } | { kind: 'expired' };

/**
 * Four-eyes approvals (playbook Step 9). A request stores the action and payload; a second
 * admin with the approve permission, who is not the requester, approves it, and the action
 * executes in the same transaction. Requests expire after 24 hours and can no longer execute.
 */
export class ApprovalsService {
  constructor(
    private readonly deps: {
      pool: Pool;
      audit: AuditWriter;
      clock: Clock;
      actions: ReadonlyMap<string, ApprovalAction<unknown>>;
    },
  ) {}

  /**
   * @param admin Requesting admin.
   * @param input Action name, payload, and IP.
   * @returns The pending approval.
   * @throws ValidationError for an unknown action or invalid payload.
   * @throws ForbiddenError when the admin may not request this action.
   */
  async request(
    admin: AdminPrincipal,
    input: { action: string; payload: unknown; ip: string },
  ): Promise<ApprovalView> {
    const action = this.#action(input.action);
    if (!admin.permissions.has(action.requestPermission)) throw new ForbiddenError();
    const parsed = action.payloadSchema.safeParse(input.payload);
    if (!parsed.success) {
      throw new ValidationError({
        issues: parsed.error.issues.map((issue) => ({
          path: ['payload', ...issue.path].join('.'),
          message: issue.message,
        })),
      });
    }
    const target = action.target(parsed.data);
    const expiresAt = new Date(this.deps.clock.now().getTime() + APPROVAL_TTL_MS);
    return withTransaction(this.deps.pool, async (client) => {
      const { rows } = await client.query<ApprovalRow>(
        `INSERT INTO approvals (action, payload, requested_by, expires_at)
         VALUES ($1, $2::jsonb, $3, $4) RETURNING *`,
        [action.name, JSON.stringify(parsed.data), admin.adminId, expiresAt],
      );
      const [row] = rows;
      if (row === undefined) throw new Error('INSERT RETURNING produced no row');
      await this.deps.audit.record(
        {
          actorType: 'admin',
          actorId: admin.adminId,
          action: 'admin.approval.requested',
          targetType: target.type,
          targetId: target.id,
          details: { approvalId: row.id, action: action.name },
          ip: input.ip,
        },
        client,
      );
      return toView(row);
    });
  }

  /**
   * Approves and executes, atomically.
   *
   * @param admin Approving admin.
   * @param input Approval ID and IP.
   * @returns The executed approval.
   * @throws NotFoundError for an unknown approval.
   * @throws ForbiddenError when the approver is the requester or lacks the approve permission.
   * @throws ConflictError when the approval is no longer pending or has expired.
   */
  async approve(
    admin: AdminPrincipal,
    input: { approvalId: string; ip: string },
  ): Promise<ApprovalView> {
    const now = this.deps.clock.now();
    const decision = await withTransaction(this.deps.pool, async (client): Promise<Decision> => {
      const row = await this.#lock(client, input.approvalId);
      const action = this.#action(row.action);
      if (row.requested_by === admin.adminId) {
        throw new ForbiddenError({ message: 'Requesters cannot approve their own request' });
      }
      if (!admin.permissions.has(action.approvePermission)) throw new ForbiddenError();
      if (row.status !== 'pending')
        throw new ConflictError({ message: `Approval is ${row.status}` });
      if (row.expires_at <= now) {
        await client.query(
          `UPDATE approvals SET status = 'expired', decided_at = $2 WHERE id = $1`,
          [row.id, now],
        );
        return { kind: 'expired' };
      }
      const payload = action.payloadSchema.parse(row.payload);
      const result = await action.execute(payload, {
        client,
        requesterId: row.requested_by,
        approverId: admin.adminId,
      });
      const { rows } = await client.query<ApprovalRow>(
        `UPDATE approvals SET status = 'executed', approved_by = $2, decided_at = $3
          WHERE id = $1 RETURNING *`,
        [row.id, admin.adminId, now],
      );
      const target = action.target(payload);
      await this.deps.audit.record(
        {
          actorType: 'admin',
          actorId: admin.adminId,
          action: `admin.approval.executed`,
          targetType: target.type,
          targetId: target.id,
          details: {
            approvalId: row.id,
            action: action.name,
            requestedBy: row.requested_by,
            ...result,
          },
          ip: input.ip,
        },
        client,
      );
      const [updated] = rows;
      if (updated === undefined) throw new Error('UPDATE RETURNING produced no row');
      return { kind: 'executed', view: toView(updated) };
    });
    // The expiry was committed above; report it now.
    if (decision.kind === 'expired') throw new ConflictError({ message: 'Approval expired' });
    return decision.view;
  }

  /**
   * Rejects a pending approval. The requester may withdraw it; otherwise the approve permission
   * is needed.
   *
   * @param admin Deciding admin.
   * @param input Approval ID and IP.
   * @throws NotFoundError, ForbiddenError, or ConflictError as for {@link approve}.
   */
  async reject(
    admin: AdminPrincipal,
    input: { approvalId: string; ip: string },
  ): Promise<ApprovalView> {
    const now = this.deps.clock.now();
    return withTransaction(this.deps.pool, async (client) => {
      const row = await this.#lock(client, input.approvalId);
      const action = this.#action(row.action);
      const isRequester = row.requested_by === admin.adminId;
      if (!isRequester && !admin.permissions.has(action.approvePermission))
        throw new ForbiddenError();
      if (row.status !== 'pending')
        throw new ConflictError({ message: `Approval is ${row.status}` });
      const { rows } = await client.query<ApprovalRow>(
        `UPDATE approvals SET status = 'rejected', approved_by = $2, decided_at = $3
          WHERE id = $1 RETURNING *`,
        [row.id, admin.adminId, now],
      );
      await this.deps.audit.record(
        {
          actorType: 'admin',
          actorId: admin.adminId,
          action: 'admin.approval.rejected',
          targetType: 'approval',
          targetId: row.id,
          details: { action: action.name, withdrawn: isRequester },
          ip: input.ip,
        },
        client,
      );
      const [updated] = rows;
      if (updated === undefined) throw new Error('UPDATE RETURNING produced no row');
      return toView(updated);
    });
  }

  /**
   * @param input Status filter, cursor (an approval's created_at), and page size.
   * @returns Approvals, newest first.
   */
  async list(input: {
    status?: ApprovalView['status'];
    before?: Date;
    limit: number;
  }): Promise<ApprovalView[]> {
    const { rows } = await this.deps.pool.query<ApprovalRow>(
      `SELECT * FROM approvals
        WHERE ($1::"ApprovalStatus" IS NULL OR status = $1::"ApprovalStatus")
          AND ($2::timestamptz IS NULL OR created_at < $2)
        ORDER BY created_at DESC LIMIT $3`,
      [input.status ?? null, input.before ?? null, input.limit],
    );
    return rows.map(toView);
  }

  async #lock(client: Pick<Pool, 'query'>, approvalId: string): Promise<ApprovalRow> {
    const { rows } = await client.query<ApprovalRow>(
      'SELECT * FROM approvals WHERE id = $1 FOR UPDATE',
      [approvalId],
    );
    const [row] = rows;
    if (row === undefined) throw new NotFoundError();
    return row;
  }

  #action(name: string): ApprovalAction<unknown> {
    const action = this.deps.actions.get(name);
    if (action === undefined) {
      throw new ValidationError({
        issues: [{ path: 'action', message: 'is not an approval action' }],
      });
    }
    return action;
  }
}
