import { DependencyUnavailableError } from '@reef/errors';
import { z } from 'zod';

import {
  MAX_ADDRESSES_PER_CALL,
  type ChainRiskProvider,
  type ProviderVerdict,
} from '../chain-risk-provider.js';
import { highestRisk, type RiskLevel } from '../risk.js';

/** Settings for {@link TrmLabsProvider}. */
export interface TrmLabsOptions {
  readonly apiKey: string;
  /** `https://api.trmlabs.com` in production. */
  readonly baseUrl: string;
  readonly timeoutMs: number;
  readonly fetchFn?: typeof fetch;
}

const indicatorSchema = z.object({
  category: z.string(),
  categoryRiskScoreLevelLabel: z.string(),
  riskType: z.string(),
});

const entitySchema = z.object({
  category: z.string(),
  riskScoreLevelLabel: z.string(),
});

const responseSchema = z.array(
  z.object({
    address: z.string(),
    addressRiskIndicators: z.array(indicatorSchema),
    entities: z.array(entitySchema),
  }),
);

const LEVEL_BY_LABEL = new Map<string, RiskLevel>([
  ['unknown', 'low'],
  ['low', 'low'],
  ['medium', 'medium'],
  ['high', 'high'],
  ['severe', 'severe'],
]);

const isSanctionsCategory = (category: string): boolean =>
  category.toLowerCase().includes('sanction');

function unavailable(message: string, cause?: unknown): DependencyUnavailableError {
  return new DependencyUnavailableError({
    dependency: 'trm_labs',
    message,
    ...(cause === undefined ? {} : { cause }),
  });
}

function levelOf(label: string): RiskLevel {
  const level = LEVEL_BY_LABEL.get(label.trim().toLowerCase());
  // An unknown label could mean anything, including worse than severe: refuse to guess.
  if (level === undefined) throw unavailable(`TRM returned an unknown risk level: ${label}`);
  return level;
}

function verdictOf(entry: z.infer<typeof responseSchema>[number]): ProviderVerdict {
  const levels = [
    ...entry.addressRiskIndicators.map((indicator) =>
      levelOf(indicator.categoryRiskScoreLevelLabel),
    ),
    ...entry.entities.map((entity) => levelOf(entity.riskScoreLevelLabel)),
  ];
  // Owning the address, or being the entity behind it, makes it sanctioned. Having traded with a
  // sanctioned party is exposure, which TRM scores (usually severe) rather than a sanctions hit.
  const sanctioned =
    entry.entities.some((entity) => isSanctionsCategory(entity.category)) ||
    entry.addressRiskIndicators.some(
      (indicator) =>
        indicator.riskType.toUpperCase() === 'OWNERSHIP' && isSanctionsCategory(indicator.category),
    );
  const categories = [
    ...entry.addressRiskIndicators.map((indicator) => indicator.category),
    ...entry.entities.map((entity) => entity.category),
  ];
  return {
    riskLevel: sanctioned ? 'severe' : highestRisk(levels),
    categories: [...new Set(categories)].sort(),
    sanctioned,
  };
}

/** Bech32 is case-insensitive, so TRM may echo it in a different case. */
const matchKey = (address: string): string =>
  /^(bc1|tb1|bcrt1)/i.test(address) ? address.toLowerCase() : address;

/**
 * TRM Labs wallet screening (ADR 0006), `POST /public/v2/screening/addresses`, authenticated
 * with the API key as both Basic-auth user and password. TRM's full reference is behind its
 * customer login, so the response is validated strictly: any field, label, or address this
 * adapter does not recognise makes the call fail, and screening fails closed. Verify against
 * TRM's account documentation when the contract is signed.
 */
export class TrmLabsProvider implements ChainRiskProvider {
  readonly name = 'trm_labs';
  readonly #fetch: typeof fetch;
  readonly #authorization: string;

  constructor(private readonly options: TrmLabsOptions) {
    this.#fetch = options.fetchFn ?? fetch;
    this.#authorization = `Basic ${Buffer.from(`${options.apiKey}:${options.apiKey}`).toString('base64')}`;
  }

  /**
   * @param addresses Canonical mainnet addresses, at most {@link MAX_ADDRESSES_PER_CALL}.
   * @returns A verdict per address.
   * @throws DependencyUnavailableError on any failure or unrecognised answer.
   */
  async screenAddresses(
    addresses: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderVerdict>> {
    if (addresses.length > MAX_ADDRESSES_PER_CALL)
      throw unavailable('Too many addresses for one TRM call');
    let body: unknown;
    try {
      const response = await this.#fetch(
        new URL('/public/v2/screening/addresses', this.options.baseUrl),
        {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            authorization: this.#authorization,
          },
          body: JSON.stringify(addresses.map((address) => ({ address, chain: 'bitcoin' }))),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        },
      );
      if (!response.ok) throw unavailable(`TRM returned ${String(response.status)}`);
      body = await response.json();
    } catch (error) {
      if (error instanceof DependencyUnavailableError) throw error;
      throw unavailable('TRM could not be reached', error);
    }
    const parsed = responseSchema.safeParse(body);
    if (!parsed.success) throw unavailable('TRM returned an unrecognised response');
    const byAddress = new Map(parsed.data.map((entry) => [matchKey(entry.address), entry]));
    const verdicts = new Map<string, ProviderVerdict>();
    for (const address of addresses) {
      const entry = byAddress.get(matchKey(address));
      if (entry === undefined) throw unavailable('TRM left an address unscreened');
      verdicts.set(address, verdictOf(entry));
    }
    return verdicts;
  }
}
