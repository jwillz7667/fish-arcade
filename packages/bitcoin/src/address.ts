import { ErrorCode, ValidationError } from '@reef/errors';
import { Address, OutScript } from '@scure/btc-signer';

import { BITCOIN_NETWORKS, networkParams, type BitcoinNetwork } from './network.js';

/** Address kinds the platform pays to and accepts deposits from. */
export type AddressType = 'pkh' | 'sh' | 'wpkh' | 'wsh' | 'tr';

const ACCEPTED_TYPES: ReadonlySet<string> = new Set<AddressType>([
  'pkh',
  'sh',
  'wpkh',
  'wsh',
  'tr',
]);

// Longest standard address is a bech32m taproot address (62 characters on mainnet).
const MAX_ADDRESS_LENGTH = 90;

/** A validated address. */
export interface ParsedAddress {
  /** Canonical form: bech32 lowercased, base58 unchanged. */
  readonly address: string;
  readonly type: AddressType;
  readonly network: BitcoinNetwork;
  /** The output script that pays this address. */
  readonly script: Uint8Array;
}

function isAcceptedType(type: string): type is AddressType {
  return ACCEPTED_TYPES.has(type);
}

function tryDecode(address: string, network: BitcoinNetwork): ParsedAddress | undefined {
  try {
    const decoded = Address(networkParams(network)).decode(address);
    if (!isAcceptedType(decoded.type)) return undefined;
    return {
      address: Address(networkParams(network)).encode(decoded),
      type: decoded.type,
      network,
      script: OutScript.encode(decoded),
    };
  } catch {
    // Malformed, wrong checksum, or another network's prefix: the caller reports it.
    return undefined;
  }
}

function invalidAddress(message: string): ValidationError {
  return new ValidationError({
    code: ErrorCode.INVALID_ADDRESS,
    message,
    issues: [{ path: 'address', message: 'is not a valid address for this network' }],
  });
}

/**
 * Parses an address for the configured network (CLAUDE.md: every address parser uses
 * BITCOIN_NETWORK and rejects mismatches). Accepts P2PKH, P2SH, P2WPKH, P2WSH, and P2TR.
 * Bech32 addresses may arrive upper-case (QR codes) and are returned lower-case. Note that
 * regtest and testnet share base58 version bytes, so a testnet base58 address also parses on
 * regtest, as it does in Bitcoin Core.
 *
 * @param input The address as entered.
 * @param network The configured network.
 * @returns The canonical address, its type, and its output script.
 * @throws ValidationError (INVALID_ADDRESS) when the address is malformed, of an unsupported
 *   type, or belongs to another network.
 */
export function parseAddress(input: string, network: BitcoinNetwork): ParsedAddress {
  if (input.length === 0 || input.length > MAX_ADDRESS_LENGTH || input.trim() !== input) {
    throw invalidAddress('Address is empty, too long, or padded');
  }
  // Bech32 is case-insensitive but never mixed-case; base58 is case-sensitive, so only an
  // all-upper-case input is folded.
  const candidate = input === input.toUpperCase() ? input.toLowerCase() : input;
  const parsed = tryDecode(candidate, network) ?? tryDecode(input, network);
  if (parsed !== undefined) return parsed;
  const other = BITCOIN_NETWORKS.find(
    (name) => name !== network && tryDecode(candidate, name) !== undefined,
  );
  throw invalidAddress(
    other === undefined
      ? 'Address is malformed or of an unsupported type'
      : `Address is for ${other}, but this platform runs on ${network}`,
  );
}
