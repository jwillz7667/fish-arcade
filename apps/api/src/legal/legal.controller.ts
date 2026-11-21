import { Controller, Get, Inject } from '@nestjs/common';
import type { Pool } from 'pg';

import { CLOCK, PG_POOL } from '../app/tokens.js';
import { Public } from '../auth/guards/public.decorator.js';
import type { Clock } from '../shared/clock.js';
import { currentSignupDocuments } from './legal-documents.js';

/** Legal documents the client shows before signup (spec §5.1). */
@Controller('legal')
export class LegalController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  /**
   * The versions in force. The client shows them and sends their IDs back with signup as
   * `acceptedDocumentIds`.
   */
  @Get('current')
  @Public()
  async current(): Promise<{
    documents: { id: string; docType: string; version: string; url: string; effectiveAt: string }[];
  }> {
    const documents = await currentSignupDocuments(this.pool, this.clock.now());
    return {
      documents: documents.map((doc) => ({ ...doc, effectiveAt: doc.effectiveAt.toISOString() })),
    };
  }
}
