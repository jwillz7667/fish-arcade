import { ErrorCode } from '@reef/errors';
import { describe, expect, it } from 'vitest';

import { parseAddress } from './address.js';

// BIP 173 and BIP 350 test vectors, plus well-known base58 addresses and regtest addresses
// derived by Bitcoin Core (see multisig.test.ts).
const MAINNET = {
  wpkh: 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4',
  tr: 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0',
  pkh: '1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2',
  sh: '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy',
};
const TESTNET_WPKH = 'tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx';
const REGTEST_WSH = 'bcrt1q80mcpez85spvsvcpw3wapkjqgylnfxv8h22zq4rxphcn87xfkjqqxw63pa';

const invalid = expect.objectContaining({ code: ErrorCode.INVALID_ADDRESS });

describe('parseAddress', () => {
  it.each([
    [MAINNET.wpkh, 'wpkh'],
    [MAINNET.tr, 'tr'],
    [MAINNET.pkh, 'pkh'],
    [MAINNET.sh, 'sh'],
  ])('parses the mainnet address %s as %s', (address, type) => {
    expect(parseAddress(address, 'mainnet')).toMatchObject({ address, type, network: 'mainnet' });
  });

  it('parses signet and regtest addresses on their own networks', () => {
    expect(parseAddress(TESTNET_WPKH, 'signet').type).toBe('wpkh');
    expect(parseAddress(REGTEST_WSH, 'regtest').type).toBe('wsh');
  });

  it('lower-cases an all-upper-case bech32 address, as QR codes carry them', () => {
    expect(parseAddress(MAINNET.wpkh.toUpperCase(), 'mainnet').address).toBe(MAINNET.wpkh);
  });

  it('returns the output script that pays the address', () => {
    expect(Buffer.from(parseAddress(MAINNET.wpkh, 'mainnet').script).toString('hex')).toBe(
      '0014751e76e8199196d454941c45d1b3a323f1433bd6',
    );
  });

  it.each([
    [MAINNET.wpkh, 'regtest', 'mainnet'],
    [REGTEST_WSH, 'mainnet', 'regtest'],
    [TESTNET_WPKH, 'mainnet', 'signet'],
    [MAINNET.pkh, 'signet', 'mainnet'],
  ] as const)('refuses %s on %s and names %s', (address, network, other) => {
    expect(() => parseAddress(address, network)).toThrow(invalid);
    expect(() => parseAddress(address, network)).toThrow(`for ${other}`);
  });

  it.each([
    ['', 'empty'],
    [` ${MAINNET.wpkh}`, 'padded'],
    ['bc1qW508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'mixed case'],
    ['bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5', 'bad checksum'],
    [`bc1${'q'.repeat(90)}`, 'too long'],
    ['not-an-address', 'garbage'],
  ])('refuses %j (%s)', (address) => {
    expect(() => parseAddress(address, 'mainnet')).toThrow(invalid);
  });
});
