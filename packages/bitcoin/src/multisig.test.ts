import { describe, expect, it } from 'vitest';

import {
  multisigAccountPath,
  multisigAddress,
  multisigDescriptor,
  nbxplorerDerivationScheme,
  type Cosigner,
} from './multisig.js';

// Public account keys of three throwaway regtest wallets whose private keys were discarded.
// Expected descriptors and addresses come from Bitcoin Core 32.1 (getdescriptorinfo and
// deriveaddresses), an independent implementation.
const COSIGNERS: readonly Cosigner[] = [
  {
    fingerprint: '6d548069',
    path: 'm/48h/1h/0h/2h',
    xpub: 'tpubDDzz1eLhsSz4yUgB8rzoDz1meyWeqC82k2PSsrvUniLTPCcCDPSM4mPmLf4heSCAefqeauFyHAijcZDw9sroCwMDGtaPGeaR5TuvEW9Szv1',
  },
  {
    fingerprint: '752404ef',
    path: 'm/48h/1h/0h/2h',
    xpub: 'tpubDDvfTNm8CLdTqkYxScVCndJAX4txKf5vXEgoEhJXXngNAoiVYNnfrSPpy6aXx9VSWbUS8W3UCoW1Rukbsa11L9ZejGnnbKhqCWpWETiJXC7',
  },
  {
    fingerprint: '4d16acb8',
    path: 'm/48h/1h/0h/2h',
    xpub: 'tpubDEeUGt3RHvWUe69rYkZwbngyFVyyY8ez96UgUt6CDbo4xDtZVkBQ4dj3dnGQ9Khk7bmQwjQTyMuX3vHMTCu2P6NEeY1zYteVzoWKYhN9FNv',
  },
];

const CORE = {
  receive:
    'wsh(sortedmulti(2,[6d548069/48h/1h/0h/2h]tpubDDzz1eLhsSz4yUgB8rzoDz1meyWeqC82k2PSsrvUniLTPCcCDPSM4mPmLf4heSCAefqeauFyHAijcZDw9sroCwMDGtaPGeaR5TuvEW9Szv1/0/*,[752404ef/48h/1h/0h/2h]tpubDDvfTNm8CLdTqkYxScVCndJAX4txKf5vXEgoEhJXXngNAoiVYNnfrSPpy6aXx9VSWbUS8W3UCoW1Rukbsa11L9ZejGnnbKhqCWpWETiJXC7/0/*,[4d16acb8/48h/1h/0h/2h]tpubDEeUGt3RHvWUe69rYkZwbngyFVyyY8ez96UgUt6CDbo4xDtZVkBQ4dj3dnGQ9Khk7bmQwjQTyMuX3vHMTCu2P6NEeY1zYteVzoWKYhN9FNv/0/*))#47mrex7n',
  change:
    'wsh(sortedmulti(2,[6d548069/48h/1h/0h/2h]tpubDDzz1eLhsSz4yUgB8rzoDz1meyWeqC82k2PSsrvUniLTPCcCDPSM4mPmLf4heSCAefqeauFyHAijcZDw9sroCwMDGtaPGeaR5TuvEW9Szv1/1/*,[752404ef/48h/1h/0h/2h]tpubDDvfTNm8CLdTqkYxScVCndJAX4txKf5vXEgoEhJXXngNAoiVYNnfrSPpy6aXx9VSWbUS8W3UCoW1Rukbsa11L9ZejGnnbKhqCWpWETiJXC7/1/*,[4d16acb8/48h/1h/0h/2h]tpubDEeUGt3RHvWUe69rYkZwbngyFVyyY8ez96UgUt6CDbo4xDtZVkBQ4dj3dnGQ9Khk7bmQwjQTyMuX3vHMTCu2P6NEeY1zYteVzoWKYhN9FNv/1/*))#stse8qwm',
  receive0: 'bcrt1q80mcpez85spvsvcpw3wapkjqgylnfxv8h22zq4rxphcn87xfkjqqxw63pa',
  receive1: 'bcrt1q7uk3uexrst4wklapl6pywyj87lppkfnfkc3lz6cd7wtf6yevvqvqyvzm7z',
  change0: 'bcrt1qq8pc870cfq45y3n6eggvsczzj4vacm2tc44p2gnm4rw0hajl7geqfqr68e',
};

describe('cold multisig (spec §22.4)', () => {
  it('uses the BIP 48 P2WSH account path for the network', () => {
    expect([multisigAccountPath('mainnet'), multisigAccountPath('regtest', 3)]).toEqual([
      'm/48h/0h/0h/2h',
      'm/48h/1h/3h/2h',
    ]);
  });

  it('builds the same descriptors, checksums included, as Bitcoin Core', () => {
    expect([
      multisigDescriptor(COSIGNERS, 0, 'regtest'),
      multisigDescriptor(COSIGNERS, 1, 'regtest'),
    ]).toEqual([CORE.receive, CORE.change]);
  });

  it('derives the same receive and change addresses as Bitcoin Core', () => {
    expect([
      multisigAddress(COSIGNERS, 0, 0, 'regtest'),
      multisigAddress(COSIGNERS, 0, 1, 'regtest'),
      multisigAddress(COSIGNERS, 1, 0, 'regtest'),
    ]).toEqual([CORE.receive0, CORE.receive1, CORE.change0]);
  });

  it('writes the NBXplorer derivation scheme BTCPay takes', () => {
    expect(nbxplorerDerivationScheme(COSIGNERS, 'regtest')).toBe(
      `2-of-${COSIGNERS.map((cosigner) => cosigner.xpub).join('-')}`,
    );
  });

  it.each([
    ['two keys', COSIGNERS.slice(0, 2)],
    ['a duplicated key', [COSIGNERS[0], COSIGNERS[0], COSIGNERS[1]]],
    [
      'a malformed fingerprint',
      COSIGNERS.map((c, i) => (i === 0 ? { ...c, fingerprint: 'XYZ' } : c)),
    ],
    ['a non-hardened path', COSIGNERS.map((c, i) => (i === 0 ? { ...c, path: 'm/48/1/0/2' } : c))],
    [
      'a key that is not an xpub',
      COSIGNERS.map((c, i) => (i === 0 ? { ...c, xpub: 'tpubNOTAKEY' } : c)),
    ],
  ])('refuses %s', (_label, cosigners) => {
    expect(() => multisigDescriptor(cosigners as Cosigner[], 0, 'regtest')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });

  it('refuses test-network keys on mainnet', () => {
    expect(() => nbxplorerDerivationScheme(COSIGNERS, 'mainnet')).toThrow(
      expect.objectContaining({ code: 'VALIDATION_FAILED' }),
    );
  });
});
