import { BlockList, isIPv4 } from 'node:net';

import { Inject, Injectable, type CanActivate, type ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthError, ErrorCode, ForbiddenError } from '@reef/errors';
import type { FastifyRequest } from 'fastify';

import { AuditWriter } from '../../audit/audit-writer.js';
import { readCookies } from '../../auth/http/cookies.js';
import type { Permission } from '../admin-permissions.js';
import { AdminSessionService } from '../auth/admin-session-service.js';
import { ADMIN_IP_ALLOWLIST } from '../admin-tokens.js';
import { ADMIN_COOKIES } from './admin-cookies.js';
import { ADMIN_METADATA } from './admin-decorators.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Builds an allowlist from CIDR blocks.
 *
 * @param cidrs Validated CIDR strings from ADMIN_IP_ALLOWLIST.
 * @returns A BlockList used as an allowlist.
 */
export function buildAllowlist(cidrs: readonly string[]): BlockList {
  const list = new BlockList();
  for (const cidr of cidrs) {
    const [address = '', bits = ''] = cidr.split('/');
    list.addSubnet(address, Number.parseInt(bits, 10), isIPv4(address) ? 'ipv4' : 'ipv6');
  }
  return list;
}

/**
 * @param allowlist From {@link buildAllowlist}.
 * @param ip Client IP, possibly IPv4-mapped IPv6.
 * @returns True when the IP is inside the allowlist.
 */
export function isIpAllowed(allowlist: BlockList, ip: string): boolean {
  // IPv4 clients can arrive as IPv4-mapped IPv6 (::ffff:10.0.0.1).
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip)?.[1];
  if (mapped !== undefined) return allowlist.check(mapped, 'ipv4');
  return allowlist.check(ip, isIPv4(ip) ? 'ipv4' : 'ipv6');
}

/**
 * The back office gate (playbook Step 9, spec §13.3), in order: the IP allowlist, then (unless
 * `@AdminPublic`) a valid admin session from its Strict cookie, the CSRF header on writes, and
 * the route's `@RequirePermission`. A route with no permission metadata is refused: there is
 * no default access. Denials after sign-in are audited.
 */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(AdminSessionService) private readonly sessions: AdminSessionService,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(ADMIN_IP_ALLOWLIST) private readonly allowlist: BlockList,
  ) {}

  /**
   * @param context Current request.
   * @returns True when every check passes.
   * @throws ForbiddenError when the IP is not allowed, the CSRF token is wrong, or the
   *   permission is missing.
   * @throws AuthError when there is no valid admin session.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    if (!isIpAllowed(this.allowlist, request.ip)) {
      throw new ForbiddenError({ message: 'Admin request from an address outside the allowlist' });
    }
    const handler = context.getHandler();
    if (this.reflector.get<boolean | undefined>(ADMIN_METADATA.isPublic, handler) === true)
      return true;

    const token = readCookies(request).get(ADMIN_COOKIES.session);
    if (token === undefined || token === '') throw new AuthError();
    const admin = await this.sessions.authenticate(token);
    if (!SAFE_METHODS.has(request.method)) {
      const header = request.headers['x-csrf-token'];
      if (
        !this.sessions.isValidCsrf(admin.sessionId, typeof header === 'string' ? header : undefined)
      ) {
        throw new ForbiddenError({ code: ErrorCode.CSRF_INVALID });
      }
    }
    request.admin = admin;

    const required = this.reflector.get<Permission[] | undefined>(
      ADMIN_METADATA.permissions,
      handler,
    );
    const missing =
      required === undefined
        ? ['(none declared)']
        : required.filter((p) => !admin.permissions.has(p));
    if (missing.length > 0) {
      await this.audit.record({
        actorType: 'admin',
        actorId: admin.adminId,
        action: 'admin.permission_denied',
        details: {
          route: `${context.getClass().name}.${handler.name}`,
          missing: missing.join(','),
        },
        ip: request.ip,
      });
      throw new ForbiddenError();
    }
    return true;
  }
}
