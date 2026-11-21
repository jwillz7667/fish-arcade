import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import { ComplianceBlockedError } from '@reef/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { CLOCK } from '../../app/tokens.js';
import { RequireJurisdiction } from '../../compliance/index.js';
import { RateLimit } from '../../http/rate-limit/rate-limit.decorator.js';
import type { Clock } from '../../shared/clock.js';
import { Public } from '../guards/public.decorator.js';
import { OtpService } from '../otp/otp-service.js';
import { SignupService } from '../signup/signup-service.js';
import {
  otpResendBody,
  otpVerifyBody,
  signupCompleteBody,
  signupPasskeyOptionsBody,
  signupStartBody,
} from './schemas.js';
import { deliverTokens, type SessionResponse } from './token-delivery.js';

/** Player signup (spec §5.1, §12): `POST /v1/auth/signup` and the steps that follow it. */
@Controller('auth')
@Public()
export class SignupController {
  constructor(
    @Inject(SignupService) private readonly signup: SignupService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /** Step 1 (location-gated): bot check, then a code to the email or phone. Same response whether or not an account exists. */
  @Post('signup')
  @HttpCode(202)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  @RequireJurisdiction('signup')
  async start(
    @Body({ schema: signupStartBody }) body: z.infer<typeof signupStartBody>,
    @Req() request: FastifyRequest,
  ): Promise<{ challengeId: string }> {
    return this.signup.start({
      contact: body.contact,
      turnstileToken: body.turnstileToken,
      ip: request.ip,
    });
  }

  /** Step 2: the code. Returns a 15-minute signup ticket. */
  @Post('otp/verify')
  @HttpCode(200)
  @RateLimit({ limit: 30, windowSeconds: 60 })
  async verify(
    @Body({ schema: otpVerifyBody }) body: z.infer<typeof otpVerifyBody>,
    @Req() request: FastifyRequest,
  ): Promise<{ signupTicket: string }> {
    return this.signup.verifyCode({ ...body, ip: request.ip });
  }

  /** A new code for the same challenge, after the 60-second cooldown. */
  @Post('otp/resend')
  @HttpCode(202)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  async resend(
    @Body({ schema: otpResendBody }) body: z.infer<typeof otpResendBody>,
  ): Promise<{ status: 'sent' }> {
    await this.otp.resend(body.challengeId, 'signup');
    return { status: 'sent' };
  }

  /** Passkey signup: registration options bound to the signup ticket. */
  @Post('signup/passkey-options')
  @HttpCode(200)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  async passkeyOptions(
    @Body({ schema: signupPasskeyOptionsBody }) body: z.infer<typeof signupPasskeyOptionsBody>,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return this.signup.passkeyOptions(body);
  }

  /** Step 3 (location-gated): profile plus password or passkey. Creates the account and signs it in. */
  @Post('signup/complete')
  @HttpCode(201)
  @RateLimit({ limit: 10, windowSeconds: 60 })
  @RequireJurisdiction('signup')
  async complete(
    @Body({ schema: signupCompleteBody }) body: z.infer<typeof signupCompleteBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<SessionResponse> {
    const location = request.jurisdiction;
    if (location === undefined) throw new ComplianceBlockedError();
    const tokens = await this.signup.complete({
      ...body,
      ip: request.ip,
      locationRule: location.rule,
    });
    return deliverTokens(request, reply, tokens, this.clock.now());
  }
}
