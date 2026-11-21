import type { Logger } from '@reef/logger';
import type { ScreeningAlert } from '@reef/screening';
import type { Pool } from 'pg';

import type { AuditWriter } from '../../audit/audit-writer.js';
import { withTransaction } from '../../db/transaction.js';
import { accountHoldRepository } from './account-holds.js';

/** Why an account is frozen: the alert to open and the record that triggered it. */
export interface FreezeRequest {
  readonly userId: string;
  readonly alert: ScreeningAlert;
  /** Such as `btc_deposit` or `payout_address`. */
  readonly sourceType: string;
  readonly sourceId: string;
}

/** What a freeze did. */
export interface FreezeResult {
  readonly holdId: string;
  /** False when this source had already frozen the account. */
  readonly isNew: boolean;
}

/** Ends every session of a user. `SessionService.revokeAll` in production. */
export type RevokeAllSessions = (input: { userId: string; reason: string }) => Promise<number>;

/** Collaborators for {@link AccountFreezer}. */
export interface AccountFreezerDeps {
  readonly pool: Pool;
  readonly audit: AuditWriter;
  readonly revokeAllSessions: RevokeAllSessions;
  readonly logger: Logger;
}

/**
 * Freezes an account after a sanctioned or severe-risk chain screening (spec §22.2, §22.3,
 * playbook Step 12). In one transaction: suspends an active account, places a `freeze` hold,
 * opens the AML alert, and audits it. Then it ends every session. Only Compliance can lift it,
 * through the `account_hold.release` approval; releasing the last freeze hold reactivates the
 * account. The player is not told why, so the freeze does not tip off a sanctioned party.
 */
export class AccountFreezer {
  constructor(private readonly deps: AccountFreezerDeps) {}

  /**
   * Idempotent per source: freezing again for the same record changes nothing.
   *
   * @param request Who, why, and what triggered it.
   * @returns The hold and whether it is new.
   * @throws Error when Postgres fails; nothing is frozen and the caller retries.
   */
  async freeze(request: FreezeRequest): Promise<FreezeResult> {
    const result = await withTransaction(this.deps.pool, async (client) => {
      // Serialises freezes of one account, so a repeat sees the first one's hold.
      await client.query('SELECT 1 FROM users WHERE id = $1 FOR UPDATE', [request.userId]);
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM account_holds
          WHERE user_id = $1 AND kind = 'freeze' AND source_type = $2 AND source_id = $3
            AND released_at IS NULL`,
        [request.userId, request.sourceType, request.sourceId],
      );
      const existing = rows[0]?.id;
      if (existing !== undefined) return { holdId: existing, isNew: false };
      // A closed or self-excluded account keeps its status; the hold blocks it all the same.
      await client.query(
        `UPDATE users SET status = 'suspended', updated_at = now() WHERE id = $1 AND status = 'active'`,
        [request.userId],
      );
      const holdId = await accountHoldRepository.place(client, {
        userId: request.userId,
        kind: 'freeze',
        reason: request.alert.rule,
        sourceType: request.sourceType,
        sourceId: request.sourceId,
      });
      const alertId = await accountHoldRepository.openAmlAlert(client, {
        userId: request.userId,
        rule: request.alert.rule,
        severity: request.alert.severity,
      });
      await this.deps.audit.record(
        {
          actorType: 'system',
          actorId: null,
          action: 'compliance.account_frozen',
          targetType: 'user',
          targetId: request.userId,
          details: {
            rule: request.alert.rule,
            sourceType: request.sourceType,
            sourceId: request.sourceId,
            holdId,
            alertId,
          },
          ip: null,
        },
        client,
      );
      return { holdId, isNew: true };
    });
    if (result.isNew) {
      this.deps.logger.error(
        { metric: 'compliance.account_frozen', userId: request.userId, rule: request.alert.rule },
        'account frozen by chain screening',
      );
    }
    // Runs on repeats too, in case an earlier attempt committed but failed here.
    try {
      await this.deps.revokeAllSessions({ userId: request.userId, reason: 'account_frozen' });
    } catch (error) {
      // The freeze already refuses every refresh and login; live access tokens expire shortly.
      this.deps.logger.error(
        { err: error, userId: request.userId },
        'session revocation after freeze failed',
      );
    }
    return result;
  }
}
