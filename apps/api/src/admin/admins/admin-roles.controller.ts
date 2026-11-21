import { Body, HttpCode, Inject, Param, Put, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { isAdminRole, type AdminRole } from '../admin-permissions.js';
import {
  AdminController,
  adminOf,
  AuditedInTransaction,
  RequirePermission,
} from '../http/admin-decorators.js';
import { AdminRolesService } from './admin-roles-service.js';

const idParams = z.object({ id: z.uuid() });
const rolesBody = z.object({
  roles: z.array(z.string().refine(isAdminRole, 'is not a role')).max(8),
});

/** Admin accounts (spec §13.1): role management is Super Admin only. */
@AdminController('admins')
export class AdminRolesController {
  constructor(@Inject(AdminRolesService) private readonly roles: AdminRolesService) {}

  /** Replaces an admin's roles. */
  @Put(':id/roles')
  @HttpCode(200)
  @RequirePermission('roles.manage')
  @AuditedInTransaction()
  async setRoles(
    @Param({ schema: idParams }) params: z.infer<typeof idParams>,
    @Body({ schema: rolesBody }) body: z.infer<typeof rolesBody>,
    @Req() request: FastifyRequest,
  ): Promise<{ roles: AdminRole[] }> {
    const roles = await this.roles.setRoles({
      actorId: adminOf(request).adminId,
      targetId: params.id,
      roles: body.roles.filter(isAdminRole),
      ip: request.ip,
    });
    return { roles };
  }
}
