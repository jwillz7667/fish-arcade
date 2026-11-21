/**
 * Regtest bootstrap (playbook Step 10). Idempotent: run it after every `pnpm btc:up`.
 *
 * 1. Proves bitcoind is a regtest node, loads the dev wallet, and mines spendable coins.
 * 2. Makes three throwaway regtest cosigner keys in .keys/regtest/ (gitignored). Their private
 *    halves never leave that file and are never printed.
 * 3. Creates the BTCPay admin (and an admin API key), a store with a 1-confirmation policy and 15-minute invoices, a
 *    fixed regtest exchange rate, the watch-only 2-of-3 wallet, a store-scoped API key, and a
 *    webhook to the API.
 * 4. Checks that BTCPay, Bitcoin Core, and this repo derive the same first receive address.
 *
 * Production keys are made by people on hardware wallets: docs/runbooks/key-ceremony.md.
 */
import { randomBytes } from 'node:crypto';

import { HDKey } from '@scure/bip32';
import { z } from 'zod';

import {
  extendedKeyVersions,
  GreenfieldClient,
  multisigAccountPath,
  multisigAddress,
  multisigDescriptor,
  nbxplorerDerivationScheme,
  type Cosigner,
} from '../src/index.js';
import {
  connectRegtest,
  ensureNodeWallet,
  loadRegtestEnv,
  mineBlocks,
  NODE_WALLET,
  readKeysFile,
  writeKeysFile,
  type RegtestEnv,
} from './regtest.js';

const COSIGNERS_FILE = 'cosigners.json';
const BTCPAY_FILE = 'btcpay.json';
const ADMIN_EMAIL = 'admin@reef.local';
// Spec §22.2: an invoice holds its BTC amount for 15 minutes.
const INVOICE_EXPIRATION_SECONDS = 15 * 60;
// Regtest has no exchanges, so the rate is fixed: integer dollars per BTC.
const REGTEST_RATE_SCRIPT = 'BTC_USD = 50000;';

const cosignerFileSchema = z.array(
  z.object({ fingerprint: z.string(), path: z.string(), xpub: z.string(), xprv: z.string() }),
);

const btcpayFileSchema = z.object({
  adminEmail: z.string(),
  adminPassword: z.string(),
  adminApiKey: z.string(),
  storeId: z.string().optional(),
  apiKey: z.string().optional(),
  webhookId: z.string().optional(),
  webhookSecret: z.string().optional(),
});
type BtcpayState = z.infer<typeof btcpayFileSchema>;

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function cosignersFromFile(): Cosigner[] {
  const existing = readKeysFile(COSIGNERS_FILE, cosignerFileSchema);
  if (existing !== undefined) {
    return existing.map(({ fingerprint, path, xpub }) => ({ fingerprint, path, xpub }));
  }
  const versions = extendedKeyVersions('regtest');
  const path = multisigAccountPath('regtest');
  const generated = [0, 1, 2].map(() => {
    const master = HDKey.fromMasterSeed(randomBytes(32), versions);
    const account = master.derive(path.replaceAll('h', "'"));
    return {
      fingerprint: master.fingerprint.toString(16).padStart(8, '0'),
      path,
      xpub: account.publicExtendedKey,
      xprv: account.privateExtendedKey,
    };
  });
  writeKeysFile(COSIGNERS_FILE, generated);
  log(`Wrote 3 throwaway regtest cosigner keys to .keys/regtest/${COSIGNERS_FILE}`);
  return generated.map(({ fingerprint, path: keyPath, xpub }) => ({
    fingerprint,
    path: keyPath,
    xpub,
  }));
}

async function waitForBtcpay(btcpay: GreenfieldClient): Promise<void> {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      if ((await btcpay.health()).synchronized) return;
    } catch {
      // Still starting; retry below.
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error('BTCPay did not become ready within 2 minutes');
}

async function ensureAdmin(env: RegtestEnv, anonymous: GreenfieldClient): Promise<BtcpayState> {
  const existing = readKeysFile(BTCPAY_FILE, btcpayFileSchema);
  if (existing !== undefined) return existing;
  const password = randomBytes(24).toString('base64url');
  try {
    await anonymous.createFirstAdmin(ADMIN_EMAIL, password);
  } catch (error) {
    throw new Error(
      `BTCPay refused to create the admin. It already has users but .keys/regtest/${BTCPAY_FILE} ` +
        'is missing or stale: run pnpm btc:reset',
      { cause: error },
    );
  }
  // BTCPay accepts the password for the Greenfield API only in the account's first five
  // minutes, so trade it for an admin API key straight away.
  const adminApiKey = await new GreenfieldClient({
    baseUrl: env.BTCPAY_URL,
    auth: { kind: 'basic', email: ADMIN_EMAIL, password },
  }).createApiKey('reef-bootstrap (regtest)', ['unrestricted']);
  const state = { adminEmail: ADMIN_EMAIL, adminPassword: password, adminApiKey };
  writeKeysFile(BTCPAY_FILE, state);
  return state;
}

async function main(): Promise<void> {
  const env = loadRegtestEnv();
  const rpc = await connectRegtest(env);
  await ensureNodeWallet(rpc);
  const balance = await rpc.call(z.number(), 'getbalance', [], NODE_WALLET);
  if (balance < 1) log(`Mined to height ${String(await mineBlocks(rpc, 101))} for spendable coins`);

  const cosigners = cosignersFromFile();
  const scheme = nbxplorerDerivationScheme(cosigners, 'regtest');
  const receiveDescriptor = multisigDescriptor(cosigners, 0, 'regtest');

  const anonymous = new GreenfieldClient({ baseUrl: env.BTCPAY_URL, auth: { kind: 'none' } });
  await waitForBtcpay(anonymous);
  const state = await ensureAdmin(env, anonymous);
  const btcpay = new GreenfieldClient({
    baseUrl: env.BTCPAY_URL,
    auth: { kind: 'apiKey', apiKey: state.adminApiKey },
  });

  const store =
    (state.storeId === undefined ? undefined : await btcpay.findStore(state.storeId)) ??
    (await btcpay.createStore({
      name: 'Reef regtest',
      // Spec §22.2: Gold Coins credit at 1 confirmation, never 0-conf.
      speedPolicy: 'MediumSpeed',
      invoiceExpirationSeconds: INVOICE_EXPIRATION_SECONDS,
    }));
  await btcpay.setRateScript(store.id, REGTEST_RATE_SCRIPT);
  await btcpay.setOnChainWallet(store.id, scheme, 'Reef cold multisig (regtest, watch-only)');

  const [btcpayFirst] = await btcpay.previewReceiveAddresses(store.id, 1);
  const [coreFirst] = await rpc.call(z.array(z.string()), 'deriveaddresses', [
    receiveDescriptor,
    [0, 0],
  ]);
  const oursFirst = multisigAddress(cosigners, 0, 0, 'regtest');
  if (btcpayFirst !== oursFirst || coreFirst !== oursFirst) {
    throw new Error(
      'BTCPay, Bitcoin Core, and @reef/bitcoin disagree on the first receive address',
    );
  }

  const apiKey =
    state.storeId === store.id && state.apiKey !== undefined
      ? state.apiKey
      : await btcpay.createApiKey('reef-api (regtest)', [
          `btcpay.store.cancreateinvoice:${store.id}`,
          `btcpay.store.canviewinvoices:${store.id}`,
          `btcpay.store.canviewstoresettings:${store.id}`,
          `btcpay.store.webhooks.canmodifywebhooks:${store.id}`,
        ]);

  const webhooks = await btcpay.listWebhooks(store.id);
  const isCurrent = webhooks.some(
    (webhook) => webhook.id === state.webhookId && webhook.url === env.BTCPAY_WEBHOOK_URL,
  );
  let webhook: { id: string; secret: string };
  if (isCurrent && state.webhookId !== undefined && state.webhookSecret !== undefined) {
    webhook = { id: state.webhookId, secret: state.webhookSecret };
  } else {
    const secret = randomBytes(32).toString('hex');
    webhook = {
      id: (await btcpay.createWebhook(store.id, { url: env.BTCPAY_WEBHOOK_URL, secret })).id,
      secret,
    };
  }

  writeKeysFile(BTCPAY_FILE, {
    ...state,
    storeId: store.id,
    apiKey,
    webhookId: webhook.id,
    webhookSecret: webhook.secret,
  });

  log('BTCPay regtest is ready.');
  log(`  Store:             ${store.id}`);
  log(`  Webhook:           ${env.BTCPAY_WEBHOOK_URL}`);
  log(`  First address:     ${oursFirst} (BTCPay, Bitcoin Core, and this repo agree)`);
  log(`  Watch-only wallet: ${receiveDescriptor}`);
  log(`  API key and webhook secret: .keys/regtest/${BTCPAY_FILE}`);
}

await main();
