import { NETWORK, TEST_NETWORK } from '@scure/btc-signer';

/** Networks the platform runs on (spec §22). Regtest for development, signet for staging. */
export const BITCOIN_NETWORKS = ['regtest', 'signet', 'mainnet'] as const;

/** One of {@link BITCOIN_NETWORKS}. */
export type BitcoinNetwork = (typeof BITCOIN_NETWORKS)[number];

/** Address encoding parameters, in the shape `@scure/btc-signer` expects. */
export interface NetworkParams {
  readonly bech32: string;
  readonly pubKeyHash: number;
  readonly scriptHash: number;
  readonly wif: number;
}

/** BIP32 extended key version bytes. */
export interface ExtendedKeyVersions {
  readonly private: number;
  readonly public: number;
}

// Regtest shares testnet's base58 version bytes; only the bech32 prefix tells them apart.
const REGTEST: NetworkParams = Object.freeze({ ...TEST_NETWORK, bech32: 'bcrt' });

// xpub/xprv on mainnet; tpub/tprv on every test network.
const MAINNET_VERSIONS: ExtendedKeyVersions = { private: 0x0488ade4, public: 0x0488b21e };
const TEST_VERSIONS: ExtendedKeyVersions = { private: 0x04358394, public: 0x043587cf };

/**
 * @param network Network name.
 * @returns Its address encoding parameters. Signet uses testnet's.
 */
export function networkParams(network: BitcoinNetwork): NetworkParams {
  switch (network) {
    case 'mainnet':
      return NETWORK;
    case 'signet':
      return TEST_NETWORK;
    case 'regtest':
      return REGTEST;
  }
}

/**
 * @param network Network name.
 * @returns BIP32 version bytes for its extended keys.
 */
export function extendedKeyVersions(network: BitcoinNetwork): ExtendedKeyVersions {
  return network === 'mainnet' ? MAINNET_VERSIONS : TEST_VERSIONS;
}

/**
 * The BIP48 coin type: 0 on mainnet, 1 on test networks.
 *
 * @param network Network name.
 * @returns The hardened coin-type index without the hardened marker.
 */
export function coinType(network: BitcoinNetwork): 0 | 1 {
  return network === 'mainnet' ? 0 : 1;
}
