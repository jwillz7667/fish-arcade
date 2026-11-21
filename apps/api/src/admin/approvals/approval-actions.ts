import { ConflictError } from '@reef/errors';
import { z } from 'zod';

import type { Queryable } from '../../audit/audit-writer.js';
import type { Permission } from '../admin-permissions.js';

/** Context an approved action runs with. */
export interface ApprovalExecution {
  readonly client: Queryable;
  readonly requesterId: string;
  readonly approverId: string;
}

/**
 * A four-eyes action (playbook Step 9): who may request it, who may approve it, its payload,
 * and what it does once approved. `execute` runs in the same transaction that marks the
 * approval executed, so either both happen or neither does.
 */
export interface ApprovalAction<Payload> {
  readonly name: string;
  readonly requestPermission: Permission;
  readonly approvePermission: Permission;
  readonly payloadSchema: z.ZodType<Payload>;
  readonly target: (payload: Payload) => { readonly type: string; readonly id: string };
  readonly execute: (
    payload: Payload,
    execution: ApprovalExecution,
  ) => Promise<Readonly<Record<string, string>>>;
}

const releaseHoldPayload = z.object({
  holdId: z.uuid(),
  reason: z.string().trim().min(10).max(500),
});

/**
 * Releases an account hold, such as the redemption hold after a KYC sanctions hit. Compliance
 * requests; a different compliance officer approves.
 */
export const releaseAccountHold: ApprovalAction<z.infer<typeof releaseHoldPayload>> = {
  name: 'account_hold.release',
  requestPermission: 'holds.release',
  approvePermission: 'holds.release',
  payloadSchema: releaseHoldPayload,
  target: (payload) => ({ type: 'account_hold', id: payload.holdId }),
  execute: async (payload, { client, approverId }) => {
    const { rows } = await client.query<{ user_id: string }>(
      `UPDATE account_holds SET released_at = now(), released_by = $2
        WHERE id = $1 AND released_at IS NULL RETURNING user_id`,
      [payload.holdId, approverId],
    );
    const userId = rows[0]?.user_id;
    if (userId === undefined)
      throw new ConflictError({ message: 'Hold already released or unknown' });
    return { userId };
  },
};

/** Every action the approvals service accepts. Later steps register theirs here. */
export const APPROVAL_ACTIONS: ReadonlyMap<string, ApprovalAction<unknown>> = new Map(
  [releaseAccountHold].map((action) => [action.name, action as ApprovalAction<unknown>]),
);
