import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { AuthError } from '@reef/errors';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/server';
import type { FastifyRequest } from 'fastify';
import type { z } from 'zod';

import { principalOf, type Principal } from '../../http/principal.js';
import { RateLimit } from '../../http/rate-limit/rate-limit.decorator.js';
import { ContactChangeService } from '../contact/contact-change-service.js';
import { MfaService } from '../mfa/mfa-service.js';
import { OtpService } from '../otp/otp-service.js';
import { PasskeyService } from '../passkeys/passkey-service.js';
import { SessionService } from '../sessions/session-service.js';
import { RequireRecentAuth, RequireStepUp } from '../step-up/step-up.guard.js';
import {
  contactChangeBody,
  otpResendBody,
  otpVerifyBody,
  passkeyRegisterBody,
  totpConfirmBody,
} from './schemas.js';

function principal(request: FastifyRequest): Principal {
  const found = principalOf(request);
  if (found === undefined) throw new AuthError();
  return found;
}

/** Signed-in account security: TOTP, passkeys, and contact changes (playbook Step 6). */
@Controller('auth')
@RateLimit({ limit: 20, windowSeconds: 60, by: 'principal' })
export class AccountSecurityController {
  constructor(
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(PasskeyService) private readonly passkeys: PasskeyService,
    @Inject(ContactChangeService) private readonly contact: ContactChangeService,
    @Inject(OtpService) private readonly otp: OtpService,
    @Inject(SessionService) private readonly sessions: SessionService,
  ) {}

  /** Starts TOTP enrolment (recent login required): returns the secret and an `otpauth://` URI. */
  @Post('2fa/totp/setup')
  @HttpCode(200)
  @RequireRecentAuth()
  async totpSetup(@Req() request: FastifyRequest): Promise<{ secret: string; otpauthUri: string }> {
    return this.mfa.beginTotpSetup(principal(request).userId);
  }

  /** Finishes TOTP enrolment and returns 10 single-use recovery codes, shown once. */
  @Post('2fa/totp/confirm')
  @HttpCode(200)
  async totpConfirm(
    @Body({ schema: totpConfirmBody }) body: z.infer<typeof totpConfirmBody>,
    @Req() request: FastifyRequest,
  ): Promise<{ recoveryCodes: string[] }> {
    return this.mfa.confirmTotpSetup({
      userId: principal(request).userId,
      code: body.code,
      ip: request.ip,
    });
  }

  /** Turns 2FA off. Step-up required; every other session is signed out. */
  @Post('2fa/totp/disable')
  @HttpCode(204)
  @RequireStepUp()
  async totpDisable(@Req() request: FastifyRequest): Promise<void> {
    const { userId, sessionId } = principal(request);
    await this.mfa.disable({ userId, ip: request.ip });
    await this.sessions.revokeOthers({
      userId,
      keepSessionId: sessionId,
      reason: 'mfa_disabled',
      ip: request.ip,
    });
  }

  /** Starts adding a passkey: recent login, plus a 2FA code if 2FA is on. */
  @Post('passkeys/options')
  @HttpCode(200)
  @RequireRecentAuth()
  async passkeyOptions(
    @Req() request: FastifyRequest,
  ): Promise<PublicKeyCredentialCreationOptionsJSON> {
    return this.passkeys.startRegistration(principal(request).userId);
  }

  /** Finishes adding a passkey. */
  @Post('passkeys')
  @HttpCode(201)
  async passkeyRegister(
    @Body({ schema: passkeyRegisterBody }) body: z.infer<typeof passkeyRegisterBody>,
    @Req() request: FastifyRequest,
  ): Promise<{ status: 'registered' }> {
    await this.passkeys.finishRegistration({
      userId: principal(request).userId,
      response: body.response,
      ip: request.ip,
    });
    return { status: 'registered' };
  }

  /** Starts an email or phone change. Step-up required; a code goes to the new contact. */
  @Post('contact')
  @HttpCode(202)
  @RequireStepUp()
  async contactChange(
    @Body({ schema: contactChangeBody }) body: z.infer<typeof contactChangeBody>,
    @Req() request: FastifyRequest,
  ): Promise<{ challengeId: string }> {
    return this.contact.start({
      userId: principal(request).userId,
      contact: body.contact,
      ip: request.ip,
    });
  }

  /** Applies the change with the code sent to the new contact. */
  @Post('contact/verify')
  @HttpCode(204)
  async contactVerify(
    @Body({ schema: otpVerifyBody }) body: z.infer<typeof otpVerifyBody>,
    @Req() request: FastifyRequest,
  ): Promise<void> {
    const { userId, sessionId } = principal(request);
    await this.contact.verify({
      userId,
      sessionId,
      challengeId: body.challengeId,
      code: body.code,
      ip: request.ip,
    });
  }

  /** A new code for a pending contact change. */
  @Post('contact/resend')
  @HttpCode(202)
  async contactResend(
    @Body({ schema: otpResendBody }) body: z.infer<typeof otpResendBody>,
    @Req() request: FastifyRequest,
  ): Promise<{ status: 'sent' }> {
    await this.otp.resend(body.challengeId, 'contact_change', principal(request).userId);
    return { status: 'sent' };
  }
}
