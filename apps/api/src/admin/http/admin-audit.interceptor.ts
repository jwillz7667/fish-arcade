import {
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { isDomainError } from '@reef/errors';
import type { FastifyRequest } from 'fastify';
import { catchError, concatMap, from, type Observable } from 'rxjs';

import { AuditWriter } from '../../audit/audit-writer.js';
import { ADMIN_METADATA } from './admin-decorators.js';
import { auditDiff } from './audit-diff.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Records every admin write (playbook Step 9): actor, action, target, a PII-masked before/after
 * diff, and IP. Handlers describe the change with `request.adminAudit`; without it, the row
 * still names the route. Failed writes are recorded too, with their error code. Routes whose
 * service audits in the same transaction (`@AuditedInTransaction`) and pre-session routes
 * (`@AdminPublic`, which audit themselves) are skipped.
 */
@Injectable()
export class AdminAuditInterceptor implements NestInterceptor {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
  ) {}

  /**
   * @param context Current request.
   * @param next The handler.
   * @returns The handler's result, after its audit row is written.
   */
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const handler = context.getHandler();
    const isSkipped =
      SAFE_METHODS.has(request.method) ||
      this.reflector.get<boolean | undefined>(ADMIN_METADATA.isPublic, handler) === true ||
      this.reflector.get<boolean | undefined>(ADMIN_METADATA.isAuditedInTransaction, handler) ===
        true;
    if (isSkipped) return next.handle();

    const route = `${context.getClass().name}.${handler.name}`;
    return next.handle().pipe(
      concatMap((result: unknown) =>
        from(this.#record(request, route, undefined).then(() => result)),
      ),
      catchError((error: unknown) =>
        from(
          this.#record(request, route, isDomainError(error) ? error.code : 'INTERNAL').then(() => {
            throw error;
          }),
        ),
      ),
    );
  }

  async #record(
    request: FastifyRequest,
    route: string,
    failureCode: string | undefined,
  ): Promise<void> {
    const context = request.adminAudit;
    const action = context?.action ?? `admin.${route}`;
    await this.audit.record({
      actorType: 'admin',
      actorId: request.admin?.adminId ?? null,
      action: failureCode === undefined ? action : `${action}.failed`,
      ...(context === undefined
        ? {}
        : { targetType: context.targetType, targetId: context.targetId }),
      diff:
        failureCode === undefined
          ? auditDiff(context?.before, context?.after)
          : { before: null, after: { error: failureCode } },
      ip: request.ip,
    });
  }
}
