import {
  Body,
  Controller,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  type RawBodyRequest,
} from '@nestjs/common';
import { AuthError, ValidationError } from '@reef/errors';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';

import { Public } from '../../auth/guards/public.decorator.js';
import { principalOf } from '../../http/principal.js';
import { RateLimit } from '../../http/rate-limit/rate-limit.decorator.js';
import { KycService, type KycWebhookOutcome } from './kyc-service.js';

const sessionBody = z.object({ level: z.enum(['light', 'full']) });

/** KYC sessions (spec §12: `POST /kyc/session`). */
@Controller('kyc')
export class KycController {
  constructor(@Inject(KycService) private readonly kyc: KycService) {}

  /** Starts a light or full check and returns the token for the vendor SDK. */
  @Post('session')
  @HttpCode(201)
  @RateLimit({ limit: 10, windowSeconds: 3_600, by: 'principal' })
  async startSession(
    @Body({ schema: sessionBody }) body: z.infer<typeof sessionBody>,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<{ checkId: string; sdkToken: string; expiresAt: string }> {
    const principal = principalOf(request);
    if (principal === undefined) throw new AuthError();
    void reply.header('cache-control', 'no-store');
    const session = await this.kyc.startSession({
      userId: principal.userId,
      level: body.level,
      ip: request.ip,
    });
    return { ...session, expiresAt: session.expiresAt.toISOString() };
  }
}

/** Vendor callbacks (spec §12: `POST /webhooks/kyc`). Authenticated by signature, not session. */
@Controller('webhooks')
@Public()
export class KycWebhookController {
  constructor(@Inject(KycService) private readonly kyc: KycService) {}

  /** Verifies, dedupes, and applies a KYC status change. */
  @Post('kyc')
  @HttpCode(200)
  async receive(
    @Req() request: RawBodyRequest<FastifyRequest>,
  ): Promise<{ status: KycWebhookOutcome }> {
    const { rawBody } = request;
    if (rawBody === undefined) {
      throw new ValidationError({ issues: [{ path: '', message: 'expected a JSON body' }] });
    }
    return {
      status: await this.kyc.handleWebhook({ headers: request.headers, rawBody, ip: request.ip }),
    };
  }
}
