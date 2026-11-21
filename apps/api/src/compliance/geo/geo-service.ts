import { DependencyUnavailableError } from '@reef/errors';
import type { Pool } from 'pg';

import type { Clock } from '../../shared/clock.js';
import type { BlockReason, GatedContext } from '../jurisdictions/jurisdiction-policy.js';
import type { JurisdictionService } from '../jurisdictions/jurisdiction-service.js';
import { geoCheckRepository } from './geo-check-repository.js';
import { decideLocation } from './geo-decision.js';
import type { GeoCheckInput, GeoLocation, GeoProvider } from './geo-provider.js';
import { signGeoToken } from './geo-token.js';

/** Result of a location check, as returned to the client. */
export type GeoCheckOutcome =
  | {
      readonly result: 'allowed';
      readonly stateCode: string;
      /** Send as `X-Geo-Token` on the gated request. */
      readonly geoToken: string;
      readonly expiresAt: Date;
    }
  | { readonly result: 'blocked'; readonly stateCode: string | null; readonly reason: BlockReason };

/** Settings for {@link GeoService}, from GEO_* env. */
export interface GeoConfig {
  readonly minConfidence: number;
  readonly providerTimeoutMs: number;
  readonly tokenTtlSeconds: number;
}

/** Collaborators for {@link GeoService}. */
export interface GeoServiceDeps {
  readonly pool: Pool;
  readonly provider: GeoProvider;
  readonly jurisdictions: JurisdictionService;
  readonly hmacKey: Buffer;
  readonly clock: Clock;
  readonly config: GeoConfig;
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`Geo provider timed out after ${String(ms)} ms`));
    }, ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Location checks (playbook Step 7, spec §15). Asks the provider where the device is, applies
 * location trust and the state's jurisdiction rule, records the check in `geo_checks`, and, when
 * allowed, issues a short-lived geo token bound to the context, user, and IP. Fails closed: a
 * provider error or timeout is recorded and answered with 503.
 */
export class GeoService {
  constructor(private readonly deps: GeoServiceDeps) {}

  /**
   * @param input The check and the user it is for (null for signup).
   * @returns Allowed with a geo token, or blocked with a reason.
   * @throws DependencyUnavailableError when the provider fails or times out.
   */
  async check(input: GeoCheckInput & { userId: string | null }): Promise<GeoCheckOutcome> {
    let location: GeoLocation;
    try {
      location = await withTimeout(
        this.deps.provider.check(input),
        this.deps.config.providerTimeoutMs,
      );
    } catch (error) {
      await this.#record(
        input,
        { stateCode: null, vpnDetected: false, lat: null, lng: null },
        'error',
      );
      throw new DependencyUnavailableError({ dependency: 'geolocation', cause: error });
    }

    const rule =
      location.stateCode === null
        ? undefined
        : await this.deps.jurisdictions.ruleFor(location.stateCode);
    const decision = decideLocation({
      context: input.context,
      location,
      rule,
      minConfidence: this.deps.config.minConfidence,
    });
    const checkId = await this.#record(input, location, decision.isAllowed ? 'allowed' : 'blocked');
    if (!decision.isAllowed || location.stateCode === null) {
      return {
        result: 'blocked',
        stateCode: location.stateCode,
        reason: decision.isAllowed ? 'location_unavailable' : decision.reason,
      };
    }
    const expiresAt = new Date(
      this.deps.clock.now().getTime() + this.deps.config.tokenTtlSeconds * 1000,
    );
    return {
      result: 'allowed',
      stateCode: location.stateCode,
      expiresAt,
      geoToken: signGeoToken(this.deps.hmacKey, {
        checkId,
        context: input.context,
        stateCode: location.stateCode,
        userId: input.userId,
        ip: input.ip,
        expiresAt,
      }),
    };
  }

  async #record(
    input: { context: GatedContext; ip: string; userId: string | null },
    location: Pick<GeoLocation, 'stateCode' | 'vpnDetected' | 'lat' | 'lng'>,
    result: 'allowed' | 'blocked' | 'error',
  ): Promise<string> {
    return geoCheckRepository.insert(this.deps.pool, {
      userId: input.userId,
      context: input.context,
      ip: input.ip,
      stateCode: location.stateCode,
      vpnDetected: location.vpnDetected,
      lat: location.lat,
      lng: location.lng,
      result,
    });
  }
}
