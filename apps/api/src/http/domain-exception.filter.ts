import { Catch, Inject, type ArgumentsHost, type ExceptionFilter } from '@nestjs/common';
import type { Logger } from '@reef/logger';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { LOGGER } from '../app/tokens.js';
import { toErrorResponse } from './error-response.js';

/**
 * Global filter: every error leaves the API as `{ error: { code, message, requestId } }`.
 * This is the boundary that logs server errors (CLAUDE.md: log once, where handled).
 */
@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: Logger) {}

  /** @param error Thrown value. @param host Request context. */
  catch(error: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<FastifyRequest>();
    const reply = http.getResponse<FastifyReply>();
    const response = toErrorResponse(error, request.id);
    if (response.isServerError) {
      this.logger.error({ err: error, route: request.routeOptions.url }, 'request failed');
    }
    void reply.status(response.status).headers(response.headers).send(response.body);
  }
}
