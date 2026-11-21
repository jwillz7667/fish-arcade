/** `pnpm btc:mine <n>`: mines n regtest blocks to the dev wallet. */
import { connectRegtest, ensureNodeWallet, loadRegtestEnv, mineBlocks } from './regtest.js';

const count = Number.parseInt(process.argv[2] ?? '1', 10);
if (!Number.isInteger(count) || count < 1 || count > 1_000) {
  process.stderr.write('Usage: pnpm btc:mine <blocks, 1 to 1000>\n');
  process.exit(1);
}
const rpc = await connectRegtest(loadRegtestEnv());
await ensureNodeWallet(rpc);
process.stdout.write(
  `Mined ${String(count)} block(s); height ${String(await mineBlocks(rpc, count))}\n`,
);
