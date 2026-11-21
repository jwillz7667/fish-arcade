import { readFileSync } from 'node:fs';

import { ErrorCode } from '@reef/errors';
import { describe, expect, it } from 'vitest';

import { parseSdnBitcoinAddresses } from './sdn-xml.js';

const fixture = readFileSync(
  new URL('../../test/fixtures/sdn-sample.xml', import.meta.url),
  'utf8',
);

describe('parseSdnBitcoinAddresses', () => {
  it('extracts every XBT address from the SDN list, canonical, unique, and sorted', () => {
    const list = parseSdnBitcoinAddresses(fixture);

    expect(list).toEqual({
      publishDate: '2026-11-20',
      addresses: [
        '12QtD5BFwRsdNsAZY76UVE1xyCGNTojH9h',
        '1Kuf2Rd8mDyAViwBozGTNYnvWL8uYFrkVo',
        'bc1qv7k70u2zynvem59u88ctdlaw7hc735d8xep9rq',
        'bc1qw4cxpe6sxa5dg6sdwxjph959cw6yztrzl4r54s',
      ],
      // A Tron address OFAC labeled XBT: reported, never matched.
      rejected: ['TUCsTq7TofTCJRRoHk6RvhMoS2mJLm5Yzq'],
    });
  });

  it('ignores other currencies and other identifiers', () => {
    const { addresses } = parseSdnBitcoinAddresses(fixture);

    expect(addresses.some((address) => address.startsWith('0x') || address.startsWith('T'))).toBe(
      false,
    );
  });

  it.each([
    ['is not an SDN list', '<html><body>Service unavailable</body></html>'],
    ['has no publish date', '<sdnList><sdnEntry></sdnEntry></sdnList>'],
    [
      'has an XBT entry without its address',
      `<sdnList><publshInformation><Publish_Date>11/20/2026</Publish_Date></publshInformation>
       <id><idType>Digital Currency Address - XBT</idType></id>
       <id><idType>Passport</idType><idNumber>X1</idNumber></id></sdnList>`,
    ],
  ])('refuses a file that %s', (_label, xml) => {
    expect(() => parseSdnBitcoinAddresses(xml)).toThrow(
      expect.objectContaining({ code: ErrorCode.VALIDATION_FAILED }),
    );
  });

  it('reads an empty list as no addresses, for the importer to refuse', () => {
    const xml =
      '<sdnList><publshInformation><Publish_Date>01/02/2027</Publish_Date></publshInformation></sdnList>';

    expect(parseSdnBitcoinAddresses(xml)).toEqual({
      publishDate: '2027-01-02',
      addresses: [],
      rejected: [],
    });
  });
});
