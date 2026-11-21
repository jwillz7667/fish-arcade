import type { Redis } from 'ioredis';
import type { z } from 'zod';

import { randomToken, sha256Hex } from '../crypto/secrets.js';

/**
 * Short-lived, single-use bearer tickets in Redis: signup tickets after OTP verification,
 * MFA tickets between password and second factor. Keys hold the SHA-256 of the ticket, so a
 * Redis dump cannot be replayed. Values are re-validated with zod on every read.
 */
export class TicketStore<T> {
  constructor(
    private readonly redis: Redis,
    private readonly namespace: string,
    private readonly schema: z.ZodType<T>,
    private readonly ttlSeconds: number,
  ) {}

  /**
   * @param data What the ticket stands for. IDs only; no PII.
   * @returns The opaque ticket to hand to the client.
   */
  async issue(data: T): Promise<string> {
    const ticket = randomToken();
    await this.redis.set(this.#key(ticket), JSON.stringify(data), 'EX', this.ttlSeconds);
    return ticket;
  }

  /**
   * @param ticket Ticket from the client.
   * @returns Its data, without consuming it, or undefined when unknown or expired.
   */
  async peek(ticket: string): Promise<T | undefined> {
    return this.#parse(await this.redis.get(this.#key(ticket)));
  }

  /**
   * Consumes a ticket atomically; a second call with the same ticket gets undefined.
   *
   * @param ticket Ticket from the client.
   * @returns Its data, or undefined when unknown, expired, or already taken.
   */
  async take(ticket: string): Promise<T | undefined> {
    const key = this.#key(ticket);
    const [value] = await Promise.all([this.redis.getdel(key), this.redis.del(`${key}:n`)]);
    return this.#parse(value);
  }

  /**
   * Replaces a ticket's data and keeps its expiry. Does nothing for an unknown ticket.
   *
   * @param ticket Ticket from the client.
   * @param data New data.
   * @returns True when the ticket existed.
   */
  async replace(ticket: string, data: T): Promise<boolean> {
    const result = await this.redis.set(this.#key(ticket), JSON.stringify(data), 'KEEPTTL', 'XX');
    return result === 'OK';
  }

  /**
   * Counts one attempt against a ticket.
   *
   * @param ticket Ticket from the client.
   * @returns Attempts so far, including this one.
   */
  async countAttempt(ticket: string): Promise<number> {
    const key = `${this.#key(ticket)}:n`;
    const count = await this.redis.incr(key);
    await this.redis.expire(key, this.ttlSeconds);
    return count;
  }

  /**
   * Ends a ticket without reading it.
   *
   * @param ticket Ticket from the client.
   */
  async revoke(ticket: string): Promise<void> {
    const key = this.#key(ticket);
    await this.redis.del(key, `${key}:n`);
  }

  #key(ticket: string): string {
    return `auth:v1:${this.namespace}:${sha256Hex(ticket)}`;
  }

  #parse(value: string | null): T | undefined {
    if (value === null) return undefined;
    const parsed = this.schema.safeParse(JSON.parse(value));
    return parsed.success ? parsed.data : undefined;
  }
}
