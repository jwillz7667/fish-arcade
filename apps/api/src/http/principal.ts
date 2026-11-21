import type { FastifyRequest } from 'fastify';

/** The authenticated caller, set by the global auth guard (playbook Step 6). */
export interface Principal {
  readonly userId: string;
  readonly sessionId: string;
  /** Time of the primary login behind this session. */
  readonly authTime: Date;
  /** Authentication methods used at login (RFC 8176 values). */
  readonly amr: readonly string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    principal?: Principal;
  }
}

/**
 * @param request Current request.
 * @returns The authenticated caller, if any.
 */
export function principalOf(request: FastifyRequest): Principal | undefined {
  return request.principal;
}
