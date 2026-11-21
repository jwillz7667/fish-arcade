import type { LoggerService } from '@nestjs/common';
import type { Logger } from '@reef/logger';

function text(message: unknown): string {
  return typeof message === 'string' ? message : JSON.stringify(message);
}

/** Routes NestJS framework logs into the platform's redacting pino logger. */
export class NestPinoLogger implements LoggerService {
  constructor(private readonly logger: Logger) {}

  /** @param message Framework message. @param context Nest context name. */
  log(message: unknown, context?: string): void {
    this.logger.info({ context }, text(message));
  }

  /** @param message Framework message. @param stack Stack trace. @param context Nest context name. */
  error(message: unknown, stack?: string, context?: string): void {
    this.logger.error({ context, stack }, text(message));
  }

  /** @param message Framework message. @param context Nest context name. */
  warn(message: unknown, context?: string): void {
    this.logger.warn({ context }, text(message));
  }

  /** @param message Framework message. @param context Nest context name. */
  debug(message: unknown, context?: string): void {
    this.logger.debug({ context }, text(message));
  }

  /** @param message Framework message. @param context Nest context name. */
  verbose(message: unknown, context?: string): void {
    this.logger.trace({ context }, text(message));
  }
}
