import type { Provider, Type } from '@nestjs/common';
import type { ApiEnv } from '@reef/config';
import { ConfigError } from '@reef/errors';
import type { Redis } from 'ioredis';
import type { Pool } from 'pg';

import type { AuditWriter } from '../audit/audit-writer.js';
import type { Clock } from '../shared/clock.js';
import { DevStubGeoProvider } from './geo/dev-stub-provider.js';
import { GeoController } from './geo/geo.controller.js';
import type { GeoProvider } from './geo/geo-provider.js';
import { GeoService } from './geo/geo-service.js';
import { JurisdictionGuard } from './geo/jurisdiction.guard.js';
import { JurisdictionService } from './jurisdictions/jurisdiction-service.js';
import { DevStubKycProvider } from './kyc/dev-stub-kyc-provider.js';
import { KycController, KycWebhookController } from './kyc/kyc.controller.js';
import { KycGuard } from './kyc/kyc.guard.js';
import type { KycProvider } from './kyc/kyc-provider.js';
import { KycService } from './kyc/kyc-service.js';

/** Controllers for compliance. */
export const COMPLIANCE_CONTROLLERS: readonly Type[] = [
  GeoController,
  KycController,
  KycWebhookController,
];

/** Compliance services other modules depend on. */
export interface ComplianceServices {
  readonly jurisdictions: JurisdictionService;
  readonly geo: GeoService;
  readonly kyc: KycService;
  readonly providers: Provider[];
}

/**
 * Wires geolocation and the jurisdiction gate (playbook Step 7) from explicit dependencies.
 *
 * @param input Env, pool, Redis, the shared audit writer, clock, HMAC key, and the geo and KYC
 *   providers.
 * @returns The services and their Nest providers.
 */
export function createComplianceServices(input: {
  env: ApiEnv;
  pool: Pool;
  redis: Redis;
  audit: AuditWriter;
  clock: Clock;
  hmacKey: Buffer;
  geoProvider: GeoProvider;
  kycProvider: KycProvider;
}): ComplianceServices {
  const jurisdictions = new JurisdictionService({
    pool: input.pool,
    redis: input.redis,
    audit: input.audit,
    clock: input.clock,
  });
  const geo = new GeoService({
    pool: input.pool,
    provider: input.geoProvider,
    jurisdictions,
    hmacKey: input.hmacKey,
    clock: input.clock,
    config: {
      minConfidence: input.env.GEO_MIN_CONFIDENCE,
      providerTimeoutMs: input.env.GEO_PROVIDER_TIMEOUT_MS,
      tokenTtlSeconds: input.env.GEO_TOKEN_TTL_SECONDS,
    },
  });
  const kyc = new KycService({
    pool: input.pool,
    provider: input.kycProvider,
    audit: input.audit,
    clock: input.clock,
  });
  return {
    jurisdictions,
    geo,
    kyc,
    providers: [
      { provide: JurisdictionService, useValue: jurisdictions },
      { provide: GeoService, useValue: geo },
      { provide: KycService, useValue: kyc },
      JurisdictionGuard,
      KycGuard,
    ],
  };
}

// One entry per GEO_PROVIDER value. Only the dev stub exists; config rejects it in production,
// so production cannot start until a vendor adapter is added here.
const GEO_PROVIDERS = new Map<ApiEnv['GEO_PROVIDER'], () => GeoProvider>([
  ['dev_stub', () => new DevStubGeoProvider()],
]);

/**
 * @param env Parsed API env.
 * @returns The configured geolocation provider.
 * @throws ConfigError when GEO_PROVIDER names a provider with no adapter.
 */
export function createGeoProvider(env: ApiEnv): GeoProvider {
  const create = GEO_PROVIDERS.get(env.GEO_PROVIDER);
  if (create === undefined) {
    throw new ConfigError({ issues: [{ path: 'GEO_PROVIDER', message: 'has no adapter' }] });
  }
  return create();
}

// One entry per KYC_PROVIDER value, as for GEO_PROVIDERS.
const KYC_PROVIDERS = new Map<ApiEnv['KYC_PROVIDER'], (env: ApiEnv, redis: Redis) => KycProvider>([
  ['dev_stub', (env, redis) => new DevStubKycProvider(redis, env.KYC_WEBHOOK_SECRET)],
]);

/**
 * @param env Parsed API env.
 * @param redis Redis, where the dev stub keeps its scripted outcomes.
 * @returns The configured KYC provider. Only the dev stub exists; config rejects it in
 *   production, so production cannot start until a vendor adapter is added.
 * @throws ConfigError when KYC_PROVIDER names a provider with no adapter.
 */
export function createKycProvider(env: ApiEnv, redis: Redis): KycProvider {
  const create = KYC_PROVIDERS.get(env.KYC_PROVIDER);
  if (create === undefined) {
    throw new ConfigError({ issues: [{ path: 'KYC_PROVIDER', message: 'has no adapter' }] });
  }
  return create(env, redis);
}
