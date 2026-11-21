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
 * requests; a different compliance officer approves. Releasing an account's last freeze hold
 * also reactivates it, if the freeze had suspended it (playbook Step 12).
 */
export const releaseAccountHold: ApprovalAction<z.infer<typeof releaseHoldPayload>> = {
  name: 'account_hold.release',
  requestPermission: 'holds.release',
  approvePermission: 'holds.release',
  payloadSchema: releaseHoldPayload,
  target: (payload) => ({ type: 'account_hold', id: payload.holdId }),
  execute: async (payload, { client, approverId }) => {
    const { rows } = await client.query<{ user_id: string; kind: string }>(
      `UPDATE account_holds SET released_at = now(), released_by = $2
        WHERE id = $1 AND released_at IS NULL RETURNING user_id, kind`,
      [payload.holdId, approverId],
    );
    const [hold] = rows;
    if (hold === undefined)
      throw new ConflictError({ message: 'Hold already released or unknown' });
    if (hold.kind !== 'freeze') return { userId: hold.user_id };
    const reactivated = await client.query(
      `UPDATE users SET status = 'active', updated_at = now()
        WHERE id = $1 AND status = 'suspended'
          AND NOT EXISTS (
            SELECT 1 FROM account_holds
             WHERE user_id = $1 AND kind = 'freeze' AND released_at IS NULL
          )`,
      [hold.user_id],
    );
    return { userId: hold.user_id, reactivated: String((reactivated.rowCount ?? 0) > 0) };
  },
};

const clearSanctionsPayload = z.object({
  kycCheckId: z.uuid(),
  reason: z.string().trim().min(10).max(500),
});

/**
 * Clears a false-positive sanctions hit (spec §15) and releases the redemption holds it placed,
 * in one transaction. One Compliance officer requests; a different one approves. The check
 * keeps its `sanctions_hit` status as the vendor's verdict. Identity verification still needs a
 * passed check, so a player whose only check flipped to a hit verifies again.
 */
export const clearSanctionsHit: ApprovalAction<z.infer<typeof clearSanctionsPayload>> = {
  name: 'kyc.clear_sanctions_hit',
  requestPermission: 'aml.write',
  approvePermission: 'aml.write',
  payloadSchema: clearSanctionsPayload,
  target: (payload) => ({ type: 'kyc_check', id: payload.kycCheckId }),
  execute: async (payload, { client, approverId }) => {
    const { rows } = await client.query<{ user_id: string }>(
      `UPDATE kyc_checks
          SET sanctions_cleared_at = now(), sanctions_cleared_by = $2, updated_at = now()
        WHERE id = $1 AND status = 'sanctions_hit' AND sanctions_cleared_at IS NULL
        RETURNING user_id`,
      [payload.kycCheckId, approverId],
    );
    const userId = rows[0]?.user_id;
    if (userId === undefined) {
      throw new ConflictError({ message: 'No uncleared sanctions hit with that ID' });
    }
    const released = await client.query(
      `UPDATE account_holds SET released_at = now(), released_by = $2
        WHERE source_type = 'kyc_check' AND source_id = $1 AND released_at IS NULL`,
      [payload.kycCheckId, approverId],
    );
    return { userId, releasedHolds: String(released.rowCount ?? 0) };
  },
};

/** Every action the approvals service accepts. Later steps register theirs here. */
export const APPROVAL_ACTIONS: ReadonlyMap<string, ApprovalAction<unknown>> = new Map(
  [releaseAccountHold, clearSanctionsHit].map((action) => [
    action.name,
    action as ApprovalAction<unknown>,
  ]),
);
