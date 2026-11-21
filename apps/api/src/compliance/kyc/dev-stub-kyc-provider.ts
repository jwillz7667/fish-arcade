import { randomUUID } from 'node:crypto';

import { AuthError, DependencyUnavailableError } from '@reef/errors';
import type { Redis } from 'ioredis';
import { z } from 'zod';

import { randomToken } from '../../auth/crypto/secrets.js';
import type {
  KycProvider,
  KycResult,
  KycSession,
  KycWebhookEvent,
  KycWebhookRequest,
} from './kyc-provider.js';
import type { KycLevel, KycStatus } from './kyc-status.js';
import { signWebhook, webhookSignatureProblem } from './webhook-signature.js';

/** Outcomes a test or developer can script for a check (playbook Step 8). */
export type ScriptedKycOutcome = 'passed' | 'failed' | 'review' | 'sanctions_hit';

const SESSION_TTL_SECONDS = 7 * 86_400;
const sessionKey = (vendorRef: string): string => `kyc:dev:v1:${vendorRef}`;

const storedSchema = z.object({
  status: z.enum(['pending', 'passed', 'failed', 'review', 'sanctions_hit']),
  reasons: z.array(z.string()),
});

const eventSchema = z.object({
  id: z.string().min(1).max(128),
  type: z.literal('check.updated'),
  data: z.object({ reference: z.string().min(1).max(128) }),
});

function reasonsFor(outcome: ScriptedKycOutcome): string[] {
  switch (outcome) {
    case 'passed':
      return [];
    case 'failed':
      return ['document_unreadable'];
    case 'review':
      return ['manual_review'];
    case 'sanctions_hit':
      return ['sanctions_match'];
  }
}

/**
 * Development KYC vendor. Webhooks carry `X-Reef-Kyc-Signature`. Sessions and their scripted outcomes live in Redis; `script()` sets an
 * outcome and returns a webhook signed exactly as a vendor would sign it, for tests to deliver.
 * Config rejects this provider in production.
 */
export class DevStubKycProvider implements KycProvider {
  readonly name = 'dev_stub';

  constructor(
    private readonly redis: Redis,
    private readonly webhookSecret: string,
  ) {}

  /**
   * @param input The account and level; the stub records nothing about the person.
   * @returns A pending session.
   */
  async createSession(input: { userId: string; level: KycLevel }): Promise<KycSession> {
    const vendorRef = `dev_${input.level}_${randomUUID()}`;
    await this.#store(vendorRef, { status: 'pending', reasons: [] });
    return {
      vendorRef,
      sdkToken: randomToken(),
      expiresAt: new Date(Date.now() + 30 * 60_000),
    };
  }

  /**
   * @param vendorRef The check.
   * @returns Its scripted verdict.
   * @throws DependencyUnavailableError when the stub has no such check.
   */
  async getResult(vendorRef: string): Promise<KycResult> {
    const stored = await this.redis.get(sessionKey(vendorRef));
    const parsed = stored === null ? undefined : storedSchema.safeParse(JSON.parse(stored));
    if (parsed?.success !== true) {
      throw new DependencyUnavailableError({ dependency: 'kyc', message: 'Unknown dev KYC check' });
    }
    return parsed.data;
  }

  /**
   * @param request Headers, raw body, and now.
   * @returns The event ID and check reference from the verified body.
   * @throws AuthError when the signature is malformed, wrong, or stale, or the body is not an
   *   event.
   */
  verifyWebhook(request: KycWebhookRequest): KycWebhookEvent {
    const header = request.headers['x-reef-kyc-signature'];
    const problem = webhookSignatureProblem({
      secret: this.webhookSecret,
      header: typeof header === 'string' ? header : undefined,
      rawBody: request.rawBody,
      now: request.now,
    });
    if (problem !== undefined) throw new AuthError({ message: `KYC webhook signature ${problem}` });
    let body: unknown;
    try {
      body = JSON.parse(request.rawBody.toString('utf8'));
    } catch (error) {
      throw new AuthError({ message: 'KYC webhook body is not JSON', cause: error });
    }
    const event = eventSchema.safeParse(body);
    if (!event.success) throw new AuthError({ message: 'KYC webhook body is not an event' });
    return { eventId: event.data.id, vendorRef: event.data.data.reference };
  }

  /**
   * Scripts a check's outcome, as the vendor would after the player finishes the SDK flow.
   *
   * @param vendorRef The check.
   * @param outcome The verdict to report from now on.
   * @param at When the vendor "sends" the webhook.
   * @returns A webhook body and signature to deliver to `POST /v1/webhooks/kyc`.
   */
  async script(
    vendorRef: string,
    outcome: ScriptedKycOutcome,
    at: Date = new Date(),
  ): Promise<{ eventId: string; rawBody: string; signature: string }> {
    await this.#store(vendorRef, { status: outcome, reasons: reasonsFor(outcome) });
    const eventId = `evt_${randomUUID()}`;
    const rawBody = JSON.stringify({
      id: eventId,
      type: 'check.updated',
      data: { reference: vendorRef },
    });
    return {
      eventId,
      rawBody,
      signature: signWebhook(this.webhookSecret, Buffer.from(rawBody), at),
    };
  }

  async #store(vendorRef: string, value: { status: KycStatus; reasons: string[] }): Promise<void> {
    await this.redis.set(sessionKey(vendorRef), JSON.stringify(value), 'EX', SESSION_TTL_SECONDS);
  }
}
