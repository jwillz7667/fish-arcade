import { createHmac, timingSafeEqual } from 'node:crypto';

import { z } from 'zod';

const SIGNATURE_PATTERN = /^sha256=([0-9a-f]{64})$/;

/**
 * Checks BTCPay's `BTCPay-Sig` header: `sha256=` plus the hex HMAC-SHA256 of the raw body under
 * the webhook's secret. CLAUDE.md: never trust a webhook body; verify the signature, then
 * re-fetch the invoice before acting.
 *
 * @param rawBody The request body exactly as received.
 * @param header The `BTCPay-Sig` header, if any.
 * @param secret The webhook's secret.
 * @returns True only for a well-formed, matching signature. Compared in constant time.
 */
export function isValidBtcpaySignature(
  rawBody: Buffer,
  header: string | undefined,
  secret: string,
): boolean {
  const presented = SIGNATURE_PATTERN.exec(header ?? '')?.[1];
  if (presented === undefined) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  return timingSafeEqual(Buffer.from(presented, 'hex'), expected);
}

/**
 * The fields of a BTCPay invoice webhook the platform reads. Everything here is only a hint
 * about which invoice to re-fetch; amounts and status come from the API, never from this body.
 */
export const btcpayInvoiceEventSchema = z.object({
  deliveryId: z.string().min(1).max(128),
  webhookId: z.string().min(1).max(128),
  originalDeliveryId: z.string().min(1).max(128).optional(),
  isRedelivery: z.boolean(),
  type: z.string().min(1).max(64),
  timestamp: z.number().int().nonnegative(),
  storeId: z.string().min(1).max(128),
  invoiceId: z.string().min(1).max(128),
});

/** A parsed invoice webhook. */
export type BtcpayInvoiceEvent = z.infer<typeof btcpayInvoiceEventSchema>;
