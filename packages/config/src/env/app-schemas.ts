import { z } from 'zod';

import {
  defineEnvSchema,
  portSchema,
  postgresUrlSchema,
  redisUrlSchema,
} from './define-env-schema.js';
import { AUTH_DEV_ONLY_RULES, AUTH_SHAPE } from './auth-schema.js';
import { GEO_DEV_ONLY_RULES, GEO_SHAPE } from './compliance-schema.js';
import { corsOriginsSchema } from './cors-origins.js';
import { isPlaintextPostgresUrl, isPlaintextRedisUrl } from './dev-only-rules.js';

export { corsOriginsSchema } from './cors-origins.js';

const TLS_RULES = { DATABASE_URL: isPlaintextPostgresUrl, REDIS_URL: isPlaintextRedisUrl };

/**
 * Field encryption (playbook Step 3). Cross-field requirements (KMS key ID for kms, exactly one
 * blind index key source) are checked by @reef/crypto-fields at startup.
 */
const FIELD_ENCRYPTION_SHAPE = {
  FIELD_ENCRYPTION_PROVIDER: z.enum(['kms', 'local']),
  FIELD_ENCRYPTION_KMS_KEY_ID: z.string().min(1).optional(),
  FIELD_ENCRYPTION_LOCAL_KEY_FILE: z.string().min(1).optional(),
  BLIND_INDEX_KEY: z.string().min(1).optional(),
  BLIND_INDEX_KEY_FILE: z.string().min(1).optional(),
};

// Local key files are for development only; production uses KMS and Secrets Manager.
const FIELD_ENCRYPTION_RULES = {
  FIELD_ENCRYPTION_PROVIDER: (value: unknown) => value === 'local',
  FIELD_ENCRYPTION_LOCAL_KEY_FILE: (value: unknown) => value !== undefined,
  BLIND_INDEX_KEY_FILE: (value: unknown) => value !== undefined,
};

const HTTP_SHAPE = {
  API_HOST: z.string().min(1).default('0.0.0.0'),
  CORS_ORIGINS: corsOriginsSchema,
  // Load balancer hops in front of the API, so request.ip is the client, not the proxy.
  TRUST_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).default(300),
  SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(1000).default(10_000),
};

/** Env schema for `apps/api`. */
export const apiEnvSchema = defineEnvSchema(
  {
    API_PORT: portSchema,
    ...HTTP_SHAPE,
    DATABASE_URL: postgresUrlSchema,
    REDIS_URL: redisUrlSchema,
    ...FIELD_ENCRYPTION_SHAPE,
    ...AUTH_SHAPE,
    ...GEO_SHAPE,
  },
  {
    ...TLS_RULES,
    ...FIELD_ENCRYPTION_RULES,
    ...AUTH_DEV_ONLY_RULES,
    ...GEO_DEV_ONLY_RULES,
    // Plain-http origins are for local development only.
    CORS_ORIGINS: (value: unknown) =>
      Array.isArray(value) && value.some((origin) => String(origin).startsWith('http:')),
  },
);

/** Parsed env for `apps/api`. */
export type ApiEnv = z.output<typeof apiEnvSchema>;

/** Env schema for `apps/workers`. */
export const workersEnvSchema = defineEnvSchema(
  { DATABASE_URL: postgresUrlSchema, REDIS_URL: redisUrlSchema, ...FIELD_ENCRYPTION_SHAPE },
  { ...TLS_RULES, ...FIELD_ENCRYPTION_RULES },
);

/** Parsed env for `apps/workers`. */
export type WorkersEnv = z.output<typeof workersEnvSchema>;

/** Env schema for `apps/game-server`. Spec §8.1: it reaches Postgres only through the API. */
export const gameServerEnvSchema = defineEnvSchema(
  { GAME_SERVER_PORT: portSchema, REDIS_URL: redisUrlSchema },
  { REDIS_URL: isPlaintextRedisUrl },
);

/** Parsed env for `apps/game-server`. */
export type GameServerEnv = z.output<typeof gameServerEnvSchema>;
