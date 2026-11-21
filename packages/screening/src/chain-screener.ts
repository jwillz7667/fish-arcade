import { DependencyUnavailableError, ValidationError } from '@reef/errors';

import {
  MAX_ADDRESSES_PER_CALL,
  type ChainRiskProvider,
  type ProviderVerdict,
} from './chain-risk-provider.js';
import type { OfacList } from './ofac/ofac-list.js';
import { highestRisk } from './risk.js';
import type { ScreeningCache } from './screening-cache.js';
import type { ScreeningRecord, ScreeningRecorder } from './screening-recorder.js';
import type { ScreeningOutcome, ScreeningVerdict } from './verdict.js';

/** Most addresses screened together, such as the inputs of one deposit transaction. */
export const MAX_ADDRESSES_PER_SCREENING = 250;

/** Provider name recorded for hits on the local OFAC list. */
export const OFAC_PROVIDER = 'ofac_sdn';

/** Collaborators for {@link ChainScreener}. */
export interface ChainScreenerDeps {
  readonly provider: ChainRiskProvider;
  readonly ofac: Pick<OfacList, 'listed'>;
  readonly cache: Pick<ScreeningCache, 'getClean' | 'putIfClean'>;
  readonly recorder: Pick<ScreeningRecorder, 'record'>;
  /** Blind index of a canonical address, for `chain_screenings` and cache keys. */
  readonly indexAddress: (address: string) => string;
}

const OFAC_HIT: ScreeningVerdict = {
  riskLevel: 'severe',
  categories: ['OFAC SDN'],
  sanctioned: true,
  provider: OFAC_PROVIDER,
};

function combine(verdicts: Iterable<ProviderVerdict>, provider: string): ScreeningVerdict {
  const all = [...verdicts];
  return {
    riskLevel: highestRisk(all.map((verdict) => verdict.riskLevel)),
    categories: [...new Set(all.flatMap((verdict) => verdict.categories))].sort(),
    sanctioned: all.some((verdict) => verdict.sanctioned),
    provider,
  };
}

function reasonOf(error: unknown): string {
  if (error instanceof DependencyUnavailableError) return error.message;
  throw error;
}

/**
 * Screens addresses for sanctions and risk (spec §15, §22, playbook Step 12): the local OFAC
 * list first, then the vendor, with clean vendor verdicts cached for 24 hours. A sanctioned
 * hit from either source is final. Anything else needs both sources; when one is down the
 * outcome is `unavailable`, and callers fail closed.
 */
export class ChainScreener {
  constructor(private readonly deps: ChainScreenerDeps) {}

  /**
   * Screens one address, such as a payout address.
   *
   * @param address Canonical address from `parseAddress`.
   * @returns The outcome.
   * @throws Error when recording the screening fails. Callers retry later.
   */
  async screenAddress(address: string): Promise<ScreeningOutcome> {
    return this.#screen([address]);
  }

  /**
   * Screens a deposit by the addresses that funded it, and records the transaction's verdict.
   *
   * @param input The deposit's txid and its input addresses, read from our own node.
   * @returns The combined outcome.
   * @throws ValidationError when there are no source addresses or more than
   *   {@link MAX_ADDRESSES_PER_SCREENING}; such a deposit goes to manual review.
   * @throws Error when recording the screening fails. Callers retry later.
   */
  async screenDepositSources(input: {
    txid: string;
    sourceAddresses: readonly string[];
  }): Promise<ScreeningOutcome> {
    const outcome = await this.#screen(input.sourceAddresses);
    if (outcome.status === 'screened') {
      await this.deps.recorder.record([
        { subjectType: 'tx', subject: input.txid, verdict: outcome.verdict },
      ]);
    }
    return outcome;
  }

  async #screen(input: readonly string[]): Promise<ScreeningOutcome> {
    const addresses = [...new Set(input)];
    if (addresses.length === 0 || addresses.length > MAX_ADDRESSES_PER_SCREENING) {
      throw new ValidationError({
        issues: [
          {
            path: 'addresses',
            message: `must hold 1 to ${String(MAX_ADDRESSES_PER_SCREENING)} addresses`,
          },
        ],
      });
    }
    let ofacProblem: string | undefined;
    try {
      const listed = await this.deps.ofac.listed(addresses);
      if (listed.size > 0) {
        await this.deps.recorder.record(
          [...listed].map((address) => ({
            subjectType: 'address' as const,
            subject: this.deps.indexAddress(address),
            verdict: OFAC_HIT,
          })),
        );
        return { status: 'screened', verdict: OFAC_HIT };
      }
    } catch (error) {
      ofacProblem = reasonOf(error);
    }

    const { verdicts, problem: vendorProblem } = await this.#vendorVerdicts(addresses);
    const verdict = combine(verdicts.values(), this.deps.provider.name);
    if (verdict.sanctioned) return { status: 'screened', verdict };
    if (vendorProblem !== undefined) {
      return {
        status: 'unavailable',
        reason: vendorProblem,
        sanctionsChecked: ofacProblem === undefined,
      };
    }
    if (ofacProblem !== undefined) {
      // The vendor screens sanctions too, so its clean answer still counts as a sanctions check.
      return { status: 'unavailable', reason: ofacProblem, sanctionsChecked: true };
    }
    return { status: 'screened', verdict };
  }

  async #vendorVerdicts(
    addresses: readonly string[],
  ): Promise<{ verdicts: Map<string, ProviderVerdict>; problem?: string }> {
    const { provider, cache, indexAddress } = this.deps;
    const verdicts = new Map<string, ProviderVerdict>();
    const misses: string[] = [];
    for (const address of addresses) {
      const cached = await cache.getClean(provider.name, indexAddress(address));
      if (cached === undefined) misses.push(address);
      else verdicts.set(address, cached);
    }
    const fresh: ScreeningRecord[] = [];
    let problem: string | undefined;
    try {
      for (let start = 0; start < misses.length; start += MAX_ADDRESSES_PER_CALL) {
        const batch = misses.slice(start, start + MAX_ADDRESSES_PER_CALL);
        const answers = await provider.screenAddresses(batch);
        for (const address of batch) {
          const answer = answers.get(address);
          if (answer === undefined) {
            throw new DependencyUnavailableError({
              dependency: provider.name,
              message: `${provider.name} returned no verdict for an address`,
            });
          }
          verdicts.set(address, answer);
          fresh.push({
            subjectType: 'address',
            subject: indexAddress(address),
            verdict: { ...answer, provider: provider.name },
          });
        }
      }
    } catch (error) {
      problem = reasonOf(error);
    }
    // Everything the vendor did answer is recorded and, when clean, cached.
    await this.deps.recorder.record(fresh);
    for (const record of fresh)
      await cache.putIfClean(provider.name, record.subject, record.verdict);
    return problem === undefined ? { verdicts } : { verdicts, problem };
  }
}
