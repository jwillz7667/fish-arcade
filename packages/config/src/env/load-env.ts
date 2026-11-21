import { ConfigError, type ValidationIssue } from '@reef/errors';
import type { z } from 'zod';

/** A process environment: variable names to raw string values. */
export type EnvSource = Readonly<Record<string, string | undefined>>;

/**
 * Validates `source` against `schema`.
 *
 * @param schema An env schema, usually from `defineEnvSchema`.
 * @param source Raw variables.
 * @returns The parsed, typed env.
 * @throws ConfigError listing each invalid variable and what is wrong. Values never appear.
 */
export function parseEnv<Schema extends z.ZodType>(
  schema: Schema,
  source: EnvSource,
): z.output<Schema> {
  const result = schema.safeParse(source);
  if (result.success) return result.data;
  const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
  throw new ConfigError({
    issues,
    message: `Invalid environment variables: ${issues.map((issue) => issue.path).join(', ')}`,
  });
}

/**
 * Renders a {@link ConfigError} for a human reading startup output.
 *
 * @param error The error from {@link parseEnv}.
 * @returns One line per invalid variable.
 */
export function formatConfigError(error: ConfigError): string {
  const lines = error.issues.map((issue) => `  ${issue.path}: ${issue.message}`);
  return `Invalid environment configuration:\n${lines.join('\n')}\n`;
}

/** Process hooks used by {@link loadEnv}. Injected so tests never exit the test runner. */
export interface EnvLoadIo {
  /** Raw variables. */
  readonly source: EnvSource;
  /** Where the failure report goes. */
  readonly stderr: { write(text: string): unknown };
  /** Ends the process. */
  readonly exit: (code: number) => never;
}

const processIo: EnvLoadIo = {
  source: process.env,
  stderr: process.stderr,
  exit: (code) => process.exit(code),
};

/**
 * Parses the env at startup. On failure it prints which variables are missing or invalid
 * (never their values) and exits with code 1.
 *
 * @param schema An env schema, usually from `defineEnvSchema`.
 * @param io Process hooks. Defaults to the real process.
 * @returns The parsed, typed env.
 * @throws Any error other than ConfigError, unchanged.
 */
export function loadEnv<Schema extends z.ZodType>(
  schema: Schema,
  io: EnvLoadIo = processIo,
): z.output<Schema> {
  try {
    return parseEnv(schema, io.source);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    io.stderr.write(formatConfigError(error));
    return io.exit(1);
  }
}
