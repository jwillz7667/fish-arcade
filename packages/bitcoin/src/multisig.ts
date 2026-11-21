import { ValidationError } from '@reef/errors';
import { HDKey } from '@scure/bip32';
import { sortedMultisig } from '@scure/btc-signer';

import { withDescriptorChecksum } from './descriptor-checksum.js';
import { coinType, extendedKeyVersions, networkParams, type BitcoinNetwork } from './network.js';

/** Spec §22.4: the cold treasury is a 2-of-3 multisig. */
export const MULTISIG_THRESHOLD = 2;
/** Spec §22.4: three hardware wallets. */
export const MULTISIG_COSIGNERS = 3;

/** One hardware wallet's watch-only account key, as a coordinator such as Sparrow exports it. */
export interface Cosigner {
  /** Master key fingerprint, 8 hex characters. */
  readonly fingerprint: string;
  /** Account path, such as `m/48h/1h/0h/2h`. */
  readonly path: string;
  /** Account extended public key (xpub on mainnet, tpub elsewhere). */
  readonly xpub: string;
}

/** Receive (0) or change (1) addresses. */
export type AddressBranch = 0 | 1;

const FINGERPRINT_PATTERN = /^[0-9a-f]{8}$/;
const HARDENED_STEP = /^\d{1,10}h$/;

function isHardenedPath(path: string): boolean {
  const [root, ...steps] = path.split('/');
  return root === 'm' && steps.length > 0 && steps.every((step) => HARDENED_STEP.test(step));
}

/**
 * The BIP 48 account path for P2WSH multisig (script type 2).
 *
 * @param network Network name.
 * @param account Account index.
 * @returns The path in `h` notation, such as `m/48h/1h/0h/2h`.
 */
export function multisigAccountPath(network: BitcoinNetwork, account = 0): string {
  return `m/48h/${String(coinType(network))}h/${String(account)}h/2h`;
}

function invalidCosigners(message: string): ValidationError {
  return new ValidationError({ message, issues: [{ path: 'cosigners', message }] });
}

function accountKeys(cosigners: readonly Cosigner[], network: BitcoinNetwork): HDKey[] {
  if (cosigners.length !== MULTISIG_COSIGNERS) {
    throw invalidCosigners(`A cold multisig needs exactly ${String(MULTISIG_COSIGNERS)} keys`);
  }
  if (new Set(cosigners.map((cosigner) => cosigner.xpub)).size !== cosigners.length) {
    throw invalidCosigners('Cosigner keys must be distinct');
  }
  return cosigners.map((cosigner) => {
    if (!FINGERPRINT_PATTERN.test(cosigner.fingerprint) || !isHardenedPath(cosigner.path)) {
      throw invalidCosigners('Cosigner fingerprint or path is malformed');
    }
    let key: HDKey;
    try {
      key = HDKey.fromExtendedKey(cosigner.xpub, extendedKeyVersions(network));
    } catch (error) {
      throw new ValidationError({
        message: 'Cosigner key is not an extended public key for this network',
        issues: [{ path: 'cosigners', message: 'is not an extended public key for this network' }],
        cause: error,
      });
    }
    // CLAUDE.md: no server ever holds a cold key. An xprv here means someone pasted the wrong key.
    if (key.privateKey !== null) throw invalidCosigners('Cosigner key must be public only');
    return key;
  });
}

/**
 * The watch-only output descriptor for one branch of the cold multisig, with its checksum:
 * `wsh(sortedmulti(2,[fp/48h/1h/0h/2h]tpub.../0/*,...))`.
 *
 * @param cosigners The three account keys.
 * @param branch 0 for receive, 1 for change.
 * @param network Network the keys belong to.
 * @returns The descriptor.
 * @throws ValidationError when a key is malformed, private, duplicated, or for another network.
 */
export function multisigDescriptor(
  cosigners: readonly Cosigner[],
  branch: AddressBranch,
  network: BitcoinNetwork,
): string {
  accountKeys(cosigners, network);
  const keys = cosigners.map(
    (cosigner) =>
      `[${cosigner.fingerprint}${cosigner.path.slice(1)}]${cosigner.xpub}/${String(branch)}/*`,
  );
  return withDescriptorChecksum(
    `wsh(sortedmulti(${String(MULTISIG_THRESHOLD)},${keys.join(',')}))`,
  );
}

/**
 * The same multisig in NBXplorer's derivation-scheme format, which BTCPay accepts for an
 * on-chain wallet: `2-of-tpubA-tpubB-tpubC`. NBXplorer derives P2WSH and sorts keys per
 * address (BIP 67), matching `sortedmulti`.
 *
 * @param cosigners The three account keys.
 * @param network Network the keys belong to.
 * @returns The derivation scheme.
 * @throws ValidationError as for {@link multisigDescriptor}.
 */
export function nbxplorerDerivationScheme(
  cosigners: readonly Cosigner[],
  network: BitcoinNetwork,
): string {
  accountKeys(cosigners, network);
  return `${String(MULTISIG_THRESHOLD)}-of-${cosigners.map((cosigner) => cosigner.xpub).join('-')}`;
}

/**
 * Derives one multisig address locally, so the address BTCPay shows can be checked against the
 * keys (the human gate's "check the first receive address on every device").
 *
 * @param cosigners The three account keys.
 * @param branch 0 for receive, 1 for change.
 * @param index Address index.
 * @param network Network the keys belong to.
 * @returns The P2WSH address.
 * @throws ValidationError as for {@link multisigDescriptor}.
 */
export function multisigAddress(
  cosigners: readonly Cosigner[],
  branch: AddressBranch,
  index: number,
  network: BitcoinNetwork,
): string {
  const publicKeys = accountKeys(cosigners, network).map((key) => {
    const child = key.deriveChild(branch).deriveChild(index);
    if (child.publicKey === null) throw new Error('Derived key has no public key');
    return child.publicKey;
  });
  const payment = sortedMultisig(MULTISIG_THRESHOLD, publicKeys, true, networkParams(network));
  if (payment.address === undefined) throw new Error('P2WSH payment has no address');
  return payment.address;
}
