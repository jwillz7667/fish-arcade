import type { LoggerService } from '@nestjs/common';
import type { Logger } from '@reef/logger';

/**
 * Nest sometimes logs objects. They go in a field, where the logger's redaction sees them,
 * never stringified into the message, which is not inspected.
 */
function entry(
  message: unknown,
  fields: Record<string, unknown>,
): [Record<string, unknown>, string] {
  if (typeof message === 'string') return [fields, message];
  return [{ ...fields, detail: message }, 'nest framework message'];
}

/** Routes NestJS framework logs into the platform's redacting pino logger. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  /** @param message Framework message. @param context Nest context name. */
  log(message: unknown, context?: string): void {
    this.logger.info(...entry(message, { context }));
  }

  /** @param message Framework message. @param stack Stack trace. @param context Nest context name. */
  error(message: unknown, stack?: string, context?: string): void {
    this.logger.error(...entry(message, { context, stack }));
  }

  /** @param message Framework message. @param context Nest context name. */
  warn(message: unknown, context?: string): void {
    this.logger.warn(...entry(message, { context }));
  }

  /** @param message Framework message. @param context Nest context name. */
  debug(message: unknown, context?: string): void {
    this.logger.debug(...entry(message, { context }));
  }

  /** @param message Framework message. @param context Nest context name. */
  verbose(message: unknown, context?: string): void {
    this.logger.trace(...entry(message, { context }));
  }
}
