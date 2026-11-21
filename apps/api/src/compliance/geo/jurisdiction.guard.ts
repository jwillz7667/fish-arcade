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
import { ComplianceBlockedError, ErrorCode } from '@reef/errors';
import type { FastifyRequest } from 'fastify';

import { AUTH_KEYS, CLOCK } from '../../app/tokens.js';
import type { AuthKeys } from '../../auth/crypto/auth-keys.js';
import { principalOf } from '../../http/principal.js';
import type { Clock } from '../../shared/clock.js';
import {
  decideJurisdiction,
  type GatedContext,
  type JurisdictionRule,
} from '../jurisdictions/jurisdiction-policy.js';
import { JurisdictionService } from '../jurisdictions/jurisdiction-service.js';
import { verifyGeoToken } from './geo-token.js';

/** The location and rule a gated request passed with. */
export interface RequestJurisdiction {
  readonly stateCode: string;
  readonly rule: JurisdictionRule;
  readonly geoCheckId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    jurisdiction?: RequestJurisdiction;
  }
}

const REQUIRED_CONTEXT = 'reef:jurisdiction-context';

/**
 * Enforces the jurisdiction gate (playbook Step 7). The request must carry an `X-Geo-Token` from
 * an allowed `POST /v1/geo/check` for the same action, user, and IP, issued within the last 10
 * minutes. The state's rule is then re-read, so a scheduled change applies even to a token
 * issued before it. Fails closed: Redis or Postgres errors propagate as 503.
 */
@Injectable()
export class JurisdictionGuard implements CanActivate {
  constructor(
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(JurisdictionService) private readonly jurisdictions: JurisdictionService,
    @Inject(AUTH_KEYS) private readonly keys: AuthKeys,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * @param context Current request; the auth guard has already run.
   * @returns True when the location check is valid and the state allows the action.
   * @throws ComplianceBlockedError GEO_CHECK_REQUIRED when the token is missing, forged,
   *   expired, or bound to another action, user, or IP.
   * @throws ComplianceBlockedError COMPLIANCE_BLOCKED when the state does not allow the action.
   */
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.get<GatedContext | undefined>(
      REQUIRED_CONTEXT,
      context.getHandler(),
    );
    if (required === undefined)
      throw new Error('JurisdictionGuard used without @RequireJurisdiction');
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const header = request.headers['x-geo-token'];
    const claims =
      typeof header === 'string' ? verifyGeoToken(this.keys.hmacKey, header) : undefined;
    const isBound =
      claims !== undefined &&
      claims.context === required &&
      claims.expiresAt > this.clock.now() &&
      claims.ip === request.ip &&
      claims.userId === (principalOf(request)?.userId ?? null);
    if (!isBound) throw new ComplianceBlockedError({ code: ErrorCode.GEO_CHECK_REQUIRED });

    const rule = await this.jurisdictions.ruleFor(claims.stateCode);
    const decision = decideJurisdiction(required, rule);
    if (!decision.isAllowed || rule === undefined) {
      throw new ComplianceBlockedError({
        message: `Jurisdiction gate: ${decision.isAllowed ? 'no rule' : decision.reason}`,
      });
    }
    request.jurisdiction = { stateCode: claims.stateCode, rule, geoCheckId: claims.checkId };
    return true;
  }
}

/**
 * Gates a route on location (playbook Step 7): `@RequireJurisdiction('purchase')`. The client
 * first calls `POST /v1/geo/check` for that action and sends the returned token as
 * `X-Geo-Token`.
 *
 * @param context The action the route performs.
 * @returns A method decorator.
 */
export const RequireJurisdiction = (context: GatedContext): MethodDecorator =>
  applyDecorators(SetMetadata(REQUIRED_CONTEXT, context), UseGuards(JurisdictionGuard));
