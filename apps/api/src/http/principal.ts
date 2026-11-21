import type { FastifyRequest } from 'fastify';

/** The authenticated caller. Set by the auth guard (playbook Step 6). */
export interface Principal {
  readonly userId: string;
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
