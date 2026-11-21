import {
  applyDecorators,
  Controller,
  SetMetadata,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

import { Public } from '../../auth/guards/public.decorator.js';
import type { Permission } from '../admin-permissions.js';
import type { AdminPrincipal } from '../auth/admin-session-service.js';
import { AdminAuditInterceptor } from './admin-audit.interceptor.js';
import { AdminGuard } from './admin.guard.js';

/** Metadata keys read by the admin guard and interceptor. */
export const ADMIN_METADATA = {
  permissions: 'reef:admin-permissions',
  isPublic: 'reef:admin-public',
  isAuditedInTransaction: 'reef:admin-audited-in-transaction',
} as const;

/** What a write handler tells the audit interceptor about the change it made. */
export interface AdminAuditContext {
  readonly action: string;
  readonly targetType: string;
  readonly targetId: string;
  readonly before?: Readonly<Record<string, unknown>>;
  readonly after?: Readonly<Record<string, unknown>>;
}

declare module 'fastify' {
  interface FastifyRequest {
    admin?: AdminPrincipal;
    adminAudit?: AdminAuditContext;
  }
}

/**
 * A back office controller under `/v1/admin/<path>` (playbook Step 9). Player auth is off; the
 * admin guard enforces the IP allowlist, an admin session, CSRF on writes, and an explicit
 * permission per route. The audit interceptor records every write.
 *
 * @param path Route prefix after `admin/`.
 * @returns A class decorator.
 */
export const AdminController = (path: string): ClassDecorator =>
  applyDecorators(
    Controller(`admin/${path}`),
    Public(),
    UseGuards(AdminGuard),
    UseInterceptors(AdminAuditInterceptor),
  );

/**
 * Permissions a route needs; all must be held. A route without this decorator (or
 * {@link AdminPublic}) is refused with 403: there is no default access.
 *
 * @param permissions Required permissions. Empty means any signed-in admin.
 * @returns A method decorator.
 */
export const RequirePermission = (...permissions: Permission[]): MethodDecorator =>
  SetMetadata(ADMIN_METADATA.permissions, permissions);

/**
 * Routes used before an admin session exists (login, MFA). The IP allowlist still applies.
 *
 * @returns A method decorator.
 */
export const AdminPublic = (): MethodDecorator => SetMetadata(ADMIN_METADATA.isPublic, true);

/**
 * The handler's service writes the audit row in the same transaction as the change, so the
 * interceptor does not add a second one.
 *
 * @returns A method decorator.
 */
export const AuditedInTransaction = (): MethodDecorator =>
  SetMetadata(ADMIN_METADATA.isAuditedInTransaction, true);

/**
 * @param request Current request; the admin guard has run.
 * @returns The signed-in admin.
 * @throws Error when called on a route without an admin session (a programming error).
 */
export function adminOf(request: FastifyRequest): AdminPrincipal {
  if (request.admin === undefined) throw new Error('adminOf used on a route without an admin');
  return request.admin;
}
