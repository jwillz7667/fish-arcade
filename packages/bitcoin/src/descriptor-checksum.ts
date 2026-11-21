// Output descriptor checksum (BIP 380), as Bitcoin Core computes it in descriptor.cpp.
const INPUT_CHARSET =
  '0123456789()[],\'/*abcdefgh@:$%{}IJKLMNOPQRSTUVWXYZ&+-.;<=>?!^_|~ijklmnopqrstuvwxyzABCDEFGH`#"\\ ';
const CHECKSUM_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
const GENERATOR = [0xf5dee51989n, 0xa9fdca3312n, 0x1bab10e32dn, 0x3706b1677an, 0x644d626ffdn];
const LOW_35_BITS = 0x7ffffffffn;

function polymod(symbols: readonly number[]): bigint {
  let checksum = 1n;
  for (const value of symbols) {
    const top = checksum >> 35n;
    checksum = ((checksum & LOW_35_BITS) << 5n) ^ BigInt(value);
    GENERATOR.forEach((generator, bit) => {
      if (((top >> BigInt(bit)) & 1n) === 1n) checksum ^= generator;
    });
  }
  return checksum;
}

function expand(descriptor: string): number[] {
  const symbols: number[] = [];
  let groups: number[] = [];
  for (const char of descriptor) {
    const value = INPUT_CHARSET.indexOf(char);
    if (value === -1) throw new Error(`Descriptor has a character outside the BIP 380 set`);
    symbols.push(value & 31);
    groups.push(value >> 5);
    if (groups.length === 3) {
      const [a = 0, b = 0, c = 0] = groups;
      symbols.push(a * 9 + b * 3 + c);
      groups = [];
    }
  }
  const [a = 0, b = 0] = groups;
  if (groups.length === 1) symbols.push(a);
  if (groups.length === 2) symbols.push(a * 3 + b);
  return symbols;
}

/**
 * Appends the BIP 380 checksum, so Bitcoin Core and wallet coordinators accept the descriptor
 * and catch transcription errors.
 *
 * @param descriptor A descriptor without `#checksum`.
 * @returns `descriptor#checksum`.
 * @throws Error when the descriptor has a character outside the BIP 380 character set (a
 *   programming error: descriptors here are built from validated keys).
 */
export function withDescriptorChecksum(descriptor: string): string {
  const checksum = polymod([...expand(descriptor), 0, 0, 0, 0, 0, 0, 0, 0]) ^ 1n;
  const chars = Array.from(
    { length: 8 },
    (_, index) => CHECKSUM_CHARSET[Number((checksum >> (5n * BigInt(7 - index))) & 31n)] ?? '',
  );
  return `${descriptor}#${chars.join('')}`;
}
