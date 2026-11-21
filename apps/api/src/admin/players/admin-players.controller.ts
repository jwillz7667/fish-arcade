import { Get, Inject, Param, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';

import { AdminController, adminOf, RequirePermission } from '../http/admin-decorators.js';
import { AdminPlayerService, type AdminPlayerView } from './admin-player-service.js';

const idParams = z.object({ id: z.uuid() });

/** Player lookup for the back office (spec §13.2). */
@AdminController('players')
export class AdminPlayersController {
  constructor(@Inject(AdminPlayerService) private readonly players: AdminPlayerService) {}

  /** One player, with PII masked unless the admin has `players.read_pii`. */
  @Get(':id')
  @RequirePermission('players.read')
  async get(
    @Param({ schema: idParams }) params: z.infer<typeof idParams>,
    @Req() request: FastifyRequest,
  ): Promise<AdminPlayerView> {
    return this.players.get(params.id, adminOf(request).permissions.has('players.read_pii'));
  }
}
