import { Body, Get, HttpCode, Inject, Post, Query, Req, Res } from '@nestjs/common';
import { AuthError } from '@reef/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { readCookies } from '../../auth/http/cookies.js';
import { RateLimit } from '../../http/rate-limit/rate-limit.decorator.js';
import type { Clock } from '../../shared/clock.js';
import { CLOCK } from '../../app/tokens.js';
import type { Permission } from '../admin-permissions.js';
import { ADMIN_WEB_ORIGIN } from '../admin-tokens.js';
import {
  ADMIN_COOKIES,
  clearAdminCookies,
  setAdminMfaCookie,
  setAdminOidcCookie,
  setAdminSessionCookies,
} from '../http/admin-cookies.js';
import {
  AdminController,
  AdminPublic,
  adminOf,
  RequirePermission,
} from '../http/admin-decorators.js';
import { AdminLoginService, type AdminMfaStep } from './admin-login-service.js';
import { AdminSessionService } from './admin-session-service.js';

const devLoginBody = z.object({ email: z.email() });
const mfaBody = z.object({ code: z.string().regex(/^\d{6}$/, 'must be 6 digits') });
const callbackQuery = z.object({
  code: z.string().min(1).max(2_048),
  state: z.string().min(1).max(256),
});

function mfaTicketOf(request: FastifyRequest): string {
  const ticket = readCookies(request).get(ADMIN_COOKIES.mfaTicket);
  if (ticket === undefined || ticket === '')
    throw new AuthError({ message: 'No admin MFA ticket' });
  return ticket;
}

/** Back office sign-in (playbook Step 9): SSO or dev login, then mandatory TOTP. */
@AdminController('auth')
export class AdminAuthController {
  constructor(
    @Inject(AdminLoginService) private readonly login: AdminLoginService,
    @Inject(AdminSessionService) private readonly sessions: AdminSessionService,
    @Inject(ADMIN_WEB_ORIGIN) private readonly webOrigin: string,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Development only: sign in as a seeded admin by email, then do MFA. */
  @Post('dev-login')
  @HttpCode(200)
  @AdminPublic()
  @RateLimit({ limit: 10, windowSeconds: 60 })
  async devLogin(
    @Body({ schema: devLoginBody }) body: z.infer<typeof devLoginBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ next: AdminMfaStep }> {
    const { mfaTicket, next } = await this.login.devLogin({ email: body.email, ip: request.ip });
    setAdminMfaCookie(reply, mfaTicket);
    return { next };
  }

  /** Redirects to the IdP. */
  @Get('oidc/start')
  @AdminPublic()
  @RateLimit({ limit: 20, windowSeconds: 60 })
  async startOidc(@Res() reply: FastifyReply): Promise<void> {
    const { authorizationUrl, handle } = await this.login.startOidc();
    setAdminOidcCookie(reply, handle);
    await reply.redirect(authorizationUrl, 302);
  }

  /** The IdP redirects here; on success the browser goes on to the admin app's MFA page. */
  @Get('oidc/callback')
  @AdminPublic()
  @RateLimit({ limit: 20, windowSeconds: 60 })
  async finishOidc(
    @Query({ schema: callbackQuery }) query: z.infer<typeof callbackQuery>,
    @Req() request: FastifyRequest,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const handle = readCookies(request).get(ADMIN_COOKIES.oidc);
    const { mfaTicket, next } = await this.login.finishOidc({ ...query, handle, ip: request.ip });
    setAdminMfaCookie(reply, mfaTicket);
    await reply.redirect(`${this.webOrigin}/login/mfa?next=${next}`, 302);
  }

  /** First login: start TOTP enrolment. */
  @Post('mfa/setup')
  @HttpCode(200)
  @AdminPublic()
  @RateLimit({ limit: 10, windowSeconds: 60 })
  async setupMfa(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ secret: string; otpauthUri: string }> {
    void reply.header('cache-control', 'no-store');
    return this.login.beginMfaSetup(mfaTicketOf(request));
  }

  /** Enrolment confirmation or a regular TOTP code; starts the admin session. */
  @Post('mfa/verify')
  @HttpCode(200)
  @AdminPublic()
  @RateLimit({ limit: 20, windowSeconds: 60 })
  async verifyMfa(
    @Body({ schema: mfaBody }) body: z.infer<typeof mfaBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ csrfToken: string; expiresAt: string }> {
    const session = await this.login.completeMfa({
      mfaTicket: mfaTicketOf(request),
      code: body.code,
      ip: request.ip,
    });
    void reply.header('cache-control', 'no-store');
    setAdminSessionCookies(reply, session, this.clock.now());
    return { csrfToken: session.csrfToken, expiresAt: session.expiresAt.toISOString() };
  }

  /** The signed-in admin, their roles, and permissions. */
  @Get('session')
  @RequirePermission()
  session(@Req() request: FastifyRequest): {
    adminId: string;
    email: string;
    roles: readonly string[];
    permissions: Permission[];
  } {
    const admin = adminOf(request);
    return {
      adminId: admin.adminId,
      email: admin.email,
      roles: admin.roles,
      permissions: [...admin.permissions].sort(),
    };
  }

  /** Ends the session. */
  @Post('logout')
  @HttpCode(204)
  @RequirePermission()
  async logout(
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const admin = adminOf(request);
    await this.sessions.revoke({
      sessionId: admin.sessionId,
      adminId: admin.adminId,
      reason: 'logout',
      ip: request.ip,
    });
    request.adminAudit = {
      action: 'admin.logout',
      targetType: 'admin_session',
      targetId: admin.sessionId,
    };
    clearAdminCookies(reply);
  }
}
