import { parseAddress } from '@reef/bitcoin';
import { ValidationError } from '@reef/errors';

/** Bitcoin addresses on one publication of the OFAC SDN list. */
export interface SdnBitcoinAddresses {
  /** The list's publish date, `YYYY-MM-DD`. */
  readonly publishDate: string;
  /** Canonical mainnet addresses, unique and sorted. */
  readonly addresses: readonly string[];
  /** Entries labeled XBT that are not valid mainnet addresses. Kept for the import log. */
  readonly rejected: readonly string[];
}

const XBT_ID_TYPE = '<idType>Digital Currency Address - XBT</idType>';
const ID_NUMBER_OPEN = '<idNumber>';
const ID_NUMBER_CLOSE = '</idNumber>';
const ID_CLOSE = '</id>';
const PUBLISH_DATE = /<Publish_Date>(\d{2})\/(\d{2})\/(\d{4})<\/Publish_Date>/;

function invalidList(message: string): ValidationError {
  return new ValidationError({ message, issues: [{ path: 'sdn.xml', message }] });
}

function canonicalMainnet(value: string): string | undefined {
  try {
    return parseAddress(value, 'mainnet').address;
  } catch {
    return undefined;
  }
}

/**
 * Extracts the Bitcoin addresses from OFAC's SDN list in its XML form (`SDN.XML` from the
 * Sanctions List Service). Each address is an `<id>` with `idType` "Digital Currency Address -
 * XBT" and the address in `idNumber`. Entries that do not parse as mainnet addresses (OFAC has
 * listed a Tron address under XBT) are reported in `rejected`, never matched.
 *
 * @param xml The whole file.
 * @returns The publish date and the addresses.
 * @throws ValidationError when the file is not an SDN list or has no publish date.
 */
export function parseSdnBitcoinAddresses(xml: string): SdnBitcoinAddresses {
  if (!xml.includes('<sdnList')) throw invalidList('Not an OFAC SDN list');
  const date = PUBLISH_DATE.exec(xml);
  if (date === null) throw invalidList('SDN list has no publish date');
  const [, month, day, year] = date;
  const addresses = new Set<string>();
  const rejected = new Set<string>();
  for (let at = xml.indexOf(XBT_ID_TYPE); at !== -1; at = xml.indexOf(XBT_ID_TYPE, at + 1)) {
    const open = xml.indexOf(ID_NUMBER_OPEN, at);
    const close = xml.indexOf(ID_NUMBER_CLOSE, open);
    const end = xml.indexOf(ID_CLOSE, at);
    // The number must belong to this <id>, not a later one.
    if (open === -1 || close === -1 || (end !== -1 && open > end)) {
      throw invalidList('An XBT entry has no address');
    }
    const value = xml.slice(open + ID_NUMBER_OPEN.length, close).trim();
    const address = canonicalMainnet(value);
    if (address === undefined) rejected.add(value);
    else addresses.add(address);
  }
  return {
    publishDate: `${String(year)}-${String(month)}-${String(day)}`,
    addresses: [...addresses].sort(),
    rejected: [...rejected].sort(),
  };
}
