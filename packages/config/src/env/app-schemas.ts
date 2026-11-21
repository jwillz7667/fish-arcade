import type { z } from 'zod';

import {
  defineEnvSchema,
  portSchema,
  postgresUrlSchema,
  redisUrlSchema,
} from './define-env-schema.js';
import { isPlaintextPostgresUrl, isPlaintextRedisUrl } from './dev-only-rules.js';

const TLS_RULES = { DATABASE_URL: isPlaintextPostgresUrl, REDIS_URL: isPlaintextRedisUrl };

/** Env schema for `apps/api`. */
export const apiEnvSchema = defineEnvSchema(
  { API_PORT: portSchema, DATABASE_URL: postgresUrlSchema, REDIS_URL: redisUrlSchema },
  TLS_RULES,
);

/** Parsed env for `apps/api`. */
export type ApiEnv = z.output<typeof apiEnvSchema>;

/** Env schema for `apps/workers`. */
export const workersEnvSchema = defineEnvSchema(
  { DATABASE_URL: postgresUrlSchema, REDIS_URL: redisUrlSchema },
  TLS_RULES,
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
