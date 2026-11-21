import { DependencyUnavailableError, ErrorCode, NotFoundError } from '@reef/errors';
import { cents } from '@reef/money';
import { describe, expect, it, vi } from 'vitest';

import { GreenfieldClient } from './greenfield-client.js';

const urlOf = (input: unknown): string =>
  input instanceof URL ? input.href : typeof input === 'string' ? input : '';
const bodyOf = (init: RequestInit | undefined): unknown =>
  typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;

const INVOICE = {
  id: 'inv-1',
  storeId: 'store-1',
  status: 'New',
  additionalStatus: 'None',
  amount: '19.99',
  currency: 'USD',
  checkoutLink: 'http://127.0.0.1:14142/i/inv-1',
  expirationTime: 1_790_000_900,
};

function reply(body: unknown, status = 200) {
  return vi.fn<typeof fetch>(() =>
    Promise.resolve(
      body === undefined
        ? new Response(null, { status })
        : new Response(JSON.stringify(body), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
    ),
  );
}

const client = (fetchFn: typeof fetch, auth: 'apiKey' | 'basic' = 'apiKey') =>
  new GreenfieldClient(
    {
      baseUrl: 'http://btcpay.test',
      auth:
        auth === 'apiKey'
          ? { kind: 'apiKey', apiKey: 'key-1' }
          : { kind: 'basic', email: 'a@b.c', password: 'pw' },
    },
    fetchFn,
  );

describe('GreenfieldClient', () => {
  it('creates a USD invoice payable on-chain only, with the order reference', async () => {
    const fetchFn = reply(INVOICE);

    const invoice = await client(fetchFn).createInvoice('store-1', {
      amount: cents(1_999n),
      orderId: 'o-1',
    });

    const [url, init] = fetchFn.mock.calls[0] ?? [];
    expect(urlOf(url)).toBe('http://btcpay.test/api/v1/stores/store-1/invoices');
    expect(bodyOf(init)).toEqual({
      amount: '19.99',
      currency: 'USD',
      metadata: { orderId: 'o-1' },
      checkout: { paymentMethods: ['BTC-CHAIN'] },
    });
    expect(new Headers(init?.headers).get('authorization')).toBe('token key-1');
    expect(invoice.id).toBe('inv-1');
  });

  it('pads cents when pricing an invoice', async () => {
    const fetchFn = reply(INVOICE);

    await client(fetchFn).createInvoice('store-1', { amount: cents(500n), orderId: 'o-2' });

    expect(bodyOf(fetchFn.mock.calls[0]?.[1])).toMatchObject({ amount: '5.00' });
  });

  it('reads the on-chain amounts in satoshis, including a negative due when overpaid', async () => {
    const fetchFn = reply([
      {
        paymentMethodId: 'BTC-LN',
        destination: 'lnbc1',
        rate: '50000',
        amount: '0.0004',
        paymentMethodPaid: '0',
        due: '0.0004',
      },
      {
        paymentMethodId: 'BTC-CHAIN',
        destination: 'bcrt1qx',
        rate: '57801.8',
        amount: '0.00039980',
        paymentMethodPaid: '0.0005',
        due: '-0.0000102',
      },
    ]);

    const payment = await client(fetchFn).getOnChainPayment('inv-1');

    expect(payment).toEqual({
      destination: 'bcrt1qx',
      amount: 39_980n,
      paid: 50_000n,
      due: -1_020n,
      rate: 5_780_180n,
    });
  });

  it('reports an invoice without an on-chain method as not found', async () => {
    await expect(client(reply([])).getOnChainPayment('inv-1')).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it('authenticates bootstrap calls with the admin password', async () => {
    const fetchFn = reply({ id: 'store-1', name: 'Reef' });

    await client(fetchFn, 'basic').createStore({
      name: 'Reef',
      speedPolicy: 'MediumSpeed',
      invoiceExpirationSeconds: 900,
    });

    const init = fetchFn.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get('authorization')).toBe(
      `Basic ${Buffer.from('a@b.c:pw').toString('base64')}`,
    );
    expect(bodyOf(init)).toMatchObject({
      defaultCurrency: 'USD',
      speedPolicy: 'MediumSpeed',
      paymentTolerance: 0,
    });
  });

  it('returns undefined for a missing store and the store when it exists', async () => {
    expect(await client(reply({ error: 'not found' }, 404)).findStore('gone')).toBeUndefined();
    expect(await client(reply({ id: 's-1', name: 'Reef' })).findStore('s-1')).toEqual({
      id: 's-1',
      name: 'Reef',
    });
  });

  it('sends wallet, rate, webhook, and key setup to the documented endpoints', async () => {
    const fetchFn = reply({
      id: 'w-1',
      url: 'http://hook',
      secret: 's',
      apiKey: 'k',
      addresses: [{ keyPath: '0/0', address: 'bcrt1q' }],
    });
    const btcpay = client(fetchFn, 'basic');

    await btcpay.setOnChainWallet('s-1', '2-of-a-b-c', 'cold');
    await btcpay.setRateScript('s-1', 'BTC_USD = 50000;');
    await btcpay.setPreferredRateSource('s-1', 'kraken');
    await btcpay.createWebhook('s-1', { url: 'http://hook', secret: 's' });
    await btcpay.createApiKey('reef', ['btcpay.store.canviewinvoices:s-1']);
    expect(await btcpay.previewReceiveAddresses('s-1', 1)).toEqual(['bcrt1q']);

    expect(
      fetchFn.mock.calls.map(
        ([url, init]) => `${String(init?.method)} ${new URL(urlOf(url)).pathname}`,
      ),
    ).toEqual([
      'PUT /api/v1/stores/s-1/payment-methods/BTC-CHAIN',
      'PUT /api/v1/stores/s-1/rates/configuration/primary',
      'PUT /api/v1/stores/s-1/rates/configuration/primary',
      'POST /api/v1/stores/s-1/webhooks',
      'POST /api/v1/api-keys',
      'GET /api/v1/stores/s-1/payment-methods/BTC-CHAIN/wallet/preview',
    ]);
  });

  it('lists and deletes webhooks and reads health', async () => {
    expect(await client(reply([{ id: 'w-1', url: 'http://hook' }])).listWebhooks('s-1')).toEqual([
      { id: 'w-1', url: 'http://hook' },
    ]);
    await expect(client(reply(undefined, 204)).deleteWebhook('w-1')).resolves.toBeUndefined();
    expect(await client(reply({ synchronized: true })).health()).toEqual({ synchronized: true });
  });

  it('re-reads an invoice from the API', async () => {
    const fetchFn = reply({ ...INVOICE, status: 'Settled' });

    expect((await client(fetchFn).getInvoice('inv-1')).status).toBe('Settled');
    expect(urlOf(fetchFn.mock.calls[0]?.[0])).toBe('http://btcpay.test/api/v1/invoices/inv-1');
  });

  it.each([
    ['a 500', reply({ error: 'boom' }, 500)],
    ['an unexpected body', reply({ id: 7 })],
    [
      'a non-amount',
      reply([
        {
          paymentMethodId: 'BTC-CHAIN',
          destination: 'x',
          rate: '50000',
          amount: '1e-8',
          paymentMethodPaid: '0',
          due: '0',
        },
      ]),
    ],
    [
      'invalid JSON',
      vi.fn<typeof fetch>(() => Promise.resolve(new Response('not json', { status: 200 }))),
    ],
    ['a network error', vi.fn<typeof fetch>(() => Promise.reject(new Error('ECONNREFUSED')))],
  ])('fails closed on %s', async (_label, fetchFn) => {
    const call =
      _label === 'a non-amount'
        ? client(fetchFn).getOnChainPayment('i')
        : client(fetchFn).getInvoice('i');

    await expect(call).rejects.toMatchObject({ code: ErrorCode.DEPENDENCY_UNAVAILABLE });
    await expect(call).rejects.toBeInstanceOf(DependencyUnavailableError);
  });

  it('reports a missing invoice as not found', async () => {
    await expect(client(reply({}, 404)).getInvoice('gone')).rejects.toBeInstanceOf(NotFoundError);
  });
});
