import { Body, Controller, HttpCode, Inject, Post, Req, Res } from '@nestjs/common';
import { AuthError } from '@reef/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { OptionalAuth } from '../../auth/guards/public.decorator.js';
import { principalOf } from '../../http/principal.js';
import { RateLimit } from '../../http/rate-limit/rate-limit.decorator.js';
import { GATED_CONTEXTS, type BlockReason } from '../jurisdictions/jurisdiction-policy.js';
import { GeoService } from './geo-service.js';

const geoCheckBody = z.object({
  context: z.enum(GATED_CONTEXTS),
  // Opaque vendor SDK payload; the dev stub ignores it.
  devicePayload: z.string().max(65_536).default(''),
});

/** `POST /v1/geo/check` response. */
export type GeoCheckResponse =
  | {
      readonly result: 'allowed';
      readonly stateCode: string;
      readonly geoToken: string;
      readonly expiresAt: string;
    }
  | { readonly result: 'blocked'; readonly stateCode: string | null; readonly reason: BlockReason };

/** Location checks (spec §12: `POST /geo/check`). */
@Controller('geo')
export class GeoController {
  constructor(@Inject(GeoService) private readonly geo: GeoService) {}

  /**
   * Checks the device's location for an action and, when allowed, returns a geo token for it.
   * Signup checks are anonymous; every other action needs a signed-in player, and the token is
   * bound to them.
   */
  @Post('check')
  @HttpCode(200)
  @OptionalAuth()
  @RateLimit({ limit: 30, windowSeconds: 60 })
  async check(
    @Body({ schema: geoCheckBody }) body: z.infer<typeof geoCheckBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<GeoCheckResponse> {
    const principal = principalOf(request);
    if (body.context !== 'signup' && principal === undefined) throw new AuthError();
    void reply.header('cache-control', 'no-store');
    const outcome = await this.geo.check({
      context: body.context,
      devicePayload: body.devicePayload,
      ip: request.ip,
      headers: request.headers,
      userId: body.context === 'signup' ? null : (principal?.userId ?? null),
    });
    return outcome.result === 'allowed'
      ? { ...outcome, expiresAt: outcome.expiresAt.toISOString() }
      : outcome;
  }
}
