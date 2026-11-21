import { SetMetadata } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';

/** Metadata key for {@link MoneyRoute}. */
export const MONEY_ROUTE = 'reef:money-route';

declare module 'fastify' {
  interface FastifyRequest {
    /** `{actor}:{Idempotency-Key}`, set by the idempotency interceptor on money routes. */
    moneyRouteKey?: string;
  }
}

/**
 * Marks a route that moves money. CLAUDE.md: every money-moving operation carries an
 * idempotency key. The route then requires an `Idempotency-Key` header and an authenticated
 * player or admin. A retry with the same key replays the stored response; the handler must
 * also pass {@link moneyRouteKeyOf} (or a key derived from it) to `postJournal`, which is what
 * guarantees money moves once even if the handler runs twice.
 *
 * @returns A method decorator.
 */
export const MoneyRoute = (): MethodDecorator => SetMetadata(MONEY_ROUTE, true);

/**
 * @param request Current request on a `@MoneyRoute`.
 * @returns The caller-scoped idempotency key, for deriving ledger idempotency keys.
 * @throws Error when called outside a `@MoneyRoute` (a programming error).
 */
export function moneyRouteKeyOf(request: FastifyRequest): string {
  if (request.moneyRouteKey === undefined) {
    throw new Error('moneyRouteKeyOf used on a route without @MoneyRoute');
  }
  return request.moneyRouteKey;
}
