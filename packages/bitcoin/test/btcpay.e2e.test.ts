import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fileURLToPath } from 'node:url';

import { cents, formatBtc } from '@reef/money';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  btcpayInvoiceEventSchema,
  GreenfieldClient,
  isValidBtcpaySignature,
  multisigAddress,
  parseAddress,
  type BitcoindRpc,
  type InvoiceStatus,
} from '../src/index.js';
import {
  connectRegtest,
  ensureNodeWallet,
  loadRegtestEnv,
  mineBlocks,
  NODE_WALLET,
  readKeysFile,
} from '../scripts/regtest.js';

const ENV_FILE = fileURLToPath(new URL('../../../.env', import.meta.url));
if (existsSync(ENV_FILE)) process.loadEnvFile(ENV_FILE);

// BTCPay reaches this receiver on the host. Docker Desktop forwards host.docker.internal to the
// host's loopback; on Linux CI set BTC_TEST_WEBHOOK_BIND=0.0.0.0.
const BIND = process.env['BTC_TEST_WEBHOOK_BIND'] ?? '127.0.0.1';

const stateSchema = z.object({ storeId: z.string(), apiKey: z.string() });
const cosignersSchema = z.array(
  z.object({ fingerprint: z.string(), path: z.string(), xpub: z.string() }),
);

interface Delivery {
  readonly raw: Buffer;
  readonly signature: string | undefined;
}

let rpc: BitcoindRpc;
let btcpay: GreenfieldClient;
let storeId: string;
let server: Server;
let webhook: { id: string; secret: string } | undefined;
const deliveries: Delivery[] = [];

async function waitFor<T>(
  what: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 90_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

const statusOf = async (invoiceId: string): Promise<InvoiceStatus> =>
  (await btcpay.getInvoice(invoiceId)).status;

beforeAll(async () => {
  const env = loadRegtestEnv();
  const state = readKeysFile('btcpay.json', stateSchema);
  if (state === undefined) throw new Error('Run pnpm btc:up first');
  rpc = await connectRegtest(env);
  await ensureNodeWallet(rpc);
  storeId = state.storeId;
  btcpay = new GreenfieldClient({
    baseUrl: env.BTCPAY_URL,
    auth: { kind: 'apiKey', apiKey: state.apiKey },
  });

  server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const header = request.headers['btcpay-sig'];
      deliveries.push({
        raw: Buffer.concat(chunks),
        signature: typeof header === 'string' ? header : undefined,
      });
      response.writeHead(200).end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, BIND, resolve));
  const { port } = server.address() as AddressInfo;
  const secret = randomBytes(32).toString('hex');
  const created = await btcpay.createWebhook(storeId, {
    url: `http://host.docker.internal:${String(port)}/btcpay`,
    secret,
  });
  webhook = { id: created.id, secret };
});

afterAll(async () => {
  if (webhook !== undefined) await btcpay.deleteWebhook(webhook.id);
  await new Promise((resolve) => server.close(resolve));
});

describe('BTCPay on regtest (playbook Step 10)', () => {
  it('pays an invoice into the cold multisig, settles it only after a confirmation, and sends a verified webhook', async () => {
    if (webhook === undefined) throw new Error('The test webhook was not registered');
    const { secret } = webhook;
    const cosigners = readKeysFile('cosigners.json', cosignersSchema) ?? [];
    const invoice = await btcpay.createInvoice(storeId, {
      amount: cents(2_500n),
      orderId: randomUUID(),
    });
    const payment = await btcpay.getOnChainPayment(invoice.id);

    // The deposit address is one of the watch-only multisig's own addresses.
    const destination = parseAddress(payment.destination, 'regtest');
    const ours = Array.from({ length: 50 }, (_, index) =>
      multisigAddress(cosigners, 0, index, 'regtest'),
    );
    expect(destination.type).toBe('wsh');
    expect(ours).toContain(destination.address);
    // $25 at the fixed regtest rate of $50,000 per BTC, the same rate the dev oracle reports.
    expect(payment.amount).toBe(50_000n);
    expect(payment.rate).toBe(5_000_000n);

    await rpc.call(
      z.string(),
      'sendtoaddress',
      [destination.address, formatBtc(payment.amount).replace(' BTC', '')],
      NODE_WALLET,
    );
    // Spec §22.2: an unconfirmed payment is seen but never settles.
    await waitFor('the payment in the mempool', async () =>
      (await statusOf(invoice.id)) === 'Processing' ? true : undefined,
    );
    expect(await statusOf(invoice.id)).toBe('Processing');

    await mineBlocks(rpc, 1);
    const settled = await waitFor('a settled webhook', () => {
      const match = deliveries.find((delivery) => {
        const event = btcpayInvoiceEventSchema.safeParse(JSON.parse(delivery.raw.toString('utf8')));
        return (
          event.success &&
          event.data.invoiceId === invoice.id &&
          event.data.type === 'InvoiceSettled'
        );
      });
      return Promise.resolve(match);
    });

    expect(isValidBtcpaySignature(settled.raw, settled.signature, secret)).toBe(true);
    expect(isValidBtcpaySignature(settled.raw, settled.signature, 'some-other-secret')).toBe(false);
    // Never trust the body: the API re-fetches the invoice before acting on it.
    expect(await statusOf(invoice.id)).toBe('Settled');
  });

  it('leaves an unpaid invoice unsettled', async () => {
    const invoice = await btcpay.createInvoice(storeId, {
      amount: cents(500n),
      orderId: randomUUID(),
    });

    await mineBlocks(rpc, 1);

    expect(await statusOf(invoice.id)).toBe('New');
  });
});
