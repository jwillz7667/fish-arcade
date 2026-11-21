import { Body, Get, HttpCode, Inject, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { JurisdictionService, type JurisdictionRule } from '../../compliance/index.js';
import {
  AdminController,
  adminOf,
  AuditedInTransaction,
  RequirePermission,
} from '../http/admin-decorators.js';

const scheduleBody = z.object({
  stateCode: z.string().regex(/^[A-Z]{2}$/),
  effectiveFrom: z.iso.datetime(),
  mode: z.enum(['S', 'P', 'X']),
  minAge: z.number().int().min(18).max(25),
  scRedemptionEnabled: z.boolean(),
  fishGamesEnabled: z.boolean(),
  legalMemoRef: z.string().trim().min(3).max(200),
});

/** Jurisdiction table (spec §4.1, §13.2): Compliance only. */
@AdminController('jurisdictions')
export class AdminJurisdictionsController {
  constructor(@Inject(JurisdictionService) private readonly jurisdictions: JurisdictionService) {}

  /** Every state's rule in force now. */
  @Get()
  @RequirePermission('jurisdictions.read')
  async list(): Promise<JurisdictionRule[]> {
    return this.jurisdictions.listCurrent();
  }

  /** Schedules a change. It takes effect at `effectiveFrom`, which must be in the future. */
  @Post()
  @HttpCode(201)
  @RequirePermission('jurisdictions.write')
  @AuditedInTransaction()
  async schedule(
    @Body({ schema: scheduleBody }) body: z.infer<typeof scheduleBody>,
    @Req() request: FastifyRequest,
  ): Promise<{ status: 'scheduled' }> {
    await this.jurisdictions.schedule(
      { ...body, effectiveFrom: new Date(body.effectiveFrom) },
      { adminId: adminOf(request).adminId, ip: request.ip },
    );
    return { status: 'scheduled' };
  }
}
