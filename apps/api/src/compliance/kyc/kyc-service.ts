import type { Pool } from 'pg';

import type { AuditWriter, Queryable } from '../../audit/audit-writer.js';
import { withTransaction } from '../../db/transaction.js';
import type { Clock } from '../../shared/clock.js';
import { accountHoldRepository } from '../holds/account-holds.js';
import type { KycProvider, KycResult, KycWebhookEvent } from './kyc-provider.js';
import { kycRepository, type KycCheckRecord } from './kyc-repository.js';
import { kycTransition, levelsSatisfying, type KycLevel } from './kyc-status.js';

/** What a webhook delivery did. */
export type KycWebhookOutcome = 'applied' | 'unchanged' | 'rejected' | 'duplicate' | 'ignored';

/** AML rule name for sanctions and PEP hits found during KYC. */
export const SANCTIONS_RULE = 'kyc_sanctions_pep';

/** Collaborators for {@link KycService}. */
export interface KycServiceDeps {
  readonly pool: Pool;
  readonly provider: KycProvider;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * KYC (playbook Step 8, spec §5.1, §15). Light checks at signup, full checks before the first
 * redemption. Reef stores only the vendor reference and the outcome, never documents.
 *
 * Webhooks are verified (HMAC, 5-minute window), deduplicated by event ID, and never trusted for
 * the outcome: the verdict is re-fetched from the vendor. A sanctions or PEP hit opens a
 * critical AML alert and holds redemptions.
 */
export class KycService {
  constructor(private readonly deps: KycServiceDeps) {}

  /**
   * Starts a vendor session and records a pending check.
   *
   * @param input The player, level, and client IP.
   * @returns The check ID and the token for the vendor SDK.
   * @throws DependencyUnavailableError when the vendor is unreachable.
   */
  async startSession(input: {
    userId: string;
    level: KycLevel;
    ip: string | null;
  }): Promise<{ checkId: string; sdkToken: string; expiresAt: Date }> {
    const session = await this.deps.provider.createSession(input);
    const checkId = await withTransaction(this.deps.pool, async (client) => {
      const id = await kycRepository.insertCheck(client, {
        userId: input.userId,
        level: input.level,
        vendor: this.deps.provider.name,
        vendorRef: session.vendorRef,
      });
      await this.deps.audit.record(
        {
          actorType: 'player',
          actorId: input.userId,
          action: 'kyc.session.started',
          targetType: 'kyc_check',
          targetId: id,
          details: { level: input.level },
          ip: input.ip,
        },
        client,
      );
      return id;
    });
    return { checkId, sdkToken: session.sdkToken, expiresAt: session.expiresAt };
  }

  /**
   * Handles a vendor webhook.
   *
   * @param input Headers, exact raw body, and the sender's IP.
   * @returns What the delivery did.
   * @throws AuthError when the signature is bad or stale (the vendor should not retry).
   * @throws DependencyUnavailableError when the verdict cannot be re-fetched (it should).
   */
  async handleWebhook(input: {
    headers: Readonly<Record<string, string | string[] | undefined>>;
    rawBody: Buffer;
    ip: string | null;
  }): Promise<KycWebhookOutcome> {
    const event = this.deps.provider.verifyWebhook({ ...input, now: this.deps.clock.now() });
    // Re-fetch before touching state: the body only says which check changed.
    const result = await this.deps.provider.getResult(event.vendorRef);
    return withTransaction(this.deps.pool, async (client) => {
      if (
        !(await kycRepository.claimWebhookEvent(client, this.deps.provider.name, event.eventId))
      ) {
        return 'duplicate';
      }
      const check = await kycRepository.lockByVendorRef(
        client,
        this.deps.provider.name,
        event.vendorRef,
      );
      if (check === undefined) {
        await this.#audit(client, 'kyc.webhook.unknown_check', null, input.ip, {
          eventId: event.eventId,
        });
        return 'ignored';
      }
      return this.#apply(client, check, result, event, input.ip);
    });
  }

  /**
   * @param userId Player.
   * @param level Level the action needs; a full check satisfies light.
   * @returns True when a qualifying check passed and no check found a sanctions hit.
   */
  async isVerified(userId: string, level: KycLevel): Promise<boolean> {
    return kycRepository.isVerified(this.deps.pool, userId, levelsSatisfying(level));
  }

  /**
   * @param userId Player.
   * @returns True when redemptions are on hold, for example after a sanctions hit.
   */
  async isRedemptionHeld(userId: string): Promise<boolean> {
    return accountHoldRepository.hasActive(this.deps.pool, userId, 'redemption');
  }

  async #apply(
    client: Queryable,
    check: KycCheckRecord,
    result: KycResult,
    event: KycWebhookEvent,
    ip: string | null,
  ): Promise<KycWebhookOutcome> {
    const transition = kycTransition(check.status, result.status);
    if (transition.kind === 'unchanged') return 'unchanged';
    if (transition.kind === 'rejected') {
      await this.#audit(client, 'kyc.transition_rejected', check, ip, {
        from: check.status,
        to: result.status,
        eventId: event.eventId,
      });
      return 'rejected';
    }
    await kycRepository.updateStatus(client, {
      id: check.id,
      status: transition.to,
      reasons: result.reasons,
    });
    await this.#audit(client, 'kyc.status_changed', check, ip, {
      level: check.level,
      from: check.status,
      to: transition.to,
      eventId: event.eventId,
    });
    if (transition.to === 'sanctions_hit') {
      const alertId = await accountHoldRepository.openAmlAlert(client, {
        userId: check.userId,
        rule: SANCTIONS_RULE,
        severity: 'critical',
      });
      const holdId = await accountHoldRepository.place(client, {
        userId: check.userId,
        kind: 'redemption',
        reason: SANCTIONS_RULE,
        sourceType: 'kyc_check',
        sourceId: check.id,
      });
      await this.#audit(client, 'compliance.redemption_hold.placed', check, ip, {
        alertId,
        holdId,
      });
    }
    return 'applied';
  }

  async #audit(
    client: Queryable,
    action: string,
    check: KycCheckRecord | null,
    ip: string | null,
    details: Record<string, string>,
  ): Promise<void> {
    await this.deps.audit.record(
      {
        actorType: 'system',
        actorId: null,
        action,
        ...(check === null ? {} : { targetType: 'kyc_check', targetId: check.id }),
        details: check === null ? details : { ...details, userId: check.userId },
        ip,
      },
      client,
    );
  }
}
