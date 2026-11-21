import { Body, Controller, Get, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { AuthError, ErrorCode, isDomainError } from '@reef/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { CLOCK } from '../../app/tokens.js';
import { principalOf } from '../../http/principal.js';
import { RateLimit } from '../../http/rate-limit/rate-limit.decorator.js';
import type { Clock } from '../clock.js';
import { Public } from '../guards/public.decorator.js';
import { MfaService } from '../mfa/mfa-service.js';
import { SessionService, type RefreshRequest } from '../sessions/session-service.js';
import { clearSessionCookies, COOKIE_NAMES, readCookies } from './cookies.js';
import { refreshBody } from './schemas.js';
import { deliverTokens, type SessionResponse } from './token-delivery.js';

/** The signed-in session, as `GET /v1/auth/session` reports it. */
export interface SessionInfo {
  readonly userId: string;
  readonly sessionId: string;
  readonly authTime: string;
  readonly amr: readonly string[];
  readonly isMfaEnabled: boolean;
}

/**
 * A body token (native apps) needs no CSRF check: a cross-site page cannot know it. A cookie
 * token (browsers) does, because the browser attaches it to any request.
 */
function refreshRequestOf(
  request: FastifyRequest,
  body: z.infer<typeof refreshBody>,
): RefreshRequest | undefined {
  if (body?.refreshToken !== undefined) return { refreshToken: body.refreshToken, ip: request.ip };
  const cookie = readCookies(request).get(COOKIE_NAMES.refresh);
  if (cookie === undefined || cookie === '') return undefined;
  const header = request.headers['x-csrf-token'];
  return {
    refreshToken: cookie,
    ip: request.ip,
    csrfHeader: { value: typeof header === 'string' ? header : undefined },
  };
}

/** Refresh, logout, and session info (spec §12: `/v1/auth/refresh`, `/v1/auth/logout`). */
@Controller('auth')
export class SessionController {
  constructor(
    @Inject(SessionService) private readonly sessions: SessionService,
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Rotates the refresh token. Public: the access token may already have expired. */
  @Post('refresh')
  @Public()
  @HttpCode(200)
  @RateLimit({ limit: 60, windowSeconds: 60 })
  async refresh(
    @Body({ schema: refreshBody }) body: z.infer<typeof refreshBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const refreshRequest = refreshRequestOf(request, body);
    if (refreshRequest === undefined) throw new AuthError({ message: 'No refresh token' });
    try {
      const tokens = await this.sessions.refresh(refreshRequest);
      return deliverTokens(request, reply, tokens, this.clock.now());
    } catch (error) {
      // A dead session's cookies are useless; drop them so the client shows the login page.
      if (isDomainError(error) && error.code === ErrorCode.UNAUTHENTICATED)
        clearSessionCookies(reply);
      throw error;
    }
  }

  /** Ends the session and clears its cookies. Idempotent. */
  @Post('logout')
  @Public()
  @HttpCode(204)
  @RateLimit({ limit: 60, windowSeconds: 60 })
  async logout(
    @Body({ schema: refreshBody }) body: z.infer<typeof refreshBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<void> {
    const refreshRequest = refreshRequestOf(request, body);
    if (refreshRequest !== undefined) await this.sessions.endByRefreshToken(refreshRequest);
    clearSessionCookies(reply);
  }

  /** The current session. */
  @Get('session')
  async session(@Req() request: FastifyRequest): Promise<SessionInfo> {
    const principal = principalOf(request);
    if (principal === undefined) throw new AuthError();
    return {
      userId: principal.userId,
      sessionId: principal.sessionId,
      authTime: principal.authTime.toISOString(),
      amr: principal.amr,
      isMfaEnabled: await this.mfa.isEnrolled(principal.userId),
    };
  }
}
