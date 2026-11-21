import { z } from 'zod';

/** `NODE_ENV` values the platform runs under. */
export const nodeEnvSchema = z.enum(['development', 'test', 'production']);

/** `LOG_LEVEL` values, matching the logger. Defaults to `info`. */
export const logLevelSchema = z
  .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
  .default('info');

/** A TCP port from an env string. */
export const portSchema = z.coerce.number().int().min(1).max(65535);

/** A Postgres connection URL. */
export const postgresUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });

/** A Redis connection URL, plain (`redis:`) or TLS (`rediss:`). */
export const redisUrlSchema = z.url({ protocol: /^rediss?$/ });

/**
 * Per-variable predicates that return true when a value is only acceptable outside
 * production, such as a stub provider or a non-TLS connection.
 */
export type DevOnlyRules<Shape extends z.ZodRawShape> = {
  readonly [Key in keyof Shape]?: (value: unknown) => boolean;
};

/** Message for a dev-only value found in production. Names the rule, never the value. */
export const DEV_ONLY_MESSAGE = 'is a development-only setting and is not allowed in production';

/**
 * Builds an app's env schema: `NODE_ENV` and `LOG_LEVEL` plus the app's own variables. When
 * `NODE_ENV=production`, every value matched by a `devOnly` predicate is rejected.
 *
 * @param shape The app's variables.
 * @param devOnly Predicates marking values that must never reach production.
 * @returns A zod schema to pass to `loadEnv` or `parseEnv`.
 */
export function defineEnvSchema<Shape extends z.ZodRawShape>(
  shape: Shape,
  devOnly: DevOnlyRules<Shape> = {},
) {
  return z
    .object({ NODE_ENV: nodeEnvSchema, LOG_LEVEL: logLevelSchema, ...shape })
    .superRefine((env, ctx) => {
      if (Reflect.get(env, 'NODE_ENV') !== 'production') return;
      for (const [key, isDevOnly] of Object.entries<((value: unknown) => boolean) | undefined>(
        devOnly,
      )) {
        if (isDevOnly?.(Reflect.get(env, key)) === true) {
          ctx.addIssue({ code: 'custom', path: [key], message: DEV_ONLY_MESSAGE });
        }
      }
    });
}
