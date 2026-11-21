import { createHmac, timingSafeEqual } from 'node:crypto';

/** Playbook Step 8: webhook timestamps older than 5 minutes are rejected. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;

const HEADER = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/;

/** Why a signature was refused. */
export type SignatureProblem = 'malformed' | 'stale' | 'mismatch';

const digest = (secret: string, timestamp: string, rawBody: Buffer): Buffer =>
  createHmac('sha256', secret).update(`${timestamp}.`, 'utf8').update(rawBody).digest();

/**
 * Signs a webhook body: `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`. Binding the time
 * into the MAC stops an attacker replaying an old body with a fresh timestamp.
 *
 * @param secret Shared webhook secret.
 * @param rawBody Exact bytes sent.
 * @param at Signing time.
 * @returns The signature header value.
 */
export function signWebhook(secret: string, rawBody: Buffer, at: Date): string {
  const timestamp = String(Math.floor(at.getTime() / 1000));
  return `t=${timestamp},v1=${digest(secret, timestamp, rawBody).toString('hex')}`;
}

/**
 * Verifies a webhook signature with `timingSafeEqual`, and that its timestamp is within 5
 * minutes of now in either direction.
 *
 * @param input Secret, header value, exact raw body, and the current time.
 * @returns Undefined when valid, otherwise why not.
 */
export function webhookSignatureProblem(input: {
  secret: string;
  header: string | undefined;
  rawBody: Buffer;
  now: Date;
}): SignatureProblem | undefined {
  const [, timestamp, mac] = HEADER.exec(input.header ?? '') ?? [];
  if (timestamp === undefined || mac === undefined) return 'malformed';
  const ageSeconds = Math.abs(input.now.getTime() / 1000 - Number.parseInt(timestamp, 10));
  if (ageSeconds > WEBHOOK_TOLERANCE_SECONDS) return 'stale';
  const expected = digest(input.secret, timestamp, input.rawBody);
  return timingSafeEqual(Buffer.from(mac, 'hex'), expected) ? undefined : 'mismatch';
}
