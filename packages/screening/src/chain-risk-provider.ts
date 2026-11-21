import type { ScreeningVerdict } from './verdict.js';

/** A vendor's verdict on one address. The screener adds the provider name. */
export type ProviderVerdict = Omit<ScreeningVerdict, 'provider'>;

/**
 * A chain analytics vendor (spec §15: Chainalysis, TRM Labs, or Elliptic). Deposits are
 * screened through their source addresses, so address screening is the only call needed.
 */
export interface ChainRiskProvider {
  /** Stored in `chain_screenings.provider`. */
  readonly name: string;

  /**
   * @param addresses Canonical addresses (from `parseAddress`), at most
   *   {@link MAX_ADDRESSES_PER_CALL}.
   * @returns A verdict for every address given, keyed by the address as given.
   * @throws DependencyUnavailableError when the vendor is unreachable, refuses the request, or
   *   answers with anything it cannot fully interpret.
   */
  screenAddresses(addresses: readonly string[]): Promise<ReadonlyMap<string, ProviderVerdict>>;
}

/** Largest batch sent to a vendor in one call. */
export const MAX_ADDRESSES_PER_CALL = 20;
