import {
  applyDecorators,
  Inject,
  Injectable,
  SetMetadata,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AuthError, ErrorCode, ForbiddenError, isDomainError } from '@reef/errors';
import type { FastifyRequest } from 'fastify';

import { CLOCK } from '../../app/tokens.js';
import { AuditWriter } from '../../audit/audit-writer.js';
import { principalOf } from '../../http/principal.js';
import { AUTH_POLICY } from '../auth-policy.js';
import type { Clock } from '../../shared/clock.js';
import { BackoffThrottle, secondFactorSubject } from '../login/backoff-throttle.js';
import { MfaService } from '../mfa/mfa-service.js';

const CODE_FORMAT = /^(\d{6}|[A-Za-z0-9-]{10,11})$/;
const ALLOWS_NO_MFA = 'reef:step-up-allows-no-mfa';

/**
 * Step-up auth (playbook Step 6): the session's login must be under 5 minutes old and the
 * request must carry a valid 2FA code. Players without 2FA are refused (spec §5.1: 2FA is
 * required before redemption). Code failures share the per-user backoff with MFA login.
 */
@Injectable()
export class StepUpGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(MfaService) private readonly mfa: MfaService,
    @Inject(BackoffThrottle) private readonly throttle: BackoffThrottle,
    @Inject(AuditWriter) private readonly audit: AuditWriter,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * @param context Current request; the global auth guard has already set the principal.
   * @returns True when step-up passes.
   * @throws AuthError STEP_UP_REQUIRED when the login is stale or no code is sent, or
   *   OTP_INVALID when the code is wrong.
   * @throws ForbiddenError MFA_NOT_ENROLLED when the player has no 2FA (strict step-up only).
   * @throws RateLimitedError while the player is backing off after wrong codes.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = principalOf(request);
    if (principal === undefined) throw new AuthError();
    const age = this.clock.now().getTime() - principal.authTime.getTime();
    if (age > AUTH_POLICY.stepUpMaxAuthAgeMs)
      throw new AuthError({ code: ErrorCode.STEP_UP_REQUIRED });
    // Checked before the code, so players who cannot produce one are told why.
    if (!(await this.mfa.isEnrolled(principal.userId))) {
      const allowsNoMfa = this.reflector.get<boolean | undefined>(
        ALLOWS_NO_MFA,
        context.getHandler(),
      );
      if (allowsNoMfa === true) return true;
      throw new ForbiddenError({ code: ErrorCode.MFA_NOT_ENROLLED });
    }
    const code = request.headers['x-step-up-code'];
    if (typeof code !== 'string' || !CODE_FORMAT.test(code)) {
      throw new AuthError({ code: ErrorCode.STEP_UP_REQUIRED });
    }

    const subject = secondFactorSubject(principal.userId);
    await this.throttle.assertAllowed([subject]);
    try {
      await this.mfa.verifySecondFactor({ userId: principal.userId, code, ip: request.ip });
    } catch (error) {
      if (isDomainError(error) && error.code === ErrorCode.OTP_INVALID) {
        await this.throttle.recordFailure([subject]);
        await this.#audit('auth.step_up.failed', principal.userId, request.ip);
      }
      throw error;
    }
    await this.throttle.reset(subject);
    await this.#audit('auth.step_up.succeeded', principal.userId, request.ip);
    return true;
  }

  async #audit(action: string, userId: string, ip: string): Promise<void> {
    await this.audit.record({
      actorType: 'player',
      actorId: userId,
      action,
      targetType: 'user',
      targetId: userId,
      ip,
    });
  }
}

/**
 * Requires step-up on a route: a login under 5 minutes old plus a 2FA code in
 * `X-Step-Up-Code`. Use on adding a payout address, redeeming, changing email or phone, and
 * disabling 2FA.
 *
 * @returns A method decorator.
 */
export const RequireStepUp = (): MethodDecorator & ClassDecorator =>
  applyDecorators(UseGuards(StepUpGuard));

/**
 * For adding a second factor (TOTP or a passkey): a login under 5 minutes old, plus a 2FA code
 * when the player already has 2FA. Stops a stolen access token from planting its own factor.
 *
 * @returns A method decorator.
 */
export const RequireRecentAuth = (): MethodDecorator =>
  applyDecorators(SetMetadata(ALLOWS_NO_MFA, true), UseGuards(StepUpGuard));
