import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { z } from 'zod';

import { BitcoindRpc, BitcoindRpcError } from '../src/index.js';

/** Gitignored folder for regtest-only key material and credentials (CLAUDE.md). */
export const KEYS_DIR = fileURLToPath(new URL('../../../.keys/regtest/', import.meta.url));

/** The bitcoind wallet that mines and pays in development. */
export const NODE_WALLET = 'reef-dev';

const envSchema = z.object({
  // These scripts make keys and mine blocks, so they refuse any network but regtest.
  BITCOIN_NETWORK: z.literal('regtest'),
  BTC_RPC_URL: z.url().default('http://127.0.0.1:43782'),
  BTC_RPC_USER: z.string().min(1),
  BTC_RPC_PASSWORD: z.string().min(1),
  BTCPAY_URL: z.url(),
  BTCPAY_WEBHOOK_URL: z.url(),
});

/** Settings the regtest tooling reads from `.env`. */
export type RegtestEnv = z.infer<typeof envSchema>;

/**
 * @returns The validated settings. Exits with the names (never the values) of bad variables.
 */
export function loadRegtestEnv(): RegtestEnv {
  const parsed = envSchema.safeParse(process.env);
  if (parsed.success) return parsed.data;
  const names = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.')))];
  process.stderr.write(`Regtest tooling needs these settings in .env: ${names.join(', ')}\n`);
  process.exit(1);
}

/**
 * Connects to bitcoind and proves it is a regtest node before anything else happens.
 *
 * @param env Settings.
 * @returns An RPC client.
 * @throws Error when the node is on any other chain.
 */
export async function connectRegtest(env: RegtestEnv): Promise<BitcoindRpc> {
  const rpc = new BitcoindRpc({
    url: env.BTC_RPC_URL,
    user: env.BTC_RPC_USER,
    password: env.BTC_RPC_PASSWORD,
  });
  const info = await rpc.call(z.object({ chain: z.string() }), 'getblockchaininfo');
  if (info.chain !== 'regtest') {
    throw new Error(`bitcoind reports chain "${info.chain}"; regtest tooling refuses to run`);
  }
  return rpc;
}

/**
 * Loads the development wallet, creating it on first use.
 *
 * @param rpc Regtest node.
 */
export async function ensureNodeWallet(rpc: BitcoindRpc): Promise<void> {
  const loaded = await rpc.call(z.array(z.string()), 'listwallets');
  if (loaded.includes(NODE_WALLET)) return;
  try {
    await rpc.call(z.unknown(), 'loadwallet', [NODE_WALLET]);
  } catch (error) {
    // -18: no such wallet yet. Anything else is a real failure.
    if (!(error instanceof BitcoindRpcError) || error.code !== -18) throw error;
    await rpc.call(z.unknown(), 'createwallet', [NODE_WALLET]);
  }
}

/**
 * Mines blocks to the development wallet.
 *
 * @param rpc Regtest node.
 * @param count How many blocks.
 * @returns The new chain height.
 */
export async function mineBlocks(rpc: BitcoindRpc, count: number): Promise<number> {
  const address = await rpc.call(z.string(), 'getnewaddress', [], NODE_WALLET);
  await rpc.call(z.array(z.string()), 'generatetoaddress', [count, address]);
  return rpc.call(z.number().int(), 'getblockcount');
}

/**
 * @param name File in {@link KEYS_DIR}.
 * @param schema Expected shape.
 * @returns The parsed file, or undefined when it does not exist.
 * @throws Error when the file exists but does not match the schema.
 */
export function readKeysFile<T>(name: string, schema: z.ZodType<T>): T | undefined {
  const path = `${KEYS_DIR}${name}`;
  if (!existsSync(path)) return undefined;
  return schema.parse(JSON.parse(readFileSync(path, 'utf8')));
}

/**
 * Writes a file readable only by the current user, in a folder only they can enter.
 *
 * @param name File in {@link KEYS_DIR}.
 * @param data JSON-serializable content.
 */
export function writeKeysFile(name: string, data: unknown): void {
  mkdirSync(KEYS_DIR, { recursive: true, mode: 0o700 });
  chmodSync(KEYS_DIR, 0o700);
  const path = `${KEYS_DIR}${name}`;
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
}
