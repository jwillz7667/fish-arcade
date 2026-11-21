import { pino, type DestinationStream, type Logger } from 'pino';

import { redactSensitive } from './redact.js';
import type { RequestContext } from './request-context.js';

/** Log levels accepted by {@link createLogger}. */
export type LogLevel = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';

/** Options for {@link createLogger}. */
export interface LoggerOptions {
  /** Service name written to every line as `service`. */
  readonly service: string;
  /** Minimum level to write. */
  readonly level: LogLevel;
  /** Request scope that supplies `requestId`. */
  readonly context: RequestContext;
  /** Where to write. Defaults to stdout. */
  readonly destination?: DestinationStream;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function redactChildBindings(child: Logger): void {
  // pino stores child bindings as a JSON fragment with a leading comma: `,"key":"value"`.
  const fragment = String(Reflect.get(child, pino.symbols.chindingsSym));
  const parsed: unknown = JSON.parse(`{${fragment.slice(1)}}`);
  if (!isRecord(parsed)) return;
  const json = JSON.stringify(redactSensitive(parsed));
  Reflect.set(child, pino.symbols.chindingsSym, `,${json.slice(1, -1)}`);
}

/**
 * Creates the platform's JSON logger. Every line carries `service` and, inside a request
 * scope, `requestId`. Every field, including child bindings, passes through
 * {@link redactSensitive}. Message strings are not inspected, so never interpolate data into them.
 *
 * @param options Service name, level, request context, and optional destination.
 * @returns A pino logger.
 */
export function createLogger(options: LoggerOptions): Logger {
  const { context } = options;
  return pino(
    {
      level: options.level,
      base: { service: options.service },
      timestamp: pino.stdTimeFunctions.isoTime,
      // The error serializer would run after redaction and reintroduce raw Error fields.
      serializers: { err: (value: unknown) => value },
      mixin: () => {
        const requestId = context.getRequestId();
        return requestId === undefined ? {} : { requestId };
      },
      formatters: {
        level: (label) => ({ level: label }),
        bindings: (bindings) => redactSensitive(bindings),
        log: (payload) => redactSensitive(payload),
      },
      // pino skips the bindings formatter for child loggers, so their bindings are redacted here.
      onChild: redactChildBindings,
    },
    options.destination ?? pino.destination(1),
  );
}

export type { Logger };
