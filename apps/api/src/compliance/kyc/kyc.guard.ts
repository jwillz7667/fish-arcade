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
import { AuthError, ComplianceBlockedError, ErrorCode } from '@reef/errors';
import type { FastifyRequest } from 'fastify';

import { principalOf } from '../../http/principal.js';
import type { KycLevel } from './kyc-status.js';
import { KycService } from './kyc-service.js';

const REQUIREMENT = 'reef:kyc-requirement';

interface KycRequirement {
  readonly level: KycLevel;
  readonly isRedemption: boolean;
}

/**
 * Checks a signed-in player's KYC before the route runs (playbook Step 8). For redemption it
 * also refuses accounts with an active redemption hold, such as after a sanctions or PEP hit.
 */
@Injectable()
export class KycGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(KycService) private readonly kyc: KycService,
  ) {}

  /**
   * @param context Current request; the auth guard has already set the principal.
   * @returns True when the requirement is met.
   * @throws AuthError when nobody is signed in.
   * @throws ComplianceBlockedError KYC_REQUIRED or REDEMPTION_SUSPENDED.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const requirement = this.reflector.get<KycRequirement | undefined>(
      REQUIREMENT,
      context.getHandler(),
    );
    if (requirement === undefined) throw new Error('KycGuard used without a KYC decorator');
    const principal = principalOf(context.switchToHttp().getRequest<FastifyRequest>());
    if (principal === undefined) throw new AuthError();
    if (requirement.isRedemption && (await this.kyc.isRedemptionHeld(principal.userId))) {
      throw new ComplianceBlockedError({ code: ErrorCode.REDEMPTION_SUSPENDED });
    }
    if (!(await this.kyc.isVerified(principal.userId, requirement.level))) {
      throw new ComplianceBlockedError({ code: ErrorCode.KYC_REQUIRED });
    }
    return true;
  }
}

/**
 * Requires a passed KYC check at `level` (a full check satisfies light) and no sanctions hit.
 *
 * @param level Level the route needs.
 * @returns A method decorator.
 */
export const RequireKyc = (level: KycLevel): MethodDecorator =>
  applyDecorators(SetMetadata(REQUIREMENT, { level, isRedemption: false }), UseGuards(KycGuard));

/**
 * For redemption and payout-address routes (Steps 14 and 15): full KYC passed (spec §5.1) and
 * no redemption hold.
 *
 * @returns A method decorator.
 */
export const RequireRedemptionEligibility = (): MethodDecorator =>
  applyDecorators(
    SetMetadata(REQUIREMENT, { level: 'full', isRedemption: true }),
    UseGuards(KycGuard),
  );
