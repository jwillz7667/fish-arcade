import { createHmac } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { btcpayInvoiceEventSchema, isValidBtcpaySignature } from './webhook.js';

const SECRET = 'webhook-secret-for-tests';
const BODY = Buffer.from('{"type":"InvoiceSettled","invoiceId":"inv-1"}');
const sign = (body: Buffer, secret = SECRET) =>
  `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;

describe('isValidBtcpaySignature', () => {
  it('accepts the HMAC of the exact body', () => {
    expect(isValidBtcpaySignature(BODY, sign(BODY), SECRET)).toBe(true);
  });

  it.each([
    ['no header', undefined],
    ['another secret', sign(BODY, 'other-secret')],
    ['another body', sign(Buffer.from('{}'))],
    ['a bare hex digest', createHmac('sha256', SECRET).update(BODY).digest('hex')],
    ['a short digest', 'sha256=abcd'],
    ['upper-case hex', sign(BODY).toUpperCase()],
  ])('refuses %s', (_label, header) => {
    expect(isValidBtcpaySignature(BODY, header, SECRET)).toBe(false);
  });
});

describe('btcpayInvoiceEventSchema', () => {
  it('keeps only the routing fields of an invoice event', () => {
    const event = btcpayInvoiceEventSchema.parse({
      deliveryId: 'd-1',
      webhookId: 'w-1',
      isRedelivery: false,
      type: 'InvoiceSettled',
      timestamp: 1_790_000_000,
      storeId: 's-1',
      invoiceId: 'inv-1',
      metadata: { orderId: 'o-1' },
      overPaid: true,
    });

    expect(event).toEqual({
      deliveryId: 'd-1',
      webhookId: 'w-1',
      isRedelivery: false,
      type: 'InvoiceSettled',
      timestamp: 1_790_000_000,
      storeId: 's-1',
      invoiceId: 'inv-1',
    });
  });
});
