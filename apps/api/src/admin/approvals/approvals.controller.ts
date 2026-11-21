import { Body, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import {
  AdminController,
  adminOf,
  AuditedInTransaction,
  RequirePermission,
} from '../http/admin-decorators.js';
import { ApprovalsService, type ApprovalView } from './approvals-service.js';

const requestBody = z.object({ action: z.string().min(1).max(64), payload: z.unknown() });
const idParams = z.object({ id: z.uuid() });
const listQuery = z.object({
  status: z.enum(['pending', 'approved', 'rejected', 'expired', 'executed']).optional(),
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/**
 * Four-eyes approvals (playbook Step 9). Route permission is `approvals.read`; each action's
 * own request and approve permissions are checked by the service.
 */
@AdminController('approvals')
export class ApprovalsController {
  constructor(@Inject(ApprovalsService) private readonly approvals: ApprovalsService) {}

  /** Requests an action that needs a second admin. */
  @Post()
  @HttpCode(201)
  @RequirePermission('approvals.read')
  @AuditedInTransaction()
  async request(
    @Body({ schema: requestBody }) body: z.infer<typeof requestBody>,
    @Req() request: FastifyRequest,
  ): Promise<ApprovalView> {
    return this.approvals.request(adminOf(request), { ...body, ip: request.ip });
  }

  /** Approves and executes, atomically. */
  @Post(':id/approve')
  @HttpCode(200)
  @RequirePermission('approvals.read')
  @AuditedInTransaction()
  async approve(
    @Param({ schema: idParams }) params: z.infer<typeof idParams>,
    @Req() request: FastifyRequest,
  ): Promise<ApprovalView> {
    return this.approvals.approve(adminOf(request), { approvalId: params.id, ip: request.ip });
  }

  /** Rejects, or withdraws one's own request. */
  @Post(':id/reject')
  @HttpCode(200)
  @RequirePermission('approvals.read')
  @AuditedInTransaction()
  async reject(
    @Param({ schema: idParams }) params: z.infer<typeof idParams>,
    @Req() request: FastifyRequest,
  ): Promise<ApprovalView> {
    return this.approvals.reject(adminOf(request), { approvalId: params.id, ip: request.ip });
  }

  /** Lists approvals, newest first. */
  @Get()
  @RequirePermission('approvals.read')
  async list(
    @Query({ schema: listQuery }) query: z.infer<typeof listQuery>,
  ): Promise<ApprovalView[]> {
    return this.approvals.list({
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.before === undefined ? {} : { before: new Date(query.before) }),
      limit: query.limit,
    });
  }
}
