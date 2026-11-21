import type { RiskLevel } from './risk.js';

/** What a screening source concluded about one address or set of addresses. */
export interface ScreeningVerdict {
  readonly riskLevel: RiskLevel;
  /** Vendor categories behind the level, such as `Sanctions` or `Darknet Marketplace`. */
  readonly categories: readonly string[];
  /** True when the address belongs to a sanctioned party (OFAC SDN or the vendor's list). */
  readonly sanctioned: boolean;
  /** `ofac_sdn` for a hit on the local list, otherwise the vendor's name. */
  readonly provider: string;
}

/**
 * The result of screening. `unavailable` means no trustworthy verdict exists, and callers fail
 * closed (spec §15). `sanctionsChecked` says whether a sanctions list was still consulted and
 * came back clean, which is enough to credit Gold Coins but not to release anything redeemable.
 */
export type ScreeningOutcome =
  | { readonly status: 'screened'; readonly verdict: ScreeningVerdict }
  | {
      readonly status: 'unavailable';
      readonly reason: string;
      readonly sanctionsChecked: boolean;
    };
