import { ValidationError } from '@reef/errors';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';
import { z } from 'zod';

import type { AuditWriter } from '../../audit/audit-writer.js';
import type { Clock } from '../../shared/clock.js';
import { withTransaction } from '../../db/transaction.js';
import type { JurisdictionRule } from './jurisdiction-policy.js';
import { jurisdictionRepository, type NewJurisdictionRule } from './jurisdiction-repository.js';

/** Playbook Step 7: rules are cached for 60 seconds. */
export const JURISDICTION_CACHE_TTL_MS = 60_000;

const cacheKey = (stateCode: string): string => `jurisdiction:v1:${stateCode}`;

const cachedSchema = z.object({
  rule: z
    .object({
      stateCode: z.string().length(2),
      mode: z.enum(['S', 'P', 'X']),
      minAge: z.number().int(),
      scRedemptionEnabled: z.boolean(),
      fishGamesEnabled: z.boolean(),
      effectiveFrom: z.iso.datetime().transform((value) => new Date(value)),
    })
    .nullable(),
});

/** Collaborators for {@link JurisdictionService}. */
export interface JurisdictionServiceDeps {
  readonly pool: Pool;
  readonly redis: Redis;
  readonly audit: AuditWriter;
  readonly clock: Clock;
}

/**
 * Reads the jurisdiction table (spec §4.1) through a Redis cache. Entries live 60 seconds, or
 * until the next scheduled row takes effect if that is sooner, so a scheduled change starts on
 * time. A missing state is cached too, as "no rule", which the policy treats as blocked. Redis or
 * Postgres errors propagate, so gated actions fail closed with 503.
 */
export class JurisdictionService {
  constructor(private readonly deps: JurisdictionServiceDeps) {}

  /**
   * @param stateCode Two-letter state code.
   * @returns The rule in force now, or undefined when the state has none.
   */
  async ruleFor(stateCode: string): Promise<JurisdictionRule | undefined> {
    const key = cacheKey(stateCode);
    const cached = await this.deps.redis.get(key);
    if (cached !== null) {
      const parsed = cachedSchema.safeParse(JSON.parse(cached));
      if (parsed.success) return parsed.data.rule ?? undefined;
    }
    const now = this.deps.clock.now();
    const { rule, nextChangeAt } = await jurisdictionRepository.ruleAt(
      this.deps.pool,
      stateCode,
      now,
    );
    const untilChange =
      nextChangeAt === undefined ? Infinity : nextChangeAt.getTime() - now.getTime();
    const ttlMs = Math.max(1, Math.min(JURISDICTION_CACHE_TTL_MS, untilChange));
    await this.deps.redis.set(key, JSON.stringify({ rule: rule ?? null }), 'PX', ttlMs);
    return rule;
  }

  /**
   * Schedules a rule change (spec §4.1: changes take effect at a scheduled time, never mid-
   * session) and busts the cache. Only the Compliance role may call this; the admin route that
   * enforces it arrives in Step 9.
   *
   * @param rule The new rule and its legal memo.
   * @param actor The admin making the change, and their IP.
   * @throws ValidationError when `effectiveFrom` is not in the future.
   */
  async schedule(
    rule: NewJurisdictionRule,
    actor: { adminId: string; ip: string | null },
  ): Promise<void> {
    if (rule.effectiveFrom <= this.deps.clock.now()) {
      throw new ValidationError({
        issues: [{ path: 'effectiveFrom', message: 'must be in the future' }],
      });
    }
    await withTransaction(this.deps.pool, async (client) => {
      await jurisdictionRepository.insert(client, rule);
      await this.deps.audit.record(
        {
          actorType: 'admin',
          actorId: actor.adminId,
          action: 'compliance.jurisdiction.scheduled',
          targetType: 'jurisdiction',
          targetId: rule.stateCode,
          details: {
            mode: rule.mode,
            minAge: rule.minAge,
            scRedemptionEnabled: rule.scRedemptionEnabled,
            fishGamesEnabled: rule.fishGamesEnabled,
            effectiveFrom: rule.effectiveFrom.toISOString(),
            legalMemoRef: rule.legalMemoRef,
          },
          ip: actor.ip,
        },
        client,
      );
    });
    await this.invalidate(rule.stateCode);
  }

  /**
   * Drops a state's cached rule, so the next read goes to Postgres.
   *
   * @param stateCode Two-letter state code.
   */
  async invalidate(stateCode: string): Promise<void> {
    await this.deps.redis.del(cacheKey(stateCode));
  }
}
