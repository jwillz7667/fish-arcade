/**
 * `pnpm btc:fund <address> <btc>`: pays a regtest address from the dev wallet. It does not mine,
 * so the payment starts unconfirmed; run `pnpm btc:mine 1` to confirm it.
 */
import { formatBtc, parseBtc } from '@reef/money';
import { z } from 'zod';

import { parseAddress } from '../src/index.js';
import { connectRegtest, ensureNodeWallet, loadRegtestEnv, NODE_WALLET } from './regtest.js';

const [address = '', amount = ''] = process.argv.slice(2);
const env = loadRegtestEnv();
const destination = parseAddress(address, env.BITCOIN_NETWORK);
const sats = parseBtc(amount);
if (sats === 0n) {
  process.stderr.write('Usage: pnpm btc:fund <regtest address> <btc, above zero>\n');
  process.exit(1);
}
const rpc = await connectRegtest(env);
await ensureNodeWallet(rpc);
// bitcoind accepts amounts as decimal strings, so no float ever carries the value.
const txid = await rpc.call(
  z.string().regex(/^[0-9a-f]{64}$/),
  'sendtoaddress',
  [destination.address, formatBtc(sats).replace(' BTC', '').replaceAll(',', '')],
  NODE_WALLET,
);
process.stdout.write(`Sent ${formatBtc(sats)} to ${destination.address}: ${txid} (unconfirmed)\n`);
