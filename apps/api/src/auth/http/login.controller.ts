import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/server';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { CLOCK } from '../../app/tokens.js';
import { RateLimit } from '../../http/rate-limit/rate-limit.decorator.js';
import type { Clock } from '../../shared/clock.js';
import { Public } from '../guards/public.decorator.js';
import { LoginService } from '../login/login-service.js';
import { PasskeyService } from '../passkeys/passkey-service.js';
import { loginBody, loginMfaBody, passkeyLoginBody } from './schemas.js';
import { deliverTokens, type SessionResponse } from './token-delivery.js';

/** Password, MFA, and passkey login (spec §12: `POST /v1/auth/login`). */
@Controller('auth')
@Public()
export class LoginController {
  constructor(
    @Inject(LoginService) private readonly login: LoginService,
    @Inject(PasskeyService) private readonly passkeys: PasskeyService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Password login. Returns an MFA ticket instead of tokens when the account has TOTP. */
  @Post('login')
  @HttpCode(200)
  @RateLimit({ limit: 30, windowSeconds: 60 })
  async loginWithPassword(
    @Body({ schema: loginBody }) body: z.infer<typeof loginBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse | { status: 'mfa_required'; mfaTicket: string }> {
    const result = await this.login.loginWithPassword({ ...body, ip: request.ip });
    if (result.status === 'mfa_required') {
      void reply.header('cache-control', 'no-store');
      return { status: 'mfa_required', mfaTicket: result.mfaTicket };
    }
    return deliverTokens(request, reply, result.tokens, this.clock.now());
  }

  /** Second step: a TOTP code or a recovery code. */
  @Post('login/mfa')
  @HttpCode(200)
  @RateLimit({ limit: 30, windowSeconds: 60 })
  async completeMfa(
    @Body({ schema: loginMfaBody }) body: z.infer<typeof loginMfaBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const tokens = await this.login.completeMfa({ ...body, ip: request.ip });
    return deliverTokens(request, reply, tokens, this.clock.now());
  }

  /** Passkey login, step 1: a challenge for `navigator.credentials.get()`. */
  @Post('passkey/options')
  @HttpCode(200)
  @RateLimit({ limit: 30, windowSeconds: 60 })
  async passkeyOptions(): Promise<{
    challengeId: string;
    options: PublicKeyCredentialRequestOptionsJSON;
  }> {
    return this.passkeys.startLogin();
  }

  /** Passkey login, step 2: the signed assertion. */
  @Post('passkey/login')
  @HttpCode(200)
  @RateLimit({ limit: 30, windowSeconds: 60 })
  async loginWithPasskey(
    @Body({ schema: passkeyLoginBody }) body: z.infer<typeof passkeyLoginBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const tokens = await this.login.loginWithPasskey({ ...body, ip: request.ip });
    return deliverTokens(request, reply, tokens, this.clock.now());
  }
}
