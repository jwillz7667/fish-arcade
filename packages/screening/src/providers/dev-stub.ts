import { createHash } from 'node:crypto';

import { DependencyUnavailableError } from '@reef/errors';
import { z } from 'zod';

import type { ChainRiskProvider, ProviderVerdict } from '../chain-risk-provider.js';
import { RISK_LEVELS } from '../risk.js';

/** The part of an ioredis client the stub uses. */
export interface DevStubStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', seconds: number): Promise<unknown>;
}

/** What a test or developer can script for an address. */
export type ScriptedScreening = ProviderVerdict | 'unavailable';

const SCRIPT_TTL_SECONDS = 7 * 86_400;
const keyFor = (address: string): string =>
  `screening:dev:v1:${createHash('sha256').update(address).digest('hex')}`;

const scriptSchema = z.union([
  z.literal('unavailable'),
  z.object({
    riskLevel: z.enum(RISK_LEVELS),
    categories: z.array(z.string()),
    sanctioned: z.boolean(),
  }),
]);

const CLEAN: ProviderVerdict = { riskLevel: 'low', categories: [], sanctioned: false };

/**
 * Development and signet chain-risk vendor. Every address is clean unless a verdict, or an
 * outage, has been scripted for it in Redis with {@link script}. Startup refuses it on mainnet.
 */
export class DevStubChainRiskProvider implements ChainRiskProvider {
  readonly name = 'dev_stub';

  constructor(private readonly store: DevStubStore) {}

  /**
   * @param address Canonical address.
   * @param outcome The verdict to return for it, or `unavailable` to simulate an outage.
   */
  async script(address: string, outcome: ScriptedScreening): Promise<void> {
    await this.store.set(keyFor(address), JSON.stringify(outcome), 'EX', SCRIPT_TTL_SECONDS);
  }

  /**
   * @param addresses Canonical addresses.
   * @returns Scripted verdicts, clean by default.
   * @throws DependencyUnavailableError when an address is scripted `unavailable`.
   */
  async screenAddresses(
    addresses: readonly string[],
  ): Promise<ReadonlyMap<string, ProviderVerdict>> {
    const verdicts = new Map<string, ProviderVerdict>();
    for (const address of addresses) {
      const raw = await this.store.get(keyFor(address));
      const scripted = raw === null ? CLEAN : scriptSchema.parse(JSON.parse(raw));
      if (scripted === 'unavailable') {
        throw new DependencyUnavailableError({
          dependency: this.name,
          message: 'Scripted screening outage',
        });
      }
      verdicts.set(address, scripted);
    }
    return verdicts;
  }
}
