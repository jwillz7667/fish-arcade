import type { Pool, PoolClient } from 'pg';

/** Anything that can run a parameterized query: the pool or a client inside a transaction. */
export type Queryable = Pick<Pool | PoolClient, 'query'>;

/** Who did something, as stored in `audit_logs.actor_type`. */
export type AuditActorType = 'player' | 'admin' | 'system';

/**
 * One audit event. `details` holds record IDs and outcomes only: never emails, phone numbers,
 * codes, tokens, or other PII (CLAUDE.md).
 */
export interface AuditEvent {
  readonly actorType: AuditActorType;
  /** Acting user or admin ID; null when the actor is not known, such as a failed login. */
  readonly actorId: string | null;
  /** Dotted action name, such as `auth.login.succeeded`. */
  readonly action: string;
  readonly targetType?: string;
  readonly targetId?: string;
  readonly details?: Readonly<Record<string, string | number | boolean | null>>;
  /** For admin writes: changed fields before and after, with PII already masked. */
  readonly diff?: { readonly before: unknown; readonly after: unknown };
  /** Client IP as seen by the API (after TRUST_PROXY_HOPS). */
  readonly ip: string | null;
}

/** Appends rows to `audit_logs`, which is append-only at the database level. */
export class AuditWriter {
  constructor(private readonly pool: Pool) {}

  /**
   * Records an event. Pass a transaction client to commit the event with the change it
   * describes. Failures propagate: an auth action whose audit row cannot be written fails.
   *
   * @param event What happened.
   * @param client Transaction client; defaults to the pool.
   */
  async record(event: AuditEvent, client: Queryable = this.pool): Promise<void> {
    const after: unknown = event.diff === undefined ? event.details : event.diff.after;
    await client.query(
      `INSERT INTO audit_logs
         (actor_type, actor_id, action, target_type, target_id, before, after, ip)
       VALUES ($1::"ActorType", $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8::inet)`,
      [
        event.actorType,
        event.actorId,
        event.action,
        event.targetType ?? null,
        event.targetId ?? null,
        event.diff === undefined ? null : JSON.stringify(event.diff.before),
        after === undefined ? null : JSON.stringify(after),
        event.ip,
      ],
    );
  }
}
