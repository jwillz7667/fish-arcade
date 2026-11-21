import type { CentsPerBtc } from '@reef/money';

/** One exchange's BTC/USD feed. */
export interface PriceSource {
  /** Stable name, recorded with every snapshot. */
  readonly name: string;
  /**
   * @returns The exchange's latest BTC/USD price.
   * @throws Error when the exchange is unreachable, slow, or answers oddly. The oracle treats
   *   that source as down for this round.
   */
  fetchPrice(): Promise<CentsPerBtc>;
}
